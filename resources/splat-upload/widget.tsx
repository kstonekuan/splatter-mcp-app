import { LoadingIndicator } from "@openai/apps-sdk-ui/components/Indicator";
import {
	McpUseProvider,
	useCallTool,
	useWidget,
	useWidgetTheme,
	type WidgetMetadata,
} from "mcp-use/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import "./styles.css";
import { GaussianViewer } from "../splat-viewer/viewer/GaussianViewer";
import {
	type SplatUploadWidgetProps,
	splatUploadWidgetPropsSchema,
	uploadSplatAssetResponseSchema,
} from "./types";

type UploadedAssetType = "ply" | "image";

const SUPPORTED_IMAGE_FILE_EXTENSIONS = new Set([
	".avif",
	".bmp",
	".gif",
	".heic",
	".heif",
	".jpeg",
	".jpg",
	".png",
	".tif",
	".tiff",
	".webp",
]);

export const widgetMetadata: WidgetMetadata = {
	description:
		"Upload either a Gaussian splat .ply or an image directly to this MCP server, then render with Splatter.",
	props: splatUploadWidgetPropsSchema,
	exposeAsTool: false,
};

function formatBytes(byteCount: number): string {
	if (byteCount < 1024) {
		return `${byteCount} B`;
	}
	const kilobyteCount = byteCount / 1024;
	if (kilobyteCount < 1024) {
		return `${kilobyteCount.toFixed(1)} KB`;
	}
	const megabyteCount = kilobyteCount / 1024;
	return `${megabyteCount.toFixed(2)} MB`;
}

function extractLowerCaseFileExtension(uploadedFilename: string): string {
	const lastDotIndex = uploadedFilename.lastIndexOf(".");
	if (lastDotIndex < 0) {
		return "";
	}
	return uploadedFilename.slice(lastDotIndex).toLowerCase();
}

function detectUploadedAssetType(
	candidateFile: File | null,
): UploadedAssetType | null {
	if (!candidateFile) {
		return null;
	}

	const extractedFileExtension = extractLowerCaseFileExtension(
		candidateFile.name,
	);
	if (extractedFileExtension === ".ply") {
		return "ply";
	}

	const normalizedMimeType = candidateFile.type.toLowerCase();
	if (
		normalizedMimeType.startsWith("image/") ||
		SUPPORTED_IMAGE_FILE_EXTENSIONS.has(extractedFileExtension)
	) {
		return "image";
	}

	return null;
}

function inferExpectedMaximumUploadBytes(
	uploadedAssetType: UploadedAssetType,
	widgetProps: SplatUploadWidgetProps,
): number {
	return uploadedAssetType === "ply"
		? widgetProps.maximumPlyBytes
		: widgetProps.maximumImageBytes;
}

function deriveGeneratedPlyDisplayNameFromImageFileName(
	imageFileName: string,
): string {
	const trimmedImageFileName = imageFileName.trim();
	if (trimmedImageFileName.length === 0) {
		return "generated-splat.ply";
	}

	const lastDotIndex = trimmedImageFileName.lastIndexOf(".");
	const baseImageName =
		lastDotIndex > 0
			? trimmedImageFileName.slice(0, lastDotIndex)
			: trimmedImageFileName;
	return `${baseImageName}.ply`;
}

interface WidgetErrorReportContext {
	assetUrl?: string;
	displayName?: string;
	additionalContext?: Record<string, unknown>;
}

interface SpinnerWithLabelProps {
	spinnerClassName?: string;
	label: string;
}

function SpinnerWithLabel({
	spinnerClassName,
	label,
}: SpinnerWithLabelProps): React.ReactElement {
	return (
		<>
			<LoadingIndicator
				aria-hidden="true"
				size={14}
				strokeWidth={2}
				className={`splat-upload-spinner${spinnerClassName ? ` ${spinnerClassName}` : ""}`}
			/>
			<span>{label}</span>
		</>
	);
}

