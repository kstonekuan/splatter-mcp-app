import { error, type MCPServer, text, widget } from "mcp-use/server";
import { z } from "zod";

const DEFAULT_MAXIMUM_UPLOAD_PLY_BYTES = 200 * 1024 * 1024;

const openPlyUploadToolInputSchema = z.object({});

const splatUploadWidgetPropsSchema = z.object({
	uploadEndpointUrl: z.string(),
	maximumPlyBytes: z.number().int().positive(),
});

type SplatUploadWidgetProps = z.infer<typeof splatUploadWidgetPropsSchema>;

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

function resolvePublicUploadEndpointUrl(): string {
	const configuredBaseUrl =
		process.env["MCP_URL"] ?? process.env["SPLAT_PUBLIC_BASE_URL"];
	const uploadRoutePath = "/uploads/ply";
	if (!configuredBaseUrl) {
		return uploadRoutePath;
	}
	return new URL(uploadRoutePath, configuredBaseUrl).toString();
}

export function registerOpenPlyUploadTool(serverInstance: MCPServer): void {
	serverInstance.tool(
		{
			name: "open-ply-upload",
			description:
				"Primary entrypoint for rendering with Splatter when no direct file URL is already provided. Open the upload widget immediately so the user can pick a local .ply file, then auto-render it.",
			schema: openPlyUploadToolInputSchema,
			widget: {
				name: "splat-upload",
				invoking: "Opening PLY upload widget...",
				invoked: "PLY upload widget ready",
			},
		},
		async () => {
			try {
				const uploadWidgetProps: SplatUploadWidgetProps = {
					uploadEndpointUrl: resolvePublicUploadEndpointUrl(),
					maximumPlyBytes: parseMaximumUploadPlyBytes(),
				};
				const validationResult =
					splatUploadWidgetPropsSchema.safeParse(uploadWidgetProps);
				if (!validationResult.success) {
					console.error("[open-ply-upload] invalid widget props", {
						validationError: validationResult.error.flatten(),
					});
					return error(
						"Unable to open upload widget because widget props are invalid.",
					);
				}

				return widget({
					props: validationResult.data,
					output: text(
						"Upload a .ply file directly to this server. After upload, the viewer will open automatically.",
					),
				});
			} catch (toolErrorValue) {
				const toolErrorMessage =
					toolErrorValue instanceof Error
						? toolErrorValue.message
						: "Unknown error while opening upload widget.";
				console.error("[open-ply-upload] failed", { toolErrorMessage });
				return error(`Failed to open PLY upload widget: ${toolErrorMessage}`);
			}
		},
	);
}
