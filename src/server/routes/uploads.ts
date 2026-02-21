import type { MCPServer } from "mcp-use/server";
import { validateLikelyGaussianSplatPly } from "../services/plySplatValidation";
import { logSplatInfo } from "../services/splatLogger";
import { temporaryArtifactStore } from "../services/tempArtifactStore";

const DEFAULT_MAXIMUM_UPLOAD_PLY_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAXIMUM_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_FILE_EXTENSIONS = new Set([
	".avif",
	".bmp",
	".gif",
	".heic",
	".heif",
	".jpeg",
	".jpg",
	".png",
	".tif",
	".tiff",
	".webp",
]);

type UploadedAssetType = "ply" | "image";

interface UploadedAssetClassification {
	uploadedAssetType: UploadedAssetType;
	fileExtension: string;
}

interface UploadRouteContext {
	req: {
		formData: () => Promise<FormData>;
	};
	json: (responseBody: unknown, statusCode?: number) => Response;
}

function parseMaximumUploadPlyBytes(): number {
	const parsedMaximumUploadBytes = Number.parseInt(
		process.env["SPLAT_MAX_PLY_BYTES"] ?? "",
		10,
	);
	if (Number.isNaN(parsedMaximumUploadBytes) || parsedMaximumUploadBytes <= 0) {
		return DEFAULT_MAXIMUM_UPLOAD_PLY_BYTES;
	}
	return parsedMaximumUploadBytes;
}

function parseMaximumUploadImageBytes(): number {
	const parsedMaximumUploadBytes = Number.parseInt(
		process.env["SPLAT_MAX_IMAGE_BYTES"] ?? "",
		10,
	);
	if (Number.isNaN(parsedMaximumUploadBytes) || parsedMaximumUploadBytes <= 0) {
		return DEFAULT_MAXIMUM_UPLOAD_IMAGE_BYTES;
	}
	return parsedMaximumUploadBytes;
}

function inferImageFileExtensionFromMimeType(
	uploadedMimeType: string,
): string | null {
	const normalizedMimeType = uploadedMimeType
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (!normalizedMimeType) {
		return null;
	}

	switch (normalizedMimeType) {
		case "image/avif":
			return ".avif";
		case "image/bmp":
			return ".bmp";
		case "image/gif":
			return ".gif";
		case "image/heic":
			return ".heic";
		case "image/heif":
			return ".heif";
		case "image/jpeg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/tiff":
			return ".tiff";
		case "image/webp":
			return ".webp";
		default:
			return null;
	}
}

function extractLowerCaseFileExtension(uploadedFilename: string): string {
	const lastDotIndex = uploadedFilename.lastIndexOf(".");
	if (lastDotIndex < 0) {
		return "";
	}
	return uploadedFilename.slice(lastDotIndex).toLowerCase();
}

function classifyUploadedAsset(
	uploadedFile: File,
): UploadedAssetClassification {
	const extractedFileExtension = extractLowerCaseFileExtension(
		uploadedFile.name,
	);
	if (extractedFileExtension === ".ply") {
		return {
			uploadedAssetType: "ply",
			fileExtension: ".ply",
		};
	}

	const normalizedMimeType = uploadedFile.type.trim().toLowerCase();
	if (
		normalizedMimeType.startsWith("image/") ||
		SUPPORTED_IMAGE_FILE_EXTENSIONS.has(extractedFileExtension)
	) {
		const inferredImageExtension =
			extractedFileExtension ||
			inferImageFileExtensionFromMimeType(uploadedFile.type) ||
			".jpg";
		return {
			uploadedAssetType: "image",
			fileExtension: inferredImageExtension,
		};
	}

	throw new Error(
		"Unsupported upload type. Upload either a Gaussian splat .ply file or an image (jpg/png/webp/heic/gif/tiff/bmp/avif).",
	);
}

function ensureFilenameUsesPlyExtension(displayNameValue: string): string {
	return displayNameValue.toLowerCase().endsWith(".ply")
		? displayNameValue
		: `${displayNameValue}.ply`;
}

function ensureFilenameUsesExtension(
	displayNameValue: string,
	requiredFileExtension: string,
): string {
	return displayNameValue.toLowerCase().endsWith(requiredFileExtension)
		? displayNameValue
		: `${displayNameValue}${requiredFileExtension}`;
}

