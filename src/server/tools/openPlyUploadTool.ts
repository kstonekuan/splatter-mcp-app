import { error, type MCPServer, text, widget } from "mcp-use/server";
import { z } from "zod";

const DEFAULT_MAXIMUM_UPLOAD_PLY_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAXIMUM_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;

const openPlyUploadToolInputSchema = z.object({});

const splatUploadWidgetPropsSchema = z.object({
	uploadEndpointUrl: z.string(),
	imageGenerationStartEndpointUrl: z.string(),
	maximumPlyBytes: z.number().int().positive(),
	maximumImageBytes: z.number().int().positive(),
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

function resolvePublicUploadEndpointUrl(): string {
	const configuredBaseUrl =
		process.env["MCP_URL"] ?? process.env["SPLAT_PUBLIC_BASE_URL"];
	const uploadRoutePath = "/uploads/asset";
	if (!configuredBaseUrl) {
		return uploadRoutePath;
	}
	return new URL(uploadRoutePath, configuredBaseUrl).toString();
}

function resolvePublicImageGenerationStartEndpointUrl(): string {
	const configuredBaseUrl =
		process.env["MCP_URL"] ?? process.env["SPLAT_PUBLIC_BASE_URL"];
	const imageGenerationStartRoutePath = "/jobs/image-to-splat";
	if (!configuredBaseUrl) {
		return imageGenerationStartRoutePath;
	}
	return new URL(imageGenerationStartRoutePath, configuredBaseUrl).toString();
}

export function registerOpenPlyUploadTool(serverInstance: MCPServer): void {
	serverInstance.tool(
		{
			name: "open-ply-upload",
			description:
				"Primary entrypoint for Splatter when no direct URL is provided. Opens a widget where the user can upload either a Gaussian splat .ply file (render directly) or an image (generate a splat, then render).",
			schema: openPlyUploadToolInputSchema,
			widget: {
				name: "splat-upload",
				invoking: "Opening Splatter upload widget...",
				invoked: "Splatter upload widget ready",
			},
		},
		async () => {
			try {
				const uploadWidgetProps: SplatUploadWidgetProps = {
					uploadEndpointUrl: resolvePublicUploadEndpointUrl(),
					imageGenerationStartEndpointUrl:
						resolvePublicImageGenerationStartEndpointUrl(),
					maximumPlyBytes: parseMaximumUploadPlyBytes(),
					maximumImageBytes: parseMaximumUploadImageBytes(),
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
						"Upload a .ply splat or an image. PLY uploads render immediately; image uploads run image-to-splat generation and then open the viewer.",
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