async function reportWidgetErrorToServer(
	eventName: string,
	errorMessage: string,
	errorReportContext: WidgetErrorReportContext,
): Promise<void> {
	try {
		await fetch("/diagnostics/widget-error", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				widgetName: "splat-upload",
				eventName,
				errorMessage,
				assetUrl: errorReportContext.assetUrl,
				displayName: errorReportContext.displayName,
				additionalContext: errorReportContext.additionalContext,
			}),
		});
	} catch (errorValue) {
		console.error("[splat-upload] failed to report widget error", {
			eventName,
			errorMessage,
			reportingErrorMessage:
				errorValue instanceof Error ? errorValue.message : String(errorValue),
		});
	}
}

function parseViewerPropsFromToolResponse(
	toolResponseValue: Record<string, unknown>,
): { plyAssetUrl: string; displayName: string } | null {
	const structuredContentValue = toolResponseValue["structuredContent"];
	if (!structuredContentValue || typeof structuredContentValue !== "object") {
		return null;
	}

	const structuredContentRecord = structuredContentValue as Record<
		string,
		unknown
	>;
	const plyAssetUrlValue = structuredContentRecord["plyAssetUrl"];
	const displayNameValue = structuredContentRecord["displayName"];
	if (
		typeof plyAssetUrlValue !== "string" ||
		typeof displayNameValue !== "string"
	) {
		return null;
	}

	return {
		plyAssetUrl: plyAssetUrlValue,
		displayName: displayNameValue,
	};
}

const imageGenerationJobStatusSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
]);

const imageGenerationJobStartResponseSchema = z.object({
	jobId: z.string(),
	status: imageGenerationJobStatusSchema,
	statusEndpointUrl: z.string(),
});

const imageGenerationJobStatusResponseSchema = z.object({
	jobId: z.string(),
	status: imageGenerationJobStatusSchema,
	errorMessage: z.string().nullable().optional(),
	outputArtifactId: z.string().nullable().optional(),
	outputArtifactUrl: z.string().nullable().optional(),
	outputDisplayName: z.string().nullable().optional(),
	outputFileSizeBytes: z.number().int().nonnegative().nullable().optional(),
});

function normalizeUnknownErrorMessage(errorValue: unknown): string {
	if (errorValue instanceof Error && errorValue.message.trim().length > 0) {
		return errorValue.message;
	}
	if (typeof errorValue === "string" && errorValue.trim().length > 0) {
		return errorValue;
	}
	if (typeof errorValue === "object" && errorValue !== null) {
		const errorRecord = errorValue as Record<string, unknown>;
		const messageValue = errorRecord["message"];
		if (typeof messageValue === "string" && messageValue.trim().length > 0) {
			return messageValue;
		}
		try {
			const serializedErrorRecord = JSON.stringify(errorRecord);
			if (serializedErrorRecord.trim().length > 0) {
				return serializedErrorRecord;
			}
		} catch {
			// Fall through to generic message.
		}
	}
	return "Unknown upload or render failure.";
}

async function delayForMilliseconds(delayMilliseconds: number): Promise<void> {
	await new Promise((resolveDelay) => {
		setTimeout(resolveDelay, delayMilliseconds);
	});
}

async function waitForImageGenerationJobCompletion(
	jobStatusEndpointUrl: string,
	onStatusMessageUpdate: (statusMessage: string) => void,
): Promise<z.infer<typeof imageGenerationJobStatusResponseSchema>> {
	const maximumPollingAttempts = 360;
	const pollingIntervalMilliseconds = 2_000;
	for (
		let pollingAttemptIndex = 0;
		pollingAttemptIndex < maximumPollingAttempts;
		pollingAttemptIndex += 1
	) {
		const jobStatusResponse = await fetch(jobStatusEndpointUrl, {
			cache: "no-store",
		});
		const jobStatusResponseBody = (await jobStatusResponse
			.json()
			.catch(() => null)) as Record<string, unknown> | null;
		if (!jobStatusResponse.ok) {
			const reportedErrorMessage =
				typeof jobStatusResponseBody?.["errorMessage"] === "string"
					? jobStatusResponseBody["errorMessage"]
					: `Failed to poll generation job: HTTP ${jobStatusResponse.status}.`;
			throw new Error(reportedErrorMessage);
		}

		const parsedJobStatusResult =
			imageGenerationJobStatusResponseSchema.safeParse(jobStatusResponseBody);
		if (!parsedJobStatusResult.success) {
			throw new Error("Image generation job status response was invalid.");
		}

		const imageGenerationJobStatus = parsedJobStatusResult.data;
		if (imageGenerationJobStatus.status === "succeeded") {
			return imageGenerationJobStatus;
		}
		if (imageGenerationJobStatus.status === "failed") {
			throw new Error(
				imageGenerationJobStatus.errorMessage ??
					"Image generation job failed without an error message.",
			);
		}

		onStatusMessageUpdate(
			`Generating splat from image... (${pollingAttemptIndex + 1}/${maximumPollingAttempts})`,
		);
		await delayForMilliseconds(pollingIntervalMilliseconds);
	}

	throw new Error("Image generation timed out while polling job status.");
}

