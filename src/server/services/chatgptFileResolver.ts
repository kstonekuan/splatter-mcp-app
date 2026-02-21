import { basename } from "node:path";
import type {
	AllowedSplatSourceType,
	ChatGptFileReference,
	GenerateSplatFromImageInput,
	ResolvedInputBytes,
	ViewPlySplatInput,
} from "../types/splat";
import { validateLikelyGaussianSplatPly } from "./plySplatValidation";

const DEFAULT_MAXIMUM_PLY_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

function parseByteLimit(
	environmentVariableName: string,
	fallbackValue: number,
): number {
	const parsedEnvironmentVariableValue = Number.parseInt(
		process.env[environmentVariableName] ?? "",
		10,
	);
	if (
		Number.isNaN(parsedEnvironmentVariableValue) ||
		parsedEnvironmentVariableValue <= 0
	) {
		return fallbackValue;
	}
	return parsedEnvironmentVariableValue;
}

async function downloadBytesWithLimit(
	resolvedSourceUrl: string,
	maximumAllowedBytes: number,
): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
	const response = await fetch(resolvedSourceUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to download source bytes. Received HTTP ${response.status}.`,
		);
	}

	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader) {
		const parsedContentLength = Number.parseInt(contentLengthHeader, 10);
		if (
			!Number.isNaN(parsedContentLength) &&
			parsedContentLength > maximumAllowedBytes
		) {
			throw new Error(
				`Source file exceeds maximum allowed size of ${maximumAllowedBytes} bytes.`,
			);
		}
	}

	const arrayBuffer = await response.arrayBuffer();
	const downloadedBytes = new Uint8Array(arrayBuffer);
	if (downloadedBytes.byteLength > maximumAllowedBytes) {
		throw new Error(
			`Source file exceeds maximum allowed size of ${maximumAllowedBytes} bytes.`,
		);
	}

	return {
		bytes: downloadedBytes,
		mimeType: response.headers.get("content-type"),
	};
}

function parseFileNameFromContentDispositionHeader(
	contentDispositionHeaderValue: string | null,
): string | undefined {
	if (!contentDispositionHeaderValue) {
		return undefined;
	}

	const fileNameStarMatchResult = contentDispositionHeaderValue.match(
		/filename\*=UTF-8''([^;]+)/i,
	);
	if (fileNameStarMatchResult?.[1]) {
		try {
			return decodeURIComponent(fileNameStarMatchResult[1]);
		} catch {
			return fileNameStarMatchResult[1];
		}
	}

	const fileNameMatchResult = contentDispositionHeaderValue.match(
		/filename="?([^";]+)"?/i,
	);
	return fileNameMatchResult?.[1];
}

function isOpenAiFileIdentifier(sourceReferenceValue: string): boolean {
	return /^file-[A-Za-z0-9_-]+$/.test(sourceReferenceValue);
}

async function fetchOpenAiFileMetadata(
	openAiApiBaseUrl: string,
	openAiApiKey: string,
	openAiFileIdentifier: string,
): Promise<{ filename: string } | null> {
	try {
		const metadataResponse = await fetch(
			`${openAiApiBaseUrl}/files/${encodeURIComponent(openAiFileIdentifier)}`,
			{
				headers: {
					authorization: `Bearer ${openAiApiKey}`,
				},
			},
		);
		if (!metadataResponse.ok) {
			return null;
		}

		const metadataPayload = (await metadataResponse.json()) as Record<
			string,
			unknown
		>;
		const resolvedFilename = metadataPayload["filename"];
		if (
			typeof resolvedFilename !== "string" ||
			resolvedFilename.trim() === ""
		) {
			return null;
		}
		return { filename: resolvedFilename };
	} catch {
		return null;
	}
}

async function downloadOpenAiFileIdentifierBytes(
	openAiFileIdentifier: string,
	maximumAllowedBytes: number,
): Promise<{
	bytes: Uint8Array;
	mimeType: string | null;
	filename: string | undefined;
}> {
	const openAiApiKey = process.env["OPENAI_API_KEY"]?.trim();
	if (!openAiApiKey) {
		throw new Error(
			"Received OpenAI file ID input but OPENAI_API_KEY is not configured on the server.",
		);
	}

	const openAiApiBaseUrl = (
		process.env["OPENAI_API_BASE_URL"] ?? DEFAULT_OPENAI_API_BASE_URL
	).replace(/\/$/, "");
	const metadataResult = await fetchOpenAiFileMetadata(
		openAiApiBaseUrl,
		openAiApiKey,
		openAiFileIdentifier,
	);

	const contentResponse = await fetch(
		`${openAiApiBaseUrl}/files/${encodeURIComponent(openAiFileIdentifier)}/content`,
		{
			headers: {
				authorization: `Bearer ${openAiApiKey}`,
			},
		},
	);
	if (!contentResponse.ok) {
		if (contentResponse.status === 404) {
			throw new Error(
				`OpenAI Files API returned 404 for ${openAiFileIdentifier}. This usually means the ChatGPT attachment file ID is not accessible to this server key. Ensure ChatGPT passes uploadReference.download_url via openai/fileParams, then reconnect the app and retry in a fresh chat.`,
			);
		}
		throw new Error(
			`OpenAI Files API download failed for ${openAiFileIdentifier} with HTTP ${contentResponse.status}.`,
		);
	}

	const downloadedArrayBuffer = await contentResponse.arrayBuffer();
	const downloadedBytes = new Uint8Array(downloadedArrayBuffer);
	if (downloadedBytes.byteLength > maximumAllowedBytes) {
		throw new Error(
			`Source file exceeds maximum allowed size of ${maximumAllowedBytes} bytes.`,
		);
	}

	const filenameFromContentDisposition =
		parseFileNameFromContentDispositionHeader(
			contentResponse.headers.get("content-disposition"),
		);
	return {
		bytes: downloadedBytes,
		mimeType: contentResponse.headers.get("content-type"),
		filename:
			filenameFromContentDisposition ??
			metadataResult?.filename ??
			`${openAiFileIdentifier}.bin`,
	};
}

function decodeDataUrlSource(
	dataUrlSource: string,
	maximumAllowedBytes: number,
): { bytes: Uint8Array; mimeType: string | null } {
	const dataUrlMatchResult = dataUrlSource.match(
		/^data:([^;,]+)?;base64,(.+)$/,
	);
	if (!dataUrlMatchResult) {
		throw new Error(
			"Unsupported data URL format. Expected base64-encoded data URL.",
		);
	}

	const mimeTypeFromDataUrl = dataUrlMatchResult[1] ?? null;
	const base64Payload = dataUrlMatchResult[2] ?? "";
	const decodedBuffer = Buffer.from(base64Payload, "base64");
	if (decodedBuffer.byteLength > maximumAllowedBytes) {
		throw new Error(
			`Source file exceeds maximum allowed size of ${maximumAllowedBytes} bytes.`,
		);
	}

	return {
		bytes: new Uint8Array(decodedBuffer),
		mimeType: mimeTypeFromDataUrl,
	};
}

function normalizeInputSourceUrl(
	sourceType: AllowedSplatSourceType,
	uploadReference: string | ChatGptFileReference | undefined,
	directUrl: string | undefined,
): string {
	if (sourceType === "chatgpt_upload") {
		if (!uploadReference) {
			throw new Error(
				"uploadReference is required for chatgpt_upload sourceType.",
			);
		}

		if (typeof uploadReference === "string") {
			return uploadReference;
		}

		const uploadReferenceRecord = uploadReference as Record<string, unknown>;
		const resolvedDownloadUrlValue =
			uploadReferenceRecord["download_url"] ?? uploadReferenceRecord["url"];
		const resolvedDownloadUrl =
			typeof resolvedDownloadUrlValue === "string"
				? resolvedDownloadUrlValue.trim()
				: "";
		if (resolvedDownloadUrl.length > 0) {
			return resolvedDownloadUrl;
		}

		const resolvedFileIdentifierValue = uploadReferenceRecord["file_id"];
		const resolvedFileIdentifier =
			typeof resolvedFileIdentifierValue === "string"
				? resolvedFileIdentifierValue.trim()
				: "";
		if (resolvedFileIdentifier.length > 0) {
			throw new Error(
				"uploadReference.file_id was provided without uploadReference.download_url. Reattach the file so ChatGPT provides a downloadable URL.",
			);
		}

		throw new Error(
			"uploadReference object is missing both download_url and file_id.",
		);
	}

	if (!directUrl) {
		throw new Error("A direct URL is required when sourceType is url.");
	}
	return directUrl;
}

function deriveFilenameFromSourceUrl(
	resolvedSourceUrl: string,
	fallbackFileName: string,
): string {
	if (resolvedSourceUrl.startsWith("data:")) {
		return fallbackFileName;
	}

	try {
		const parsedUrl = new URL(resolvedSourceUrl);
		const filenameFromPath = basename(parsedUrl.pathname);
		return filenameFromPath.length > 0 ? filenameFromPath : fallbackFileName;
	} catch {
		return fallbackFileName;
	}
}

function validatePlyBytes(plyBytes: Uint8Array): void {
	validateLikelyGaussianSplatPly(plyBytes);
}

function validateImageMimeType(detectedMimeType: string | null): void {
	if (!detectedMimeType) {
		return;
	}

	const mimeTypeWithoutCharset = detectedMimeType.split(";")[0]?.trim() ?? "";
	if (!mimeTypeWithoutCharset.startsWith("image/")) {
		throw new Error(
			`Input source must be an image. Detected MIME type was '${mimeTypeWithoutCharset}'.`,
		);
	}
}

function assertSourceReferenceIsRemotelyFetchable(
	resolvedSourceUrl: string,
): void {
	const normalizedSourceUrl = resolvedSourceUrl.trim().toLowerCase();
	const isChatGptSandboxPath =
		normalizedSourceUrl.startsWith("/mnt/data/") ||
		normalizedSourceUrl.startsWith("sandbox:/mnt/data/") ||
		normalizedSourceUrl.startsWith("file:///mnt/data/");
	if (isChatGptSandboxPath) {
		throw new Error(
			"Received a local ChatGPT sandbox path (/mnt/data/...), which is not reachable by this MCP server. Use a ChatGPT attachment reference that includes download_url.",
		);
	}
}

async function resolveInputSourceBytes(
	resolvedSourceReference: string,
	maximumAllowedBytes: number,
): Promise<{
	bytes: Uint8Array;
	mimeType: string | null;
	filename: string | undefined;
}> {
	if (resolvedSourceReference.startsWith("data:")) {
		const decodedPayload = decodeDataUrlSource(
			resolvedSourceReference,
			maximumAllowedBytes,
		);
		return {
			bytes: decodedPayload.bytes,
			mimeType: decodedPayload.mimeType,
			filename: undefined,
		};
	}

	if (isOpenAiFileIdentifier(resolvedSourceReference)) {
		return downloadOpenAiFileIdentifierBytes(
			resolvedSourceReference,
			maximumAllowedBytes,
		);
	}

	const downloadedPayload = await downloadBytesWithLimit(
		resolvedSourceReference,
		maximumAllowedBytes,
	);
	return {
		bytes: downloadedPayload.bytes,
		mimeType: downloadedPayload.mimeType,
		filename: undefined,
	};
}

export async function resolvePlyInputBytes(
	inputValue: ViewPlySplatInput,
): Promise<ResolvedInputBytes> {
	const maximumAllowedPlyBytes = parseByteLimit(
		"SPLAT_MAX_PLY_BYTES",
		DEFAULT_MAXIMUM_PLY_BYTES,
	);
	const resolvedSourceUrl = normalizeInputSourceUrl(
		inputValue.sourceType,
		inputValue.uploadReference,
		inputValue.plyUrl,
	);
	assertSourceReferenceIsRemotelyFetchable(resolvedSourceUrl);

	const downloadedPayload = await resolveInputSourceBytes(
		resolvedSourceUrl,
		maximumAllowedPlyBytes,
	);

	validatePlyBytes(downloadedPayload.bytes);

	const resolvedFilename =
		downloadedPayload.filename ??
		deriveFilenameFromSourceUrl(resolvedSourceUrl, "uploaded.ply");
	return {
		bytes: downloadedPayload.bytes,
		resolvedFilename,
		resolvedMimeType: downloadedPayload.mimeType,
		resolvedSourceUrl,
	};
}

export async function resolveImageInputBytes(
	inputValue: GenerateSplatFromImageInput,
): Promise<ResolvedInputBytes> {
	const maximumAllowedImageBytes = parseByteLimit(
		"SPLAT_MAX_IMAGE_BYTES",
		DEFAULT_MAXIMUM_IMAGE_BYTES,
	);
	const resolvedSourceUrl = normalizeInputSourceUrl(
		inputValue.sourceType,
		inputValue.uploadReference,
		inputValue.imageUrl,
	);
	assertSourceReferenceIsRemotelyFetchable(resolvedSourceUrl);

	const downloadedPayload = await resolveInputSourceBytes(
		resolvedSourceUrl,
		maximumAllowedImageBytes,
	);

	validateImageMimeType(downloadedPayload.mimeType);

	const resolvedFilename =
		downloadedPayload.filename ??
		deriveFilenameFromSourceUrl(resolvedSourceUrl, "uploaded-image.jpg");
	return {
		bytes: downloadedPayload.bytes,
		resolvedFilename,
		resolvedMimeType: downloadedPayload.mimeType,
		resolvedSourceUrl,
	};
}
