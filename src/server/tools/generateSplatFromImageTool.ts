import { randomUUID } from "node:crypto";
import { error, type MCPServer, text, widget } from "mcp-use/server";
import { resolveImageInputBytes } from "../services/chatgptFileResolver";
import { summarizePlyMetadata } from "../services/plyMetadataSummary";
import { pythonInferenceClient } from "../services/pythonInferenceClient";
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
				"Generate a new gaussian splat PLY from exactly one input image using Modal SHARP inference, then render it. Use this only when the user explicitly wants image-to-splat generation.",
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
			try {
				await toolContext.reportProgress?.(
					5,
					100,
					"Resolving source image bytes.",
				);
				const resolvedImageInput = await resolveImageInputBytes(toolInputValue);
				await toolContext.log(
					"info",
					"Source image resolved, invoking Python inference service.",
					resolvedImageInput.resolvedFilename,
				);

				await toolContext.reportProgress?.(
					35,
					100,
					"Running SHARP inference on Modal.",
				);
				const generatedSplatResult =
					await pythonInferenceClient.generateSplatFromImage(
						resolvedImageInput.bytes,
						resolvedImageInput.resolvedFilename,
						toolInputValue.gpuTier,
					);

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
