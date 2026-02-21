import { z } from "zod";

export const generationMetadataSchema = z.object({
	gpuTier: z.enum(["t4", "l4", "a10", "a100", "h100"]),
	elapsedMs: z.number().nonnegative(),
});

export const splatViewerMetadataSchema = z.object({
	hasMetadata: z.boolean(),
	imageWidth: z.number().int().positive().optional(),
	imageHeight: z.number().int().positive().optional(),
	focalLength: z.number().positive().optional(),
});

export const splatViewerPropsSchema = z.object({
	viewerSessionId: z.string(),
	plyAssetUrl: z.string(),
	displayName: z.string(),
	fileSizeBytes: z.number().int().nonnegative(),
	metadata: splatViewerMetadataSchema,
	controlsEnabled: z.boolean(),
	generation: generationMetadataSchema.optional(),
});

export type SplatViewerProps = z.infer<typeof splatViewerPropsSchema>;