function resolveDisplayNameFromUpload(
	uploadedFile: File,
	formDisplayNameValue: unknown,
	uploadedAssetType: UploadedAssetType,
	fileExtension: string,
): string {
	if (
		typeof formDisplayNameValue === "string" &&
		formDisplayNameValue.trim().length > 0
	) {
		const trimmedDisplayName = formDisplayNameValue.trim();
		return uploadedAssetType === "ply"
			? ensureFilenameUsesPlyExtension(trimmedDisplayName)
			: ensureFilenameUsesExtension(trimmedDisplayName, fileExtension);
	}

	if (uploadedFile.name.trim().length > 0) {
		return uploadedAssetType === "ply"
			? ensureFilenameUsesPlyExtension(uploadedFile.name.trim())
			: ensureFilenameUsesExtension(uploadedFile.name.trim(), fileExtension);
	}

	if (uploadedAssetType === "ply") {
		return "uploaded.ply";
	}

	return `uploaded-image${fileExtension}`;
}

function resolveStoredMimeType(
	uploadedFile: File,
	uploadedAssetType: UploadedAssetType,
): string {
	const normalizedMimeType = uploadedFile.type.trim().toLowerCase();
	if (normalizedMimeType.length > 0) {
		return normalizedMimeType;
	}

	if (uploadedAssetType === "image") {
		return "image/jpeg";
	}

	return "application/octet-stream";
}

let hasRegisteredUploadRoutes = false;

export function registerSplatUploadRoutes(serverInstance: MCPServer): void {
	if (hasRegisteredUploadRoutes) {
		return;
	}
	hasRegisteredUploadRoutes = true;

	const handleUploadRequest = async (context: UploadRouteContext) => {
		try {
			const multipartFormData = await context.req.formData();
			const rawUploadedFileValue = multipartFormData.get("file");
			if (!(rawUploadedFileValue instanceof File)) {
				return context.json(
					{
						error:
							"Missing file upload. Submit multipart/form-data with a 'file' field.",
					},
					400,
				);
			}

			if (rawUploadedFileValue.size <= 0) {
				return context.json(
					{
						error:
							"Uploaded file is empty. Please upload a valid .ply or image file.",
					},
					400,
				);
			}

			const uploadedAssetClassification =
				classifyUploadedAsset(rawUploadedFileValue);
			const maximumUploadBytes =
				uploadedAssetClassification.uploadedAssetType === "ply"
					? parseMaximumUploadPlyBytes()
					: parseMaximumUploadImageBytes();
			if (rawUploadedFileValue.size > maximumUploadBytes) {
				return context.json(
					{
						error: `Uploaded ${uploadedAssetClassification.uploadedAssetType} file exceeds the maximum size of ${maximumUploadBytes} bytes.`,
					},
					413,
				);
			}

			const uploadedFileArrayBuffer = await rawUploadedFileValue.arrayBuffer();
			const uploadedFileBytes = new Uint8Array(uploadedFileArrayBuffer);
			if (uploadedAssetClassification.uploadedAssetType === "ply") {
				validateLikelyGaussianSplatPly(uploadedFileBytes);
			}

			const resolvedDisplayName = resolveDisplayNameFromUpload(
				rawUploadedFileValue,
				multipartFormData.get("displayName"),
				uploadedAssetClassification.uploadedAssetType,
				uploadedAssetClassification.fileExtension,
			);
			const storedArtifact =
				await temporaryArtifactStore.createArtifactFromBytes(
					uploadedFileBytes,
					uploadedAssetClassification.fileExtension,
					resolveStoredMimeType(
						rawUploadedFileValue,
						uploadedAssetClassification.uploadedAssetType,
					),
					resolvedDisplayName,
				);
			logSplatInfo("asset-upload-success", {
				artifactId: storedArtifact.artifactId,
				uploadedAssetType: uploadedAssetClassification.uploadedAssetType,
				displayName: storedArtifact.displayName,
				fileSizeBytes: storedArtifact.fileSizeBytes,
				mimeType: storedArtifact.mimeType,
			});

			return context.json({
				artifactId: storedArtifact.artifactId,
				artifactUrl: temporaryArtifactStore.buildPublicArtifactUrl(
					storedArtifact.artifactId,
				),
				displayName: storedArtifact.displayName,
				fileSizeBytes: storedArtifact.fileSizeBytes,
				mimeType: storedArtifact.mimeType,
				uploadedAssetType: uploadedAssetClassification.uploadedAssetType,
			});
		} catch (routeErrorValue) {
			const routeErrorMessage =
				routeErrorValue instanceof Error
					? routeErrorValue.message
					: "Unknown upload failure.";
			console.error("[uploads/asset] failed", { routeErrorMessage });
			return context.json({ error: routeErrorMessage }, 400);
		}
	};

	serverInstance.app.post("/uploads/asset", handleUploadRequest);
	serverInstance.app.post("/uploads/ply", handleUploadRequest);
}
