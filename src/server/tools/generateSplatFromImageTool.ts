import { randomUUID } from "node:crypto";
import { error, type MCPServer, text, widget } from "mcp-use/server";
import { resolveImageInputBytes } from "../services/chatgptFileResolver";
import { modalInferenceClient } from "../services/modalInferenceClient";
import { summarizePlyMetadata } from "../services/plyMetadataSummary";
import { validateLikelyGaussianSplatPly } from "../services/plySplatValidation";
import {
	logSplatDebug,
	logSplatError,
	logSplatInfo,
} from "../services/splatLogger";
import { temporaryArtifactStore } from "../services/tempArtifactStore";
import {
	generateSplatFromImageInputSchema,
	type SplatViewerProps,
	splatViewerPropsSchema,
} from "../types/splat";

function determineGeneratedDisplayName(
	explicitDisplayName: string | undefined,
	generatedFilename: string,
): string {
	if (explicitDisplayName?.trim().length) {
		return explicitDisplayName;
	}
	return generatedFilename;
}

export function registerGenerateSplatFromImageTool(
	serverInstance: MCPServer,
): void {
	serverInstance.tool(
		{
			name: "generate-splat-from-image",
			description:
				"Generate a new gaussian splat PLY from exactly one input image using Modal SHARP inference, then render it. Use this only when the user explicitly wants image-to-splat generation. If no image source exists yet, call open-ply-upload so the user can upload an image.",
			schema: generateSplatFromImageInputSchema,
			_meta: {
				"openai/fileParams": ["uploadReference"],
			},
			widget: {
				name: "splat-viewer",
				invoking: "Generating splat from image...",
				invoked: "Generated splat is ready",
			},
		},
		async (toolInputValue, toolContext) => {
			const generationTraceIdentifier = randomUUID();
			try {
				logSplatDebug("generate-tool-start", {
					generationTraceIdentifier,
					sourceType: toolInputValue.sourceType,
					gpuTier: toolInputValue.gpuTier,
					hasImageUrl: typeof toolInputValue.imageUrl === "string",
					hasUploadReference: Boolean(toolInputValue.uploadReference),
				});
				await toolContext.reportProgress?.(
					5,
					100,
					"Resolving source image bytes.",
				);
				const resolvedImageInput = await resolveImageInputBytes(toolInputValue);
				logSplatDebug("generate-tool-source-resolved", {
					generationTraceIdentifier,
					resolvedFilename: resolvedImageInput.resolvedFilename,
					resolvedMimeType: resolvedImageInput.resolvedMimeType,
					imageByteLength: resolvedImageInput.bytes.byteLength,
					resolvedSourceUrl: resolvedImageInput.resolvedSourceUrl,
				});
				await toolContext.log(
					"info",
					"Source image resolved, invoking Modal endpoint.",
					resolvedImageInput.resolvedFilename,
				);

				await toolContext.reportProgress?.(35, 100, "Running SHARP inference.");
				const generatedSplatResult =
					await modalInferenceClient.generateSplatFromImage(
						resolvedImageInput.bytes,
						resolvedImageInput.resolvedFilename,
						toolInputValue.gpuTier,
					);
				validateLikelyGaussianSplatPly(generatedSplatResult.plyBytes);
				logSplatDebug("generate-tool-modal-success", {
					generationTraceIdentifier,
					outputFilename: generatedSplatResult.outputFilename,
					plyByteLength: generatedSplatResult.plyBytes.byteLength,
					elapsedMsReportedByModal: generatedSplatResult.elapsedMs,
				});

				await toolContext.reportProgress?.(
					80,
					100,
					"Saving generated PLY artifact.",
				);
				const displayName = determineGeneratedDisplayName(
					toolInputValue.displayName,
					generatedSplatResult.outputFilename,
				);
				const storedArtifact =
					await temporaryArtifactStore.createArtifactFromBytes(
						generatedSplatResult.plyBytes,
						".ply",
						"application/octet-stream",
						displayName,
					);
				logSplatInfo("generate-tool-artifact-created", {
					generationTraceIdentifier,
					artifactId: storedArtifact.artifactId,
					displayName: storedArtifact.displayName,
					fileSizeBytes: storedArtifact.fileSizeBytes,
					gpuTier: toolInputValue.gpuTier,
				});
				logSplatDebug("generate-tool-artifact-created", {
					generationTraceIdentifier,
					artifactId: storedArtifact.artifactId,
					displayName: storedArtifact.displayName,
					fileSizeBytes: storedArtifact.fileSizeBytes,
				});

				const viewerProps: SplatViewerProps = {
					viewerSessionId: randomUUID(),
					plyAssetUrl: temporaryArtifactStore.buildPublicArtifactUrl(
						storedArtifact.artifactId,
					),
					displayName,
					fileSizeBytes: storedArtifact.fileSizeBytes,
					metadata: summarizePlyMetadata(generatedSplatResult.plyBytes),
					controlsEnabled: true,
					generation: {
						gpuTier: toolInputValue.gpuTier,
						elapsedMs: generatedSplatResult.elapsedMs,
					},
				};
				const validationResult = splatViewerPropsSchema.safeParse(viewerProps);
				if (!validationResult.success) {
					await toolContext.log(
						"error",
						"Generated widget props failed schema validation.",
						JSON.stringify(validationResult.error.flatten()),
					);
					return error(
						"Unable to render generated splat due to invalid widget data.",
					);
				}

				await toolContext.reportProgress?.(
					100,
					100,
					"Splat generation complete.",
				);
				logSplatDebug("generate-tool-success", {
					generationTraceIdentifier,
					artifactId: storedArtifact.artifactId,
					artifactUrl: viewerProps.plyAssetUrl,
				});
				return widget({
					props: validationResult.data,
					output: text(
						`Generated ${displayName} on ${toolInputValue.gpuTier} in ${Math.round(generatedSplatResult.elapsedMs)} ms.`,
					),
				});
			} catch (toolExecutionError) {
				const errorMessage =
					toolExecutionError instanceof Error
						? toolExecutionError.message
						: "Unknown failure while generating splat.";
				logSplatError("generate-tool-failed", toolExecutionError, {
					generationTraceIdentifier,
					sourceType: toolInputValue.sourceType,
					uploadReferenceType: typeof toolInputValue.uploadReference,
					hasImageUrl: typeof toolInputValue.imageUrl === "string",
					gpuTier: toolInputValue.gpuTier,
				});
				console.error("[generate-splat-from-image] failed", {
					errorMessage,
					sourceType: toolInputValue.sourceType,
					uploadReferenceType: typeof toolInputValue.uploadReference,
					hasImageUrl: typeof toolInputValue.imageUrl === "string",
					gpuTier: toolInputValue.gpuTier,
				});
				await toolContext.log(
					"error",
					"generate-splat-from-image failed.",
					errorMessage,
				);
				return error(`Failed to generate splat from image: ${errorMessage}`);
			}
		},
	);
}
