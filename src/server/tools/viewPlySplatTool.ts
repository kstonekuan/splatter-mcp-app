import { randomUUID } from "node:crypto";
import { error, type MCPServer, text, widget } from "mcp-use/server";
import { resolvePlyInputBytes } from "../services/chatgptFileResolver";
import { summarizePlyMetadata } from "../services/plyMetadataSummary";
import { temporaryArtifactStore } from "../services/tempArtifactStore";
import {
	type SplatViewerProps,
	splatViewerPropsSchema,
	viewPlySplatInputSchema,
} from "../types/splat";

function inferDisplayName(
	resolvedFilename: string,
	explicitDisplayName: string | undefined,
): string {
	return explicitDisplayName?.trim().length
		? explicitDisplayName
		: resolvedFilename;
}

function inferPlyFileExtension(resolvedFilename: string): string {
	return resolvedFilename.toLowerCase().endsWith(".ply") ? ".ply" : ".ply";
}

export function registerViewPlySplatTool(serverInstance: MCPServer): void {
	serverInstance.tool(
		{
			name: "view-ply-splat",
			description:
				"Render a .ply gaussian splat when a source is already available (URL or attachment reference). If the user has no URL and wants to upload a local file, call open-ply-upload instead.",
			schema: viewPlySplatInputSchema,
			_meta: {
				"openai/fileParams": ["uploadReference"],
			},
			widget: {
				name: "splat-viewer",
				invoking: "Loading PLY splat...",
				invoked: "PLY splat loaded",
			},
		},
		async (toolInputValue, toolContext) => {
			try {
				await toolContext.log("info", "Resolving PLY input bytes.");
				const resolvedInputBytes = await resolvePlyInputBytes(toolInputValue);
				const displayName = inferDisplayName(
					resolvedInputBytes.resolvedFilename,
					toolInputValue.displayName,
				);

				const storedArtifact =
					await temporaryArtifactStore.createArtifactFromBytes(
						resolvedInputBytes.bytes,
						inferPlyFileExtension(resolvedInputBytes.resolvedFilename),
						resolvedInputBytes.resolvedMimeType ?? "application/octet-stream",
						displayName,
					);

				const viewerProps: SplatViewerProps = {
					viewerSessionId: randomUUID(),
					plyAssetUrl: temporaryArtifactStore.buildPublicArtifactUrl(
						storedArtifact.artifactId,
					),
					displayName,
					fileSizeBytes: storedArtifact.fileSizeBytes,
					metadata: summarizePlyMetadata(resolvedInputBytes.bytes),
					controlsEnabled: true,
				};

				const validationResult = splatViewerPropsSchema.safeParse(viewerProps);
				if (!validationResult.success) {
					await toolContext.log(
						"error",
						"Generated widget props failed schema validation.",
						JSON.stringify(validationResult.error.flatten()),
					);
					return error("Unable to render splat due to invalid widget data.");
				}

				return widget({
					props: validationResult.data,
					output: text(
						`Loaded ${displayName} (${storedArtifact.fileSizeBytes} bytes). You can now inspect and animate the splat.`,
					),
				});
			} catch (toolExecutionError) {
				const errorMessage =
					toolExecutionError instanceof Error
						? toolExecutionError.message
						: "Unknown failure while loading PLY splat.";
				console.error("[view-ply-splat] failed", {
					errorMessage,
					sourceType: toolInputValue.sourceType,
					uploadReferenceType: typeof toolInputValue.uploadReference,
					hasPlyUrl: typeof toolInputValue.plyUrl === "string",
				});
				await toolContext.log("error", "view-ply-splat failed.", errorMessage);
				return error(`Failed to load PLY splat: ${errorMessage}`);
			}
		},
	);
}
