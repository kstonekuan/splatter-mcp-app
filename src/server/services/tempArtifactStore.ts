import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { StoredArtifact } from "../types/splat";

const DEFAULT_ARTIFACT_DIRECTORY = ".mcp-use/artifacts";
const DEFAULT_ARTIFACT_TTL_SECONDS = 3600;
const CLEANUP_INTERVAL_MILLISECONDS = 60_000;
const ARTIFACT_METADATA_FILE_SUFFIX = ".meta.json";

function isMissingFileSystemEntryError(errorValue: unknown): boolean {
	if (!(errorValue instanceof Error)) {
		return false;
	}
	return "code" in errorValue && errorValue.code === "ENOENT";
}

function parsePositiveIntegerEnvironmentVariable(
	environmentVariableValue: string | undefined,
	fallbackValue: number,
): number {
	const parsedValue = Number.parseInt(environmentVariableValue ?? "", 10);
	if (Number.isNaN(parsedValue) || parsedValue <= 0) {
		return fallbackValue;
	}
	return parsedValue;
}

export class TemporaryArtifactStore {
	private readonly artifactDirectoryPath: string;
	private readonly artifactTimeToLiveMilliseconds: number;
	private readonly artifactRegistryById = new Map<string, StoredArtifact>();
	private cleanupTimer: NodeJS.Timeout | null = null;

	public constructor() {
		const configuredArtifactDirectoryPath =
			process.env["SPLAT_ARTIFACT_DIR"] ?? DEFAULT_ARTIFACT_DIRECTORY;
		this.artifactDirectoryPath = isAbsolute(configuredArtifactDirectoryPath)
			? configuredArtifactDirectoryPath
			: resolve(process.cwd(), configuredArtifactDirectoryPath);
		this.artifactTimeToLiveMilliseconds =
			parsePositiveIntegerEnvironmentVariable(
				process.env["SPLAT_ARTIFACT_TTL_SECONDS"],
				DEFAULT_ARTIFACT_TTL_SECONDS,
			) * 1000;
	}

	public async initialize(): Promise<void> {
		await mkdir(this.artifactDirectoryPath, { recursive: true });
		await this.hydrateArtifactRegistryFromDisk();
		this.startCleanupTimer();
	}

	public async createArtifactFromBytes(
		artifactBytes: Uint8Array,
		fileExtension: string,
		mimeType: string,
		displayName: string,
	): Promise<StoredArtifact> {
		await mkdir(this.artifactDirectoryPath, { recursive: true });

		const artifactIdentifier = randomUUID();
		const normalizedFileExtension = fileExtension.startsWith(".")
			? fileExtension
			: `.${fileExtension}`;
		const artifactFilePath = join(
			this.artifactDirectoryPath,
			`${artifactIdentifier}${normalizedFileExtension}`,
		);
		await writeFile(artifactFilePath, artifactBytes);

		const currentTimeInMilliseconds = Date.now();
		const storedArtifact: StoredArtifact = {
			artifactId: artifactIdentifier,
			absoluteFilePath: artifactFilePath,
			expiresAtUnixMs:
				currentTimeInMilliseconds + this.artifactTimeToLiveMilliseconds,
			mimeType,
			fileSizeBytes: artifactBytes.byteLength,
			displayName,
		};

		this.artifactRegistryById.set(artifactIdentifier, storedArtifact);
		await this.writeArtifactMetadataToDisk(storedArtifact);
		return storedArtifact;
	}

	public async getArtifactIfAvailable(
		artifactIdentifier: string,
	): Promise<StoredArtifact | null> {
		let storedArtifact: StoredArtifact | null | undefined =
			this.artifactRegistryById.get(artifactIdentifier);
		if (!storedArtifact) {
			storedArtifact =
				await this.readArtifactMetadataFromDisk(artifactIdentifier);
		}
		if (!storedArtifact) {
			return null;
		}
		this.artifactRegistryById.set(artifactIdentifier, storedArtifact);

		if (storedArtifact.expiresAtUnixMs <= Date.now()) {
			await this.deleteArtifact(storedArtifact.artifactId);
			return null;
		}

		try {
			await stat(storedArtifact.absoluteFilePath);
			return storedArtifact;
		} catch {
			this.artifactRegistryById.delete(storedArtifact.artifactId);
			return null;
		}
	}

	public async readArtifactBytes(
		artifactIdentifier: string,
	): Promise<Uint8Array | null> {
		const storedArtifact =
			await this.getArtifactIfAvailable(artifactIdentifier);
		if (!storedArtifact) {
			return null;
		}

		try {
			const artifactBuffer = await readFile(storedArtifact.absoluteFilePath);
			return new Uint8Array(artifactBuffer);
		} catch (readArtifactErrorValue) {
			if (isMissingFileSystemEntryError(readArtifactErrorValue)) {
				this.artifactRegistryById.delete(artifactIdentifier);
				return null;
			}
			throw readArtifactErrorValue;
		}
	}

	public async deleteArtifact(artifactIdentifier: string): Promise<void> {
		const storedArtifact =
			this.artifactRegistryById.get(artifactIdentifier) ??
			(await this.readArtifactMetadataFromDisk(artifactIdentifier));
		this.artifactRegistryById.delete(artifactIdentifier);
		if (storedArtifact) {
			await rm(storedArtifact.absoluteFilePath, { force: true });
		}
		await rm(this.buildMetadataFilePath(artifactIdentifier), { force: true });
	}

