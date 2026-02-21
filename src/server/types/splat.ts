import { z } from "zod";

export const allowedSplatSourceTypeSchema = z.enum(["chatgpt_upload", "url"]);

export const allowedGpuTierSchema = z.enum(["t4", "l4", "a10", "a100", "h100"]);

export const chatGptFileReferenceSchema = z.object({
	download_url: z
		.string()
		.optional()
		.describe("Remote URL that the MCP server can download."),
	file_id: z
		.string()
		.optional()
		.describe("Opaque ChatGPT file identifier for the uploaded attachment."),
});

export const uploadReferenceSchema = z
	.any()
	.describe(
		"Attachment reference from ChatGPT upload flow. With openai/fileParams this should arrive as an object containing download_url and file_id.",
	);

export const splatViewerMetadataSchema = z.object({
	hasMetadata: z.boolean(),
	imageWidth: z.number().int().positive().optional(),
	imageHeight: z.number().int().positive().optional(),
	focalLength: z.number().positive().optional(),
});

export const generatedSplatMetadataSchema = z.object({
	gpuTier: allowedGpuTierSchema,
	elapsedMs: z.number().nonnegative(),
});

export const splatViewerPropsSchema = z.object({
	viewerSessionId: z.string(),
	plyAssetUrl: z.string(),
	displayName: z.string(),
	fileSizeBytes: z.number().int().nonnegative(),
	metadata: splatViewerMetadataSchema,
	controlsEnabled: z.boolean(),
	generation: generatedSplatMetadataSchema.optional(),
});

export const viewPlySplatInputSchema = z
	.object({
		sourceType: allowedSplatSourceTypeSchema.describe(
			"Where to load the PLY file from: chatgpt_upload for attachment references, url for direct URLs. If no URL/attachment exists yet, use open-ply-upload first.",
		),
		uploadReference: uploadReferenceSchema.optional(),
		plyUrl: z
			.string()
			.optional()
			.describe(
				"Direct HTTP(S) URL to a .ply file when sourceType is url. If missing, use open-ply-upload instead of asking the user for a URL.",
			),
		displayName: z
			.string()
			.optional()
			.describe("Optional human-readable name to show in the widget header."),
	})
	.superRefine((inputValue, context) => {
		if (
			inputValue.sourceType === "chatgpt_upload" &&
			!inputValue.uploadReference
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["uploadReference"],
				message:
					"uploadReference is required when sourceType is chatgpt_upload.",
			});
		}

		if (inputValue.sourceType === "url" && !inputValue.plyUrl) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["plyUrl"],
				message: "plyUrl is required when sourceType is url.",
			});
		}
	});

export const generateSplatFromImageInputSchema = z
	.object({
		sourceType: allowedSplatSourceTypeSchema.describe(
			"Where to load the source image from: chatgpt_upload for attachment references, url for direct URLs.",
		),
		uploadReference: uploadReferenceSchema.optional(),
		imageUrl: z
			.string()
			.optional()
			.describe(
				"Direct HTTP(S) URL to an image when sourceType is url. Use this tool only for image-to-splat generation.",
			),
		displayName: z
			.string()
			.optional()
			.describe("Optional human-readable name to show in the widget header."),
		gpuTier: allowedGpuTierSchema
			.default("a10")
			.describe("Modal GPU tier to use for SHARP inference."),
	})
	.superRefine((inputValue, context) => {
		if (
			inputValue.sourceType === "chatgpt_upload" &&
			!inputValue.uploadReference
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["uploadReference"],
				message:
					"uploadReference is required when sourceType is chatgpt_upload.",
			});
		}

		if (inputValue.sourceType === "url" && !inputValue.imageUrl) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["imageUrl"],
				message: "imageUrl is required when sourceType is url.",
			});
		}
	});

export type AllowedSplatSourceType = z.infer<
	typeof allowedSplatSourceTypeSchema
>;
export type AllowedGpuTier = z.infer<typeof allowedGpuTierSchema>;
export type SplatViewerMetadata = z.infer<typeof splatViewerMetadataSchema>;
export type SplatViewerProps = z.infer<typeof splatViewerPropsSchema>;
export type ViewPlySplatInput = z.infer<typeof viewPlySplatInputSchema>;
export type GenerateSplatFromImageInput = z.infer<
	typeof generateSplatFromImageInputSchema
>;
export type ChatGptFileReference = z.infer<typeof chatGptFileReferenceSchema>;

export interface ResolvedInputBytes {
	bytes: Uint8Array;
	resolvedFilename: string;
	resolvedMimeType: string | null;
	resolvedSourceUrl: string;
}

export interface PythonSplatGenerationResult {
	outputFilename: string;
	plyBytes: Uint8Array;
	elapsedMs: number;
}

export interface StoredArtifact {
	artifactId: string;
	absoluteFilePath: string;
	expiresAtUnixMs: number;
	mimeType: string;
	fileSizeBytes: number;
	displayName: string;
}
