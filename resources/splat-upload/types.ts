import { z } from "zod";

export const splatUploadWidgetPropsSchema = z.object({
	uploadEndpointUrl: z.string(),
	maximumPlyBytes: z.number().int().positive(),
});

export const uploadPlyResponseSchema = z.object({
	artifactId: z.string(),
	artifactUrl: z.string(),
	displayName: z.string(),
	fileSizeBytes: z.number().int().nonnegative(),
	mimeType: z.string(),
});

export type SplatUploadWidgetProps = z.infer<
	typeof splatUploadWidgetPropsSchema
>;
export type UploadPlyResponse = z.infer<typeof uploadPlyResponseSchema>;
