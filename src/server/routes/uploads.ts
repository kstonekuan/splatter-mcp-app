import type { MCPServer } from "mcp-use/server";
import { validateLikelyGaussianSplatPly } from "../services/plySplatValidation";
import { temporaryArtifactStore } from "../services/tempArtifactStore";

const DEFAULT_MAXIMUM_UPLOAD_PLY_BYTES = 200 * 1024 * 1024;

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

function ensureFilenameUsesPlyExtension(displayNameValue: string): string {
	return displayNameValue.toLowerCase().endsWith(".ply")
		? displayNameValue
		: `${displayNameValue}.ply`;
}

function resolveDisplayNameFromUpload(
	uploadedFile: File,
	formDisplayNameValue: unknown,
): string {
	if (
		typeof formDisplayNameValue === "string" &&
		formDisplayNameValue.trim().length > 0
	) {
		return ensureFilenameUsesPlyExtension(formDisplayNameValue.trim());
	}

	if (uploadedFile.name.trim().length > 0) {
		return ensureFilenameUsesPlyExtension(uploadedFile.name.trim());
	}

	return "uploaded.ply";
}

let hasRegisteredUploadRoutes = false;

export function registerSplatUploadRoutes(serverInstance: MCPServer): void {
	if (hasRegisteredUploadRoutes) {
		return;
	}
	hasRegisteredUploadRoutes = true;

	serverInstance.app.post("/uploads/ply", async (context) => {
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

			const maximumUploadPlyBytes = parseMaximumUploadPlyBytes();
			if (rawUploadedFileValue.size <= 0) {
				return context.json(
					{ error: "Uploaded file is empty. Please upload a valid .ply file." },
					400,
				);
			}

			if (rawUploadedFileValue.size > maximumUploadPlyBytes) {
				return context.json(
					{
						error: `Uploaded file exceeds the maximum size of ${maximumUploadPlyBytes} bytes.`,
					},
					413,
				);
			}

			const uploadedFileArrayBuffer = await rawUploadedFileValue.arrayBuffer();
			const uploadedFileBytes = new Uint8Array(uploadedFileArrayBuffer);
			validateLikelyGaussianSplatPly(uploadedFileBytes);

			const resolvedDisplayName = resolveDisplayNameFromUpload(
				rawUploadedFileValue,
				multipartFormData.get("displayName"),
			);
			const storedArtifact =
				await temporaryArtifactStore.createArtifactFromBytes(
					uploadedFileBytes,
					".ply",
					rawUploadedFileValue.type || "application/octet-stream",
					resolvedDisplayName,
				);

			return context.json({
				artifactId: storedArtifact.artifactId,
				artifactUrl: temporaryArtifactStore.buildPublicArtifactUrl(
					storedArtifact.artifactId,
				),
				displayName: storedArtifact.displayName,
				fileSizeBytes: storedArtifact.fileSizeBytes,
				mimeType: storedArtifact.mimeType,
			});
		} catch (routeErrorValue) {
			const routeErrorMessage =
				routeErrorValue instanceof Error
					? routeErrorValue.message
					: "Unknown upload failure.";
			console.error("[uploads/ply] failed", { routeErrorMessage });
			return context.json({ error: routeErrorMessage }, 400);
		}
	});
}