export default function SplatUploadWidget(): React.ReactElement {
	const { props, isPending } = useWidget<SplatUploadWidgetProps>();
	const activeTheme = useWidgetTheme();
	const {
		callToolAsync: callViewPlySplatToolAsync,
		isPending: isViewPlySplatToolPending,
	} = useCallTool<Record<string, unknown>, Record<string, unknown>>(
		"view-ply-splat",
	);

	const [selectedUploadFile, setSelectedUploadFile] = useState<File | null>(
		null,
	);
	const [statusMessage, setStatusMessage] = useState<string>("");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isUploadingFile, setIsUploadingFile] = useState(false);
	const [inlineViewerPlyAssetUrl, setInlineViewerPlyAssetUrl] = useState<
		string | null
	>(null);
	const [inlineViewerDisplayName, setInlineViewerDisplayName] = useState<
		string | null
	>(null);
	const [isInlineViewerLoading, setIsInlineViewerLoading] = useState(false);
	const [inlineViewerErrorMessage, setInlineViewerErrorMessage] = useState<
		string | null
	>(null);
	const viewerContainerElementReference = useRef<HTMLDivElement | null>(null);
	const viewerInstanceReference = useRef<GaussianViewer | null>(null);

	const selectedUploadAssetType = detectUploadedAssetType(selectedUploadFile);
	const rootClassName = useMemo(
		() =>
			activeTheme === "dark"
				? "splat-upload-root splat-upload-theme-dark"
				: "splat-upload-root",
		[activeTheme],
	);
	const uploadInProgress = isUploadingFile || isViewPlySplatToolPending;

	useEffect(() => {
		if (
			!inlineViewerPlyAssetUrl ||
			!viewerContainerElementReference.current ||
			viewerInstanceReference.current
		) {
			return;
		}

		const viewerInstance = new GaussianViewer({
			container: viewerContainerElementReference.current,
			onLoad: () => {
				setIsInlineViewerLoading(false);
				setInlineViewerErrorMessage(null);
			},
			onError: (errorValue: Error) => {
				setIsInlineViewerLoading(false);
				setInlineViewerErrorMessage(errorValue.message);
				console.error("[splat-upload] inline gaussian viewer error", {
					errorMessage: errorValue.message,
					assetUrl: inlineViewerPlyAssetUrl,
					displayName: inlineViewerDisplayName,
				});
				void reportWidgetErrorToServer(
					"inline-gaussian-viewer-error",
					errorValue.message,
					{
						assetUrl: inlineViewerPlyAssetUrl ?? undefined,
						displayName: inlineViewerDisplayName ?? undefined,
					},
				);
			},
		});
		viewerInstanceReference.current = viewerInstance;

		return () => {
			viewerInstance.dispose();
			viewerInstanceReference.current = null;
		};
	}, [inlineViewerDisplayName, inlineViewerPlyAssetUrl]);

	useEffect(() => {
		if (!inlineViewerPlyAssetUrl || !viewerInstanceReference.current) {
			return;
		}

		let hasCancelledLoad = false;
		const loadInlineViewerAsset = async () => {
			setIsInlineViewerLoading(true);
			setInlineViewerErrorMessage(null);
			try {
				const assetResponse = await fetch(inlineViewerPlyAssetUrl);
				if (!assetResponse.ok) {
					const responseBodyPreview = (await assetResponse.text()).slice(
						0,
						400,
					);
					throw new Error(
						`Failed to fetch inline PLY asset: HTTP ${assetResponse.status}. ${responseBodyPreview}`,
					);
				}
				const plyBlob = await assetResponse.blob();
				const plyFile = new File(
					[plyBlob],
					inlineViewerDisplayName ?? "uploaded.ply",
					{
						type: "application/octet-stream",
					},
				);
				await viewerInstanceReference.current?.loadPly(plyFile);
				if (hasCancelledLoad) {
					return;
				}
				setStatusMessage(
					"Viewer rendered below. If ChatGPT does not open a second widget card, use the inline viewer here.",
				);
			} catch (inlineViewerErrorValue) {
				if (hasCancelledLoad) {
					return;
				}
				setIsInlineViewerLoading(false);
				setInlineViewerErrorMessage(
					inlineViewerErrorValue instanceof Error
						? inlineViewerErrorValue.message
						: "Unknown inline viewer error.",
				);
				const normalizedErrorMessage =
					inlineViewerErrorValue instanceof Error
						? inlineViewerErrorValue.message
						: "Unknown inline viewer error.";
				console.error("[splat-upload] inline viewer load failed", {
					errorMessage: normalizedErrorMessage,
					assetUrl: inlineViewerPlyAssetUrl,
					displayName: inlineViewerDisplayName,
				});
				void reportWidgetErrorToServer(
					"inline-load-ply-failed",
					normalizedErrorMessage,
					{
						assetUrl: inlineViewerPlyAssetUrl ?? undefined,
						displayName: inlineViewerDisplayName ?? undefined,
					},
				);
			}
		};

		void loadInlineViewerAsset();
		return () => {
			hasCancelledLoad = true;
		};
	}, [inlineViewerDisplayName, inlineViewerPlyAssetUrl]);

	if (isPending) {
		return (
			<McpUseProvider autoSize>
				<div className={rootClassName}>
					<div className="splat-upload-loading-inline">
						<SpinnerWithLabel label="Preparing upload widget..." />
					</div>
				</div>
			</McpUseProvider>
		);
	}

	return (
		<McpUseProvider autoSize>
			<div className={rootClassName}>
				<h2 className="splat-upload-heading">Upload Asset for Splatter</h2>
				<p className="splat-upload-subtitle">
					Upload either a Gaussian splat .ply or an image. Max PLY size:{" "}
					{formatBytes(props.maximumPlyBytes)}. Max image size:{" "}
					{formatBytes(props.maximumImageBytes)}.
				</p>

				<form
					className="splat-upload-form"
					onSubmit={async (eventValue) => {
						eventValue.preventDefault();
						setErrorMessage("");
						setStatusMessage("");
						setInlineViewerErrorMessage(null);
						setInlineViewerPlyAssetUrl(null);
						setInlineViewerDisplayName(null);

						if (!selectedUploadFile) {
							setErrorMessage("Select a .ply or image file first.");
							return;
						}

						const detectedUploadAssetType =
							detectUploadedAssetType(selectedUploadFile);
						if (!detectedUploadAssetType) {
							setErrorMessage(
								"Unsupported file type. Upload either a Gaussian splat .ply or an image file.",
							);
							return;
						}

						const maximumAllowedBytes = inferExpectedMaximumUploadBytes(
							detectedUploadAssetType,
							props,
						);
						if (selectedUploadFile.size > maximumAllowedBytes) {
							setErrorMessage(
								`File is too large. Maximum ${detectedUploadAssetType} size is ${formatBytes(maximumAllowedBytes)}.`,
							);
							return;
						}

						setIsUploadingFile(true);
						setStatusMessage("Uploading file to MCP server...");

						try {
							const uploadFormData = new FormData();
							uploadFormData.append(
								"file",
								selectedUploadFile,
								selectedUploadFile.name,
							);

							const uploadResponse = await fetch(props.uploadEndpointUrl, {
								method: "POST",
								body: uploadFormData,
							});
							const uploadResponseBody = (await uploadResponse
								.json()
								.catch(() => null)) as Record<string, unknown> | null;
							if (!uploadResponse.ok) {
								const uploadErrorMessage =
									typeof uploadResponseBody?.["error"] === "string"
										? uploadResponseBody["error"]
										: `Upload failed with HTTP ${uploadResponse.status}.`;
								throw new Error(uploadErrorMessage);
							}

							const uploadResponseValidationResult =
								uploadSplatAssetResponseSchema.safeParse(uploadResponseBody);
							if (!uploadResponseValidationResult.success) {
								throw new Error(
									"Upload response did not match expected schema.",
								);
							}

							const uploadedAsset = uploadResponseValidationResult.data;
							let toolCallResponse: Record<string, unknown>;
							if (uploadedAsset.uploadedAssetType === "ply") {
								setStatusMessage("PLY uploaded. Opening viewer...");
								toolCallResponse = await callViewPlySplatToolAsync({
									sourceType: "url",
									plyUrl: uploadedAsset.artifactUrl,
									displayName: uploadedAsset.displayName,
								});
								setStatusMessage(
									"Viewer opened successfully for uploaded PLY artifact.",
								);
							} else {
								setStatusMessage(
									"Image uploaded. Starting image-to-splat generation job...",
								);
								const imageGenerationJobStartResponse = await fetch(
									props.imageGenerationStartEndpointUrl,
									{
										method: "POST",
										headers: {
											"content-type": "application/json",
										},
										body: JSON.stringify({
											imageArtifactId: uploadedAsset.artifactId,
											displayName:
												deriveGeneratedPlyDisplayNameFromImageFileName(
													uploadedAsset.displayName,
												),
										}),
									},
								);
								const imageGenerationJobStartBody =
									(await imageGenerationJobStartResponse
										.json()
										.catch(() => null)) as Record<string, unknown> | null;
								if (!imageGenerationJobStartResponse.ok) {
									const startJobErrorMessage =
										typeof imageGenerationJobStartBody?.["errorMessage"] ===
										"string"
											? imageGenerationJobStartBody["errorMessage"]
											: `Failed to start image generation job: HTTP ${imageGenerationJobStartResponse.status}.`;
									throw new Error(startJobErrorMessage);
								}
								const parsedImageGenerationJobStartResult =
									imageGenerationJobStartResponseSchema.safeParse(
										imageGenerationJobStartBody,
									);
								if (!parsedImageGenerationJobStartResult.success) {
									throw new Error(
										"Image generation job start response was invalid.",
									);
								}

								const completedImageGenerationJob =
									await waitForImageGenerationJobCompletion(
										parsedImageGenerationJobStartResult.data.statusEndpointUrl,
										setStatusMessage,
									);
								const generatedPlyArtifactUrl =
									completedImageGenerationJob.outputArtifactUrl;
								const generatedPlyDisplayName =
									completedImageGenerationJob.outputDisplayName;
								if (
									typeof generatedPlyArtifactUrl !== "string" ||
									typeof generatedPlyDisplayName !== "string"
								) {
									throw new Error(
										"Image generation completed but did not return generated PLY artifact details.",
									);
								}

								setStatusMessage(
									"Splat generation completed. Opening viewer...",
								);
								toolCallResponse = await callViewPlySplatToolAsync({
									sourceType: "url",
									plyUrl: generatedPlyArtifactUrl,
									displayName: generatedPlyDisplayName,
								});
								setInlineViewerPlyAssetUrl(generatedPlyArtifactUrl);
								setInlineViewerDisplayName(generatedPlyDisplayName);
								setStatusMessage(
									"Image uploaded, splat generated, and viewer opened.",
								);
							}

							const inlineViewerProps =
								parseViewerPropsFromToolResponse(toolCallResponse);
							if (inlineViewerProps) {
								setInlineViewerPlyAssetUrl(inlineViewerProps.plyAssetUrl);
								setInlineViewerDisplayName(inlineViewerProps.displayName);
							}
						} catch (uploadOrRenderErrorValue) {
							const normalizedErrorMessage = normalizeUnknownErrorMessage(
								uploadOrRenderErrorValue,
							);
							setErrorMessage(normalizedErrorMessage);
							console.error("[splat-upload] upload/render failed", {
								errorMessage: normalizedErrorMessage,
								selectedFilename: selectedUploadFile.name,
								selectedAssetType: selectedUploadAssetType,
								selectedFileSizeBytes: selectedUploadFile.size,
								rawErrorValue: uploadOrRenderErrorValue,
							});
							void reportWidgetErrorToServer(
								"upload-or-render-failed",
								normalizedErrorMessage,
								{
									displayName: selectedUploadFile.name,
									additionalContext: {
										selectedAssetType: selectedUploadAssetType,
										selectedFileSizeBytes: selectedUploadFile.size,
										rawErrorValue:
											typeof uploadOrRenderErrorValue === "object" &&
											uploadOrRenderErrorValue !== null
												? uploadOrRenderErrorValue
												: String(uploadOrRenderErrorValue),
									},
								},
							);
						} finally {
							setIsUploadingFile(false);
						}
					}}
				>
					<label className="splat-upload-label" htmlFor="asset-upload-input">
						Select .ply or image file
					</label>
					<label
						className="splat-upload-file-button"
						htmlFor="asset-upload-input"
						aria-disabled={uploadInProgress ? "true" : "false"}
					>
						Choose File
					</label>
					<input
						id="asset-upload-input"
						className="splat-upload-input"
						type="file"
						accept=".ply,image/*"
						disabled={uploadInProgress}
						onChange={(eventValue) => {
							const candidateFile = eventValue.target.files?.[0] ?? null;
							setSelectedUploadFile(candidateFile);
							setErrorMessage("");
							setStatusMessage("");
						}}
					/>
					<div className="splat-upload-selected-file">
						{selectedUploadFile
							? `Selected: ${selectedUploadFile.name} (${selectedUploadAssetType ?? "unknown"} · ${formatBytes(selectedUploadFile.size)})`
							: "No file selected yet."}
					</div>

					<button
						className="splat-upload-button"
						type="submit"
						disabled={uploadInProgress || !selectedUploadFile}
					>
						{uploadInProgress ? (
							<span className="splat-upload-button-content">
								<SpinnerWithLabel
									spinnerClassName="splat-upload-spinner-button"
									label="Processing..."
								/>
							</span>
						) : selectedUploadAssetType === "image" ? (
							"Upload and Generate Splat"
						) : (
							"Upload and Open Viewer"
						)}
					</button>
				</form>

				{statusMessage.length > 0 && (
					<div className="splat-upload-status splat-upload-status-success">
						{uploadInProgress ? (
							<SpinnerWithLabel
								spinnerClassName="splat-upload-spinner-status"
								label={statusMessage}
							/>
						) : (
							statusMessage
						)}
					</div>
				)}
				{errorMessage.length > 0 && (
					<div className="splat-upload-status splat-upload-status-error">
						{errorMessage}
					</div>
				)}

				{inlineViewerPlyAssetUrl && (
					<div className="splat-upload-inline-viewer-section">
						<div className="splat-upload-inline-viewer-title">
							Inline Viewer: {inlineViewerDisplayName ?? "uploaded.ply"}
						</div>
						<div
							className="splat-upload-inline-viewer-frame"
							ref={viewerContainerElementReference}
						/>
						{isInlineViewerLoading && (
							<div className="splat-upload-inline-viewer-overlay">
								<SpinnerWithLabel label="Loading PLY model..." />
							</div>
						)}
						{inlineViewerErrorMessage && (
							<div className="splat-upload-inline-viewer-overlay splat-upload-inline-viewer-overlay-error">
								{inlineViewerErrorMessage}
							</div>
						)}
					</div>
				)}
			</div>
		</McpUseProvider>
	);
}
