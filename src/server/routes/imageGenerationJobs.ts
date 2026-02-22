import { randomUUID } from "node:crypto";
import type { MCPServer } from "mcp-use/server";
import { modalInferenceClient } from "../services/modalInferenceClient.js";
import { validateLikelyGaussianSplatPly } from "../services/plySplatValidation.js";
import {
	logSplatError,
	logSplatInfo,
	logSplatWarning,
} from "../services/splatLogger.js";
import { temporaryArtifactStore } from "../services/tempArtifactStore.js";
import type { AllowedGpuTier } from "../types/splat.js";

type ImageGenerationJobStatus = "queued" | "running" | "succeeded" | "failed";

interface ImageGenerationJobRecord {
	jobId: string;
	status: ImageGenerationJobStatus;
	createdAtUnixMs: number;
	updatedAtUnixMs: number;
	expiresAtUnixMs: number;
	imageArtifactId: string;
	displayName: string;
	gpuTier: AllowedGpuTier;
	errorMessage: string | null;
	outputArtifactId: string | null;
	outputArtifactUrl: string | null;
	outputDisplayName: string | null;
	outputFileSizeBytes: number | null;
}

interface StartImageGenerationJobRequestBody {
	imageArtifactId?: unknown;
	displayName?: unknown;
	gpuTier?: unknown;
}

const DEFAULT_IMAGE_GENERATION_JOB_TTL_SECONDS = 3600;
const DEFAULT_IMAGE_GENERATION_GPU_TIER: AllowedGpuTier = "l4";
const allowedGpuTierValues: ReadonlySet<AllowedGpuTier> = new Set([
	"t4",
	"l4",
	"a10",
	"a100",
	"h100",
]);

const imageGenerationJobsById = new Map<string, ImageGenerationJobRecord>();

function parsePositiveIntegerEnvironmentValue(
	environmentVariableValue: string | undefined,
	fallbackValue: number,
): number {
	const parsedValue = Number.parseInt(environmentVariableValue ?? "", 10);
	if (Number.isNaN(parsedValue) || parsedValue <= 0) {
		return fallbackValue;
	}
	return parsedValue;
}

function parseImageGenerationJobTtlMilliseconds(): number {
	return (
		parsePositiveIntegerEnvironmentValue(
			process.env["SPLAT_IMAGE_JOB_TTL_SECONDS"],
			DEFAULT_IMAGE_GENERATION_JOB_TTL_SECONDS,
		) * 1000
	);
}

function resolvePublicUrlForPath(relativePath: string): string {
	const configuredBaseUrl =
		process.env["MCP_URL"] ?? process.env["SPLAT_PUBLIC_BASE_URL"];
	if (!configuredBaseUrl) {
		return relativePath;
	}
	return new URL(relativePath, configuredBaseUrl).toString();
}

function resolveDisplayName(
	requestedDisplayNameValue: unknown,
	imageArtifactDisplayName: string,
): string {
	if (
		typeof requestedDisplayNameValue === "string" &&
		requestedDisplayNameValue.trim().length > 0
	) {
		return requestedDisplayNameValue.trim();
	}
	return imageArtifactDisplayName;
}

function resolveGpuTier(requestedGpuTierValue: unknown): AllowedGpuTier {
	if (
		typeof requestedGpuTierValue === "string" &&
		allowedGpuTierValues.has(requestedGpuTierValue as AllowedGpuTier)
	) {
		return requestedGpuTierValue as AllowedGpuTier;
	}
	return DEFAULT_IMAGE_GENERATION_GPU_TIER;
}

function cleanupExpiredImageGenerationJobs(): void {
	const currentUnixMilliseconds = Date.now();
	for (const [jobId, imageGenerationJobRecord] of imageGenerationJobsById) {
		if (imageGenerationJobRecord.expiresAtUnixMs <= currentUnixMilliseconds) {
			imageGenerationJobsById.delete(jobId);
		}
	}
}

