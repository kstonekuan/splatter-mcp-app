import {
	McpUseProvider,
	useWidget,
	useWidgetTheme,
	type WidgetMetadata,
} from "mcp-use/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
	DEFAULT_TRAJECTORY_PARAMS,
	type TrajectoryType,
} from "./trajectory/types";
import { type SplatViewerProps, splatViewerPropsSchema } from "./types";
import { GaussianViewer } from "./viewer/GaussianViewer";

export const widgetMetadata: WidgetMetadata = {
	description:
		"Render and interact with Gaussian splat PLY files with trajectory controls.",
	props: splatViewerPropsSchema,
	exposeAsTool: false,
};

const trajectoryTypeOptions: Array<{ label: string; value: TrajectoryType }> = [
	{ label: "Rotate Forward", value: "rotate_forward" },
	{ label: "Rotate", value: "rotate" },
	{ label: "Swipe", value: "swipe" },
	{ label: "Shake", value: "shake" },
	{ label: "Forward", value: "forward" },
];

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

export default function SplatViewerWidget(): React.ReactElement {
	const { props, isPending, displayMode, requestDisplayMode } =
		useWidget<SplatViewerProps>();
	const activeTheme = useWidgetTheme();
	const viewerContainerElementReference = useRef<HTMLDivElement | null>(null);
	const viewerInstanceReference = useRef<GaussianViewer | null>(null);

	const [viewerErrorMessage, setViewerErrorMessage] = useState<string | null>(
		null,
	);
	const [isModelLoading, setIsModelLoading] = useState(false);
	const [playerState, setPlayerState] = useState<
		"stopped" | "playing" | "paused"
	>("stopped");
	const [selectedTrajectoryType, setSelectedTrajectoryType] =
		useState<TrajectoryType>(DEFAULT_TRAJECTORY_PARAMS.type);
	const [maxDisparityValue, setMaxDisparityValue] = useState(
		DEFAULT_TRAJECTORY_PARAMS.maxDisparity,
	);
	const [maxZoomValue, setMaxZoomValue] = useState(
		DEFAULT_TRAJECTORY_PARAMS.maxZoom,
	);
	const [distanceMetersValue, setDistanceMetersValue] = useState(
		DEFAULT_TRAJECTORY_PARAMS.distanceMeters,
	);
	const [numStepsValue, setNumStepsValue] = useState(
		DEFAULT_TRAJECTORY_PARAMS.numSteps,
	);
	const [numRepeatsValue, setNumRepeatsValue] = useState(
		DEFAULT_TRAJECTORY_PARAMS.numRepeats,
	);

	useEffect(() => {
		if (
			!viewerContainerElementReference.current ||
			viewerInstanceReference.current
		) {
			return;
		}

		const viewerInstance = new GaussianViewer({
			container: viewerContainerElementReference.current,
			onLoad: () => {
				setIsModelLoading(false);
				setViewerErrorMessage(null);
			},
			onError: (errorValue: Error) => {
				setIsModelLoading(false);
				setViewerErrorMessage(errorValue.message);
			},
			onTrajectoryStateChange: (newStateValue) => {
				setPlayerState(newStateValue);
			},
		});
		viewerInstanceReference.current = viewerInstance;

		return () => {
			viewerInstance.dispose();
			viewerInstanceReference.current = null;
		};
	}, []);

	useEffect(() => {
		if (isPending || !viewerInstanceReference.current) {
			return;
		}

		let isCancelled = false;
		const loadPlyIntoViewer = async () => {
			setIsModelLoading(true);
			setViewerErrorMessage(null);

			try {
				const response = await fetch(props.plyAssetUrl);
				if (!response.ok) {
					throw new Error(
						`Failed to fetch PLY asset: HTTP ${response.status}.`,
					);
				}
				const plyBlob = await response.blob();
				const plyFile = new File([plyBlob], props.displayName, {
					type: "application/octet-stream",
				});
				await viewerInstanceReference.current?.loadPly(plyFile);

				if (isCancelled) {
					return;
				}

				const trajectoryParameters =
					viewerInstanceReference.current?.getTrajectoryParams();
				if (trajectoryParameters) {
					setSelectedTrajectoryType(trajectoryParameters.type);
					setMaxDisparityValue(trajectoryParameters.maxDisparity);
					setMaxZoomValue(trajectoryParameters.maxZoom);
					setDistanceMetersValue(trajectoryParameters.distanceMeters);
					setNumStepsValue(trajectoryParameters.numSteps);
					setNumRepeatsValue(trajectoryParameters.numRepeats);
				}
			} catch (errorValue) {
				if (!isCancelled) {
					setViewerErrorMessage(
						errorValue instanceof Error
							? errorValue.message
							: "Unknown error while loading PLY model.",
					);
					setIsModelLoading(false);
				}
			}
		};

		void loadPlyIntoViewer();

		return () => {
			isCancelled = true;
		};
	}, [isPending, props.displayName, props.plyAssetUrl]);

	const controlsAreDisabled =
		isPending || isModelLoading || !props.controlsEnabled;
	const panelStyleClassName = useMemo(
		() =>
			activeTheme === "dark"
				? "splat-viewer-root splat-viewer-theme-dark"
				: "splat-viewer-root",
		[activeTheme],
	);

	if (isPending) {
		return (
			<McpUseProvider autoSize>
				<div className={panelStyleClassName}>
					<div className="splat-viewer-loading-overlay">
						Preparing splat viewer...
					</div>
				</div>
			</McpUseProvider>
		);
	}

	return (
		<McpUseProvider autoSize>
			<div className={panelStyleClassName}>
				<div className="splat-viewer-header">
					<div>
						<div className="splat-viewer-title">{props.displayName}</div>
						<div className="splat-viewer-subtitle">
							Session {props.viewerSessionId.slice(0, 8)}
						</div>
					</div>
					<div className="splat-viewer-toolbar">
						{displayMode !== "pip" && (
							<button
								className="splat-viewer-button"
								type="button"
								onClick={() => requestDisplayMode("pip")}
							>
								PiP
							</button>
						)}
						{displayMode !== "fullscreen" && (
							<button
								className="splat-viewer-button"
								type="button"
								onClick={() => requestDisplayMode("fullscreen")}
							>
								Fullscreen
							</button>
						)}
						{displayMode !== "inline" && (
							<button
								className="splat-viewer-button"
								type="button"
								onClick={() => requestDisplayMode("inline")}
							>
								Inline
							</button>
						)}
					</div>
				</div>

				<div className="splat-viewer-canvas-wrapper">
					<div
						className="splat-viewer-canvas"
						ref={viewerContainerElementReference}
					/>
					{isModelLoading && (
						<div className="splat-viewer-loading-overlay">
							Loading PLY model...
						</div>
					)}
					{viewerErrorMessage && (
						<div className="splat-viewer-error-overlay">
							{viewerErrorMessage}
						</div>
					)}
				</div>

				<div className="splat-viewer-panel">
					<div className="splat-viewer-field">
						<label
							className="splat-viewer-label"
							htmlFor="trajectory-type-select"
						>
							Trajectory Type
						</label>
						<select
							id="trajectory-type-select"
							className="splat-viewer-select"
							disabled={controlsAreDisabled}
							value={selectedTrajectoryType}
							onChange={(event) => {
								const nextTrajectoryType = event.target.value as TrajectoryType;
								setSelectedTrajectoryType(nextTrajectoryType);
								viewerInstanceReference.current?.setTrajectoryType(
									nextTrajectoryType,
								);
							}}
						>
							{trajectoryTypeOptions.map((trajectoryOption) => (
								<option
									key={trajectoryOption.value}
									value={trajectoryOption.value}
								>
									{trajectoryOption.label}
								</option>
							))}
						</select>
					</div>

					<div className="splat-viewer-buttons">
						<button
							className="splat-viewer-button"
							type="button"
							disabled={controlsAreDisabled || playerState === "playing"}
							onClick={() => viewerInstanceReference.current?.play()}
						>
							Play
						</button>
						<button
							className="splat-viewer-button"
							type="button"
							disabled={controlsAreDisabled || playerState !== "playing"}
							onClick={() => viewerInstanceReference.current?.pause()}
						>
							Pause
						</button>
						<button
							className="splat-viewer-button"
							type="button"
							disabled={controlsAreDisabled}
							onClick={() => viewerInstanceReference.current?.reset()}
						>
							Reset
						</button>
					</div>

					<div className="splat-viewer-field">
						<label className="splat-viewer-label" htmlFor="max-disparity-input">
							Lateral Movement
						</label>
						<input
							id="max-disparity-input"
							className="splat-viewer-input"
							type="number"
							step="0.01"
							disabled={controlsAreDisabled}
							value={maxDisparityValue}
							onChange={(event) => {
								const parsedValue = Number.parseFloat(event.target.value);
								if (Number.isNaN(parsedValue)) {
									return;
								}
								setMaxDisparityValue(parsedValue);
								viewerInstanceReference.current?.updateTrajectoryParam(
									"maxDisparity",
									parsedValue,
								);
							}}
						/>
					</div>

					<div className="splat-viewer-field">
						<label className="splat-viewer-label" htmlFor="max-zoom-input">
							Forward Movement
						</label>
						<input
							id="max-zoom-input"
							className="splat-viewer-input"
							type="number"
							step="0.01"
							disabled={controlsAreDisabled}
							value={maxZoomValue}
							onChange={(event) => {
								const parsedValue = Number.parseFloat(event.target.value);
								if (Number.isNaN(parsedValue)) {
									return;
								}
								setMaxZoomValue(parsedValue);
								viewerInstanceReference.current?.updateTrajectoryParam(
									"maxZoom",
									parsedValue,
								);
							}}
						/>
					</div>

					<div className="splat-viewer-field">
						<label
							className="splat-viewer-label"
							htmlFor="distance-meters-input"
						>
							Z Offset
						</label>
						<input
							id="distance-meters-input"
							className="splat-viewer-input"
							type="number"
							step="0.01"
							disabled={controlsAreDisabled}
							value={distanceMetersValue}
							onChange={(event) => {
								const parsedValue = Number.parseFloat(event.target.value);
								if (Number.isNaN(parsedValue)) {
									return;
								}
								setDistanceMetersValue(parsedValue);
								viewerInstanceReference.current?.updateTrajectoryParam(
									"distanceMeters",
									parsedValue,
								);
							}}
						/>
					</div>

					<div className="splat-viewer-field">
						<label className="splat-viewer-label" htmlFor="num-steps-input">
							Frames per Cycle
						</label>
						<input
							id="num-steps-input"
							className="splat-viewer-input"
							type="number"
							step="1"
							min="1"
							disabled={controlsAreDisabled}
							value={numStepsValue}
							onChange={(event) => {
								const parsedValue = Number.parseInt(event.target.value, 10);
								if (Number.isNaN(parsedValue) || parsedValue < 1) {
									return;
								}
								setNumStepsValue(parsedValue);
								viewerInstanceReference.current?.updateTrajectoryParam(
									"numSteps",
									parsedValue,
								);
							}}
						/>
					</div>

					<div className="splat-viewer-field">
						<label className="splat-viewer-label" htmlFor="num-repeats-input">
							Loop Count
						</label>
						<input
							id="num-repeats-input"
							className="splat-viewer-input"
							type="number"
							step="1"
							min="1"
							disabled={controlsAreDisabled}
							value={numRepeatsValue}
							onChange={(event) => {
								const parsedValue = Number.parseInt(event.target.value, 10);
								if (Number.isNaN(parsedValue) || parsedValue < 1) {
									return;
								}
								setNumRepeatsValue(parsedValue);
								viewerInstanceReference.current?.updateTrajectoryParam(
									"numRepeats",
									parsedValue,
								);
							}}
						/>
					</div>
				</div>

				<div className="splat-viewer-meta">
					<div className="splat-viewer-meta-item">
						Size: {formatBytes(props.fileSizeBytes)}
					</div>
					<div className="splat-viewer-meta-item">
						Metadata: {props.metadata.hasMetadata ? "Present" : "Unavailable"}
					</div>
					{props.metadata.imageWidth && props.metadata.imageHeight && (
						<div className="splat-viewer-meta-item">
							Image: {props.metadata.imageWidth}x{props.metadata.imageHeight}
						</div>
					)}
					{props.generation && (
						<div className="splat-viewer-meta-item">
							Generated on {props.generation.gpuTier} in{" "}
							{Math.round(props.generation.elapsedMs)} ms
						</div>
					)}
				</div>
			</div>
		</McpUseProvider>
	);
}