	public async deleteExpiredArtifacts(): Promise<void> {
		const artifactIdentifiersToDelete = new Set<string>();
		const currentTimeInMilliseconds = Date.now();

		for (const [artifactIdentifier, storedArtifact] of this
			.artifactRegistryById) {
			if (storedArtifact.expiresAtUnixMs <= currentTimeInMilliseconds) {
				artifactIdentifiersToDelete.add(artifactIdentifier);
			}
		}

		const filesInArtifactDirectory =
			await this.readArtifactDirectoryFileNames();
		for (const fileName of filesInArtifactDirectory) {
			if (!fileName.endsWith(ARTIFACT_METADATA_FILE_SUFFIX)) {
				continue;
			}
			const artifactIdentifier = fileName.slice(
				0,
				-ARTIFACT_METADATA_FILE_SUFFIX.length,
			);
			if (artifactIdentifiersToDelete.has(artifactIdentifier)) {
				continue;
			}
			const diskMetadata =
				await this.readArtifactMetadataFromDisk(artifactIdentifier);
			if (
				diskMetadata &&
				diskMetadata.expiresAtUnixMs <= currentTimeInMilliseconds
			) {
				artifactIdentifiersToDelete.add(artifactIdentifier);
			}
		}

		for (const artifactIdentifier of artifactIdentifiersToDelete) {
			await this.deleteArtifact(artifactIdentifier);
		}
	}

	public buildPublicArtifactUrl(artifactIdentifier: string): string {
		const configuredBaseUrl =
			process.env["MCP_URL"] ?? process.env["SPLAT_PUBLIC_BASE_URL"];
		const relativeArtifactPath = `/artifacts/${artifactIdentifier}`;
		if (!configuredBaseUrl) {
			return relativeArtifactPath;
		}
		return new URL(relativeArtifactPath, configuredBaseUrl).toString();
	}

	private startCleanupTimer(): void {
		if (this.cleanupTimer) {
			return;
		}

		this.cleanupTimer = setInterval(() => {
			void this.deleteExpiredArtifacts().catch((cleanupErrorValue) => {
				console.error("[TemporaryArtifactStore] cleanup failed", {
					cleanupErrorMessage:
						cleanupErrorValue instanceof Error
							? cleanupErrorValue.message
							: String(cleanupErrorValue),
				});
			});
		}, CLEANUP_INTERVAL_MILLISECONDS);
		this.cleanupTimer.unref();
	}

	private async readArtifactDirectoryFileNames(): Promise<string[]> {
		try {
			return await readdir(this.artifactDirectoryPath);
		} catch (readDirectoryErrorValue) {
			if (!isMissingFileSystemEntryError(readDirectoryErrorValue)) {
				throw readDirectoryErrorValue;
			}
			await mkdir(this.artifactDirectoryPath, { recursive: true });
			return [];
		}
	}

	private buildMetadataFilePath(artifactIdentifier: string): string {
		return join(
			this.artifactDirectoryPath,
			`${artifactIdentifier}${ARTIFACT_METADATA_FILE_SUFFIX}`,
		);
	}

	private async writeArtifactMetadataToDisk(
		storedArtifact: StoredArtifact,
	): Promise<void> {
		await writeFile(
			this.buildMetadataFilePath(storedArtifact.artifactId),
			JSON.stringify(storedArtifact),
			"utf-8",
		);
	}

	private async readArtifactMetadataFromDisk(
		artifactIdentifier: string,
	): Promise<StoredArtifact | null> {
		try {
			const metadataJsonText = await readFile(
				this.buildMetadataFilePath(artifactIdentifier),
				"utf-8",
			);
			const parsedMetadataValue = JSON.parse(metadataJsonText) as Record<
				string,
				unknown
			> | null;
			if (!parsedMetadataValue || typeof parsedMetadataValue !== "object") {
				return null;
			}

			const absoluteFilePathValue = parsedMetadataValue["absoluteFilePath"];
			const expiresAtUnixMsValue = parsedMetadataValue["expiresAtUnixMs"];
			const mimeTypeValue = parsedMetadataValue["mimeType"];
			const fileSizeBytesValue = parsedMetadataValue["fileSizeBytes"];
			const displayNameValue = parsedMetadataValue["displayName"];
			if (
				typeof absoluteFilePathValue !== "string" ||
				typeof expiresAtUnixMsValue !== "number" ||
				typeof mimeTypeValue !== "string" ||
				typeof fileSizeBytesValue !== "number" ||
				typeof displayNameValue !== "string"
			) {
				return null;
			}

			return {
				artifactId: artifactIdentifier,
				absoluteFilePath: absoluteFilePathValue,
				expiresAtUnixMs: expiresAtUnixMsValue,
				mimeType: mimeTypeValue,
				fileSizeBytes: fileSizeBytesValue,
				displayName: displayNameValue,
			};
		} catch {
			return null;
		}
	}

	private async hydrateArtifactRegistryFromDisk(): Promise<void> {
		const filesInArtifactDirectory =
			await this.readArtifactDirectoryFileNames();
		for (const fileName of filesInArtifactDirectory) {
			if (!fileName.endsWith(ARTIFACT_METADATA_FILE_SUFFIX)) {
				continue;
			}

			const artifactIdentifier = fileName.slice(
				0,
				-ARTIFACT_METADATA_FILE_SUFFIX.length,
			);
			const diskMetadata =
				await this.readArtifactMetadataFromDisk(artifactIdentifier);
			if (!diskMetadata) {
				await rm(join(this.artifactDirectoryPath, fileName), { force: true });
				continue;
			}

			if (diskMetadata.expiresAtUnixMs <= Date.now()) {
				await this.deleteArtifact(artifactIdentifier);
				continue;
			}

			try {
				await stat(diskMetadata.absoluteFilePath);
				this.artifactRegistryById.set(artifactIdentifier, diskMetadata);
			} catch {
				await this.deleteArtifact(artifactIdentifier);
			}
		}
	}
}

export const temporaryArtifactStore = new TemporaryArtifactStore();
