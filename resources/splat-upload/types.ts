import { z } from "zod";

export const splatUploadWidgetPropsSchema = z.object({
	uploadEndpointUrl: z.string(),
	imageGenerationStartEndpointUrl: z.string(),
	maximumPlyBytes: z.number().int().positive(),
	maximumImageBytes: z.number().int().positive(),
});

export const uploadSplatAssetResponseSchema = z.object({
	artifactId: z.string(),
	artifactUrl: z.string(),
	displayName: z.string(),
	fileSizeBytes: z.number().int().nonnegative(),
	mimeType: z.string(),
	uploadedAssetType: z.enum(["ply", "image"]),
});

export type SplatUploadWidgetProps = z.infer<
	typeof splatUploadWidgetPropsSchema
>;
export type UploadSplatAssetResponse = z.infer<
	typeof uploadSplatAssetResponseSchema
>;