function updateJobStatus(
	jobId: string,
	partialJobUpdate: Partial<ImageGenerationJobRecord>,
): void {
	const existingJobRecord = imageGenerationJobsById.get(jobId);
	if (!existingJobRecord) {
		return;
	}
	imageGenerationJobsById.set(jobId, {
		...existingJobRecord,
		...partialJobUpdate,
		updatedAtUnixMs: Date.now(),
	});
}

function serializeJobForResponse(
	imageGenerationJobRecord: ImageGenerationJobRecord,
): Record<string, unknown> {
	return {
		jobId: imageGenerationJobRecord.jobId,
		status: imageGenerationJobRecord.status,
		createdAtUnixMs: imageGenerationJobRecord.createdAtUnixMs,
		updatedAtUnixMs: imageGenerationJobRecord.updatedAtUnixMs,
		expiresAtUnixMs: imageGenerationJobRecord.expiresAtUnixMs,
		displayName: imageGenerationJobRecord.displayName,
		gpuTier: imageGenerationJobRecord.gpuTier,
		errorMessage: imageGenerationJobRecord.errorMessage,
		outputArtifactId: imageGenerationJobRecord.outputArtifactId,
		outputArtifactUrl: imageGenerationJobRecord.outputArtifactUrl,
		outputDisplayName: imageGenerationJobRecord.outputDisplayName,
		outputFileSizeBytes: imageGenerationJobRecord.outputFileSizeBytes,
	};
}

async function runImageGenerationJob(jobId: string): Promise<void> {
	const existingJobRecord = imageGenerationJobsById.get(jobId);
	if (!existingJobRecord) {
		return;
	}

	updateJobStatus(jobId, { status: "running", errorMessage: null });

	try {
		const sourceImageArtifact =
			await temporaryArtifactStore.getArtifactIfAvailable(
				existingJobRecord.imageArtifactId,
			);
		if (!sourceImageArtifact) {
			throw new Error("Source image artifact was not found or has expired.");
		}
		if (!sourceImageArtifact.mimeType.toLowerCase().startsWith("image/")) {
			throw new Error(
				`Source artifact is not an image (mimeType=${sourceImageArtifact.mimeType}).`,
			);
		}

		const sourceImageBytes = await temporaryArtifactStore.readArtifactBytes(
			existingJobRecord.imageArtifactId,
		);
		if (!sourceImageBytes) {
			throw new Error("Source image bytes were not available for generation.");
		}

		const generatedSplatResult =
			await modalInferenceClient.generateSplatFromImage(
				sourceImageBytes,
				sourceImageArtifact.displayName,
				existingJobRecord.gpuTier,
			);
		validateLikelyGaussianSplatPly(generatedSplatResult.plyBytes);

		const generatedDisplayName = existingJobRecord.displayName
			.toLowerCase()
			.endsWith(".ply")
			? existingJobRecord.displayName
			: `${existingJobRecord.displayName}.ply`;
		const generatedArtifact =
			await temporaryArtifactStore.createArtifactFromBytes(
				generatedSplatResult.plyBytes,
				".ply",
				"application/octet-stream",
				generatedDisplayName,
			);

		updateJobStatus(jobId, {
			status: "succeeded",
			errorMessage: null,
			outputArtifactId: generatedArtifact.artifactId,
			outputArtifactUrl: temporaryArtifactStore.buildPublicArtifactUrl(
				generatedArtifact.artifactId,
			),
			outputDisplayName: generatedArtifact.displayName,
			outputFileSizeBytes: generatedArtifact.fileSizeBytes,
		});
		logSplatInfo("image-generation-job-succeeded", {
			jobId,
			imageArtifactId: existingJobRecord.imageArtifactId,
			outputArtifactId: generatedArtifact.artifactId,
			outputDisplayName: generatedArtifact.displayName,
			outputFileSizeBytes: generatedArtifact.fileSizeBytes,
			gpuTier: existingJobRecord.gpuTier,
		});
	} catch (errorValue) {
		const normalizedErrorMessage =
			errorValue instanceof Error
				? errorValue.message
				: "Unknown image-to-splat generation failure.";
		updateJobStatus(jobId, {
			status: "failed",
			errorMessage: normalizedErrorMessage,
		});
		logSplatError("image-generation-job-failed", errorValue, {
			jobId,
			imageArtifactId: existingJobRecord.imageArtifactId,
			gpuTier: existingJobRecord.gpuTier,
		});
	}
}

