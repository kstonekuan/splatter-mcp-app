import {
	McpUseProvider,
	useCallTool,
	useWidget,
	useWidgetTheme,
	type WidgetMetadata,
} from "mcp-use/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { GaussianViewer } from "../splat-viewer/viewer/GaussianViewer";
import {
	type SplatUploadWidgetProps,
	splatUploadWidgetPropsSchema,
	uploadPlyResponseSchema,
} from "./types";

export const widgetMetadata: WidgetMetadata = {
	description:
		"Upload a .ply file directly to this MCP server and open it in the splat viewer.",
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

export default function SplatUploadWidget(): React.ReactElement {
	const { props, isPending } = useWidget<SplatUploadWidgetProps>();
	const activeTheme = useWidgetTheme();
	const { callToolAsync: callViewPlySplatToolAsync, isPending: isToolPending } =
		useCallTool<Record<string, unknown>, Record<string, unknown>>(
			"view-ply-splat",
		);

	const [selectedPlyFile, setSelectedPlyFile] = useState<File | null>(null);
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

	const rootClassName = useMemo(
		() =>
			activeTheme === "dark"
				? "splat-upload-root splat-upload-theme-dark"
				: "splat-upload-root",
		[activeTheme],
	);
	const uploadInProgress = isUploadingFile || isToolPending;

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
			},
		});
		viewerInstanceReference.current = viewerInstance;

		return () => {
			viewerInstance.dispose();
			viewerInstanceReference.current = null;
		};
	}, [inlineViewerPlyAssetUrl]);

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
					throw new Error(
						`Failed to fetch inline PLY asset: HTTP ${assetResponse.status}.`,
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
				<div className={rootClassName}>Preparing upload widget...</div>
			</McpUseProvider>
		);
	}

	return (
		<McpUseProvider autoSize>
			<div className={rootClassName}>
				<h2 className="splat-upload-heading">Upload PLY Splat</h2>
				<p className="splat-upload-subtitle">
					Direct upload to MCP server. Max size:{" "}
					{formatBytes(props.maximumPlyBytes)}.
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

						if (!selectedPlyFile) {
							setErrorMessage("Select a .ply file first.");
							return;
						}

						if (selectedPlyFile.size > props.maximumPlyBytes) {
							setErrorMessage(
								`File is too large. Maximum supported size is ${formatBytes(props.maximumPlyBytes)}.`,
							);
							return;
						}

						setIsUploadingFile(true);
						setStatusMessage("Uploading file to MCP server...");

						try {
							const uploadFormData = new FormData();
							uploadFormData.append(
								"file",
								selectedPlyFile,
								selectedPlyFile.name,
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
								uploadPlyResponseSchema.safeParse(uploadResponseBody);
							if (!uploadResponseValidationResult.success) {
								throw new Error(
									"Upload response did not match expected schema.",
								);
							}

							setStatusMessage("Upload complete. Opening viewer...");
							const toolCallResponse = await callViewPlySplatToolAsync({
								sourceType: "url",
								plyUrl: uploadResponseValidationResult.data.artifactUrl,
								displayName: uploadResponseValidationResult.data.displayName,
							});
							const inlineViewerProps =
								parseViewerPropsFromToolResponse(toolCallResponse);
							if (inlineViewerProps) {
								setInlineViewerPlyAssetUrl(inlineViewerProps.plyAssetUrl);
								setInlineViewerDisplayName(inlineViewerProps.displayName);
							}
							setStatusMessage(
								"Viewer opened successfully for uploaded PLY artifact.",
							);
						} catch (uploadOrRenderErrorValue) {
							setErrorMessage(
								uploadOrRenderErrorValue instanceof Error
									? uploadOrRenderErrorValue.message
									: "Unknown upload or render failure.",
							);
						} finally {
							setIsUploadingFile(false);
						}
					}}
				>
					<label className="splat-upload-label" htmlFor="ply-upload-input">
						Select .ply file
					</label>
					<label
						className="splat-upload-file-button"
						htmlFor="ply-upload-input"
						aria-disabled={uploadInProgress ? "true" : "false"}
					>
						Choose PLY File
					</label>
					<input
						id="ply-upload-input"
						className="splat-upload-input"
						type="file"
						accept=".ply"
						disabled={uploadInProgress}
						onChange={(eventValue) => {
							const candidateFile = eventValue.target.files?.[0] ?? null;
							setSelectedPlyFile(candidateFile);
							setErrorMessage("");
							setStatusMessage("");
						}}
					/>
					<div className="splat-upload-selected-file">
						{selectedPlyFile
							? `Selected: ${selectedPlyFile.name}`
							: "No file selected yet."}
					</div>

					<button
						className="splat-upload-button"
						type="submit"
						disabled={uploadInProgress || !selectedPlyFile}
					>
						{uploadInProgress ? "Uploading..." : "Upload and Open Viewer"}
					</button>
				</form>

				{statusMessage.length > 0 && (
					<div className="splat-upload-status splat-upload-status-success">
						{statusMessage}
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
								Loading PLY model...
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