let hasRegisteredImageGenerationJobRoutes = false;

export function registerImageGenerationJobRoutes(
	serverInstance: MCPServer,
): void {
	if (hasRegisteredImageGenerationJobRoutes) {
		return;
	}
	hasRegisteredImageGenerationJobRoutes = true;

	serverInstance.app.post("/jobs/image-to-splat", async (context) => {
		cleanupExpiredImageGenerationJobs();
		try {
			const requestBodyValue =
				(await context.req.json()) as StartImageGenerationJobRequestBody;
			const imageArtifactIdentifier = requestBodyValue.imageArtifactId;
			if (
				typeof imageArtifactIdentifier !== "string" ||
				imageArtifactIdentifier.trim().length === 0
			) {
				return context.json(
					{
						errorMessage:
							"imageArtifactId is required to start image-to-splat generation.",
					},
					400,
				);
			}

			const sourceImageArtifact =
				await temporaryArtifactStore.getArtifactIfAvailable(
					imageArtifactIdentifier,
				);
			if (!sourceImageArtifact) {
				return context.json(
					{
						errorMessage: "Source image artifact was not found or has expired.",
					},
					404,
				);
			}
			if (!sourceImageArtifact.mimeType.toLowerCase().startsWith("image/")) {
				return context.json(
					{
						errorMessage: `Source artifact must be an image. Received mimeType=${sourceImageArtifact.mimeType}.`,
					},
					400,
				);
			}

			const jobIdentifier = randomUUID();
			const currentUnixMilliseconds = Date.now();
			const imageGenerationJobRecord: ImageGenerationJobRecord = {
				jobId: jobIdentifier,
				status: "queued",
				createdAtUnixMs: currentUnixMilliseconds,
				updatedAtUnixMs: currentUnixMilliseconds,
				expiresAtUnixMs:
					currentUnixMilliseconds + parseImageGenerationJobTtlMilliseconds(),
				imageArtifactId: imageArtifactIdentifier,
				displayName: resolveDisplayName(
					requestBodyValue.displayName,
					sourceImageArtifact.displayName,
				),
				gpuTier: resolveGpuTier(requestBodyValue.gpuTier),
				errorMessage: null,
				outputArtifactId: null,
				outputArtifactUrl: null,
				outputDisplayName: null,
				outputFileSizeBytes: null,
			};
			imageGenerationJobsById.set(jobIdentifier, imageGenerationJobRecord);
			logSplatInfo("image-generation-job-queued", {
				jobId: jobIdentifier,
				imageArtifactId: imageArtifactIdentifier,
				displayName: imageGenerationJobRecord.displayName,
				gpuTier: imageGenerationJobRecord.gpuTier,
			});
			void runImageGenerationJob(jobIdentifier);

			return context.json(
				{
					...serializeJobForResponse(imageGenerationJobRecord),
					statusEndpointUrl: resolvePublicUrlForPath(
						`/jobs/image-to-splat/${jobIdentifier}`,
					),
				},
				202,
			);
		} catch (errorValue) {
			logSplatError("image-generation-job-start-failed", errorValue);
			return context.json(
				{
					errorMessage:
						errorValue instanceof Error
							? errorValue.message
							: "Unknown image generation job start failure.",
				},
				400,
			);
		}
	});

	serverInstance.app.get("/jobs/image-to-splat/:jobId", async (context) => {
		cleanupExpiredImageGenerationJobs();
		const jobIdentifier = context.req.param("jobId");
		if (!jobIdentifier) {
			return context.json({ errorMessage: "jobId is required." }, 400);
		}

		const imageGenerationJobRecord = imageGenerationJobsById.get(jobIdentifier);
		if (!imageGenerationJobRecord) {
			logSplatWarning("image-generation-job-not-found", {
				jobId: jobIdentifier,
			});
			return context.json(
				{
					errorMessage: "Image generation job was not found or has expired.",
				},
				404,
			);
		}

		return context.json(serializeJobForResponse(imageGenerationJobRecord));
	});
}
