import { SplatMesh } from "@sparkjsdev/spark";
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
	computeDepthQuantiles,
	computeMaxOffset,
} from "../trajectory/CameraMatrixUtils";
import { TrajectoryPlayer } from "../trajectory/TrajectoryPlayer";
import { createEyeTrajectory } from "../trajectory/trajectories";
import {
	DEFAULT_TRAJECTORY_PARAMS,
	type TrajectoryParams,
	type TrajectoryType,
} from "../trajectory/types";
import {
	estimateFocalLength,
	extractPlyPositions,
	type PlyMetadata,
	parsePlyMetadata,
} from "../utils/plyMetadata";

export interface ViewerOptions {
	container: HTMLElement;
	onLoad?: () => void;
	onError?: (error: Error) => void;
	onTrajectoryStateChange?: (state: "stopped" | "playing" | "paused") => void;
	onFrameChange?: (frame: number, total: number) => void;
	/** Called when metadata is loaded with image dimensions for aspect ratio */
	onAspectRatioChange?: (width: number, height: number) => void;
}

export class GaussianViewer {
	private container: HTMLElement;
	private scene: Scene;
	private camera: PerspectiveCamera;
	private renderer: WebGLRenderer;
	private controls: OrbitControls;
	private splatMesh: SplatMesh | null = null;
	private trajectoryPlayer: TrajectoryPlayer;
	private trajectoryParams: TrajectoryParams;
	private metadata: PlyMetadata | null = null;
	private positions: Float32Array | null = null; // Vertex positions for depth quantile computation
	private isDisposed = false;
	private animationFrameId: number | null = null;

	// Camera model state (matching Python's PinholeCameraModel)
	private lookAtTarget = new Vector3(0, 0, 0);
	private trajectoryOrigin = new Vector3(0, 0, 0);
	private cameraHomePosition = new Vector3(0, 0, 0);
	private depthFocus = 2.0;
	private minDepth = 1.0;
	private focalLength = 512; // Computed focal length (from metadata or estimated)

	private options: ViewerOptions;

	constructor(options: ViewerOptions) {
		this.options = options;
		this.container = options.container;

		// Initialize Three.js scene (no background - page background shows through)
		this.scene = new Scene();

		// Initialize camera with OpenCV coordinate convention (Y-down, Z-forward)
		// This matches SHARP PLY files which use OpenCV convention
		const aspect = this.container.clientWidth / this.container.clientHeight;
		this.camera = new PerspectiveCamera(45, aspect, 0.01, 500);
		this.camera.position.set(0, 0, -3);
		this.camera.up.set(0, -1, 0); // OpenCV: Y-down

		// Initialize renderer with transparent background
		this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(
			this.container.clientWidth,
			this.container.clientHeight,
		);
		this.container.appendChild(this.renderer.domElement);

		// Initialize orbit controls with OpenCV up vector
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.05;
		this.controls.target.copy(this.lookAtTarget);
		// Set controls to use same up vector as camera (Y-down)
		this.controls.object.up.set(0, -1, 0);

		// Initialize trajectory player
		this.trajectoryPlayer = new TrajectoryPlayer(30);
		this.trajectoryPlayer.onStateChange = (state) => {
			this.options.onTrajectoryStateChange?.(state);

			// Re-enable controls when trajectory stops
			if (state !== "playing") {
				this.controls.enabled = true;
			}
		};
		this.trajectoryPlayer.onFrameChange = (frame, total) => {
			this.options.onFrameChange?.(frame, total);
		};

		// Default trajectory params
		this.trajectoryParams = { ...DEFAULT_TRAJECTORY_PARAMS };

		// Handle resize
		window.addEventListener("resize", this.handleResize);

		// Start render loop
		this.animate();
	}

	private handleResize = (): void => {
		if (this.isDisposed) return;

		const width = this.container.clientWidth;
		const height = this.container.clientHeight;

		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
	};

	private animate = (): void => {
		if (this.isDisposed) return;

		this.animationFrameId = requestAnimationFrame(this.animate);

		// Update trajectory if playing
		if (this.trajectoryPlayer.isPlaying()) {
			const eyePosition = this.trajectoryPlayer.update(performance.now());
			if (eyePosition) {
				// Apply camera position from trajectory
				// The trajectory gives us eye positions in OpenCV convention
				// Three.js uses Y-up, so we need to convert
				this.applyCameraFromEyePosition(eyePosition);
			}
		} else {
			// Update orbit controls when not playing trajectory
			this.controls.update();
		}

		this.renderer.render(this.scene, this.camera);
	};

	/**
	 * Apply camera position from eye position, matching Python's PinholeCameraModel.compute()
	 *
	 * Since we're using OpenCV coordinate convention (Y-down) for the camera,
	 * no coordinate transformation is needed.
	 *
	 * In Python:
	 * - eye_pos is the camera position
	 * - look_at_position is [0, 0, depth_focus]
	 * - world_up is [0, -1, 0] (Y points down)
	 */
	private applyCameraFromEyePosition(eyePosition: Vector3): void {
		const worldSpaceEyePosition = eyePosition
			.clone()
			.add(this.trajectoryOrigin);
		this.camera.position.copy(worldSpaceEyePosition);
		this.camera.lookAt(this.lookAtTarget);
	}

	async loadPly(file: File): Promise<void> {
		try {
			// Remove existing splat mesh
			if (this.splatMesh) {
				this.scene.remove(this.splatMesh);
				this.splatMesh.dispose();
				this.splatMesh = null;
			}

			// Read file and parse metadata
			const buffer = await file.arrayBuffer();
			this.metadata = parsePlyMetadata(buffer);

			// Extract vertex positions for depth quantile computation (matching Python)
			this.positions = extractPlyPositions(buffer);

			// Create blob URL for Spark
			const blob = new Blob([buffer], { type: "application/octet-stream" });
			const url = URL.createObjectURL(blob);

			// Load with Spark
			this.splatMesh = new SplatMesh({ url });
			this.scene.add(this.splatMesh);

			// Wait for load to complete
			await this.splatMesh.initialized;

			URL.revokeObjectURL(url);

			// Compute depth quantiles and set up camera (matching Python)
			this.setupCameraForScene();

			// Generate initial trajectory
			this.generateTrajectory();

			this.options.onLoad?.();
		} catch (error) {
			console.error("[GaussianViewer] loadPly error:", error);
			const err = error instanceof Error ? error : new Error(String(error));
			this.options.onError?.(err);
			throw err;
		}
	}

	/**
	 * Set up camera to view the splat.
	 * Matches Python's PinholeCameraModel behavior:
	 * - Camera starts at origin (0, 0, 0)
	 * - Camera looks at (0, 0, depth_focus)
	 * - depth_focus = max(2.0, 10th percentile of scene depths)
	 * - FOV computed from focal length and image height
	 */
	private setupCameraForScene(): void {
		if (!this.splatMesh) return;
		const sceneBoundingBox = this.splatMesh.getBoundingBox(true);
		const sceneCenter = sceneBoundingBox.getCenter(new Vector3());
		const sceneSize = sceneBoundingBox.getSize(new Vector3());
		const maximumSceneExtent = Math.max(
			sceneSize.x,
			sceneSize.y,
			sceneSize.z,
			0.1,
		);

		// Compute depth quantiles from actual positions (matching Python's _compute_depth_quantiles)
		// Python uses: q_near=0.001 (0.1 percentile), q_focus=0.1 (10th percentile), q_far=0.999
		if (this.positions && this.positions.length > 0) {
			const depthQuantiles = computeDepthQuantiles(this.positions);
			this.minDepth = Math.max(0.1, depthQuantiles.min);
			// Python uses min_depth_focus=2.0 as floor for focus depth
			this.depthFocus = Math.max(2.0, depthQuantiles.focus);
		} else {
			// Fallback to bounding box if positions not available
			const minZ = sceneBoundingBox.min.z;
			const maxZ = sceneBoundingBox.max.z;
			this.minDepth = Math.max(0.1, minZ);
			this.depthFocus = Math.max(2.0, minZ + 0.1 * (maxZ - minZ));
		}

		// Compute FOV from metadata focal length and image height
		// Python: fov = 2 * atan(height / (2 * focal_length))
		if (this.metadata) {
			const [imageWidth, imageHeight] = this.metadata.imageSize;
			// Use metadata focal length, or estimate from image size if not available
			this.focalLength =
				this.metadata.focalLength > 0
					? this.metadata.focalLength
					: estimateFocalLength(this.metadata.imageSize);

			// Compute vertical FOV in degrees
			const fovY =
				2 * Math.atan(imageHeight / (2 * this.focalLength)) * (180 / Math.PI);
			this.camera.fov = fovY;
			// Don't set camera.aspect here - it will be set by resize() after frame updates
			this.camera.updateProjectionMatrix();

			// Notify about aspect ratio change for canvas resizing
			// The callback should call resize() after the DOM updates
			this.options.onAspectRatioChange?.(imageWidth, imageHeight);
		}

		if (this.metadata?.hasMetadata) {
			// SHARP metadata path: retain OpenCV-centric framing.
			this.cameraHomePosition.set(0, 0, 0);
			this.trajectoryOrigin.set(0, 0, 0);
			this.lookAtTarget.set(0, 0, this.depthFocus);
		} else {
			// Generic gaussian splat path: center camera on actual bounds to avoid "blank view".
			this.camera.fov = 50;
			this.camera.updateProjectionMatrix();
			const fallbackCameraDistance = Math.max(maximumSceneExtent * 2.2, 0.75);
			this.lookAtTarget.copy(sceneCenter);
			this.trajectoryOrigin.copy(sceneCenter);
			this.cameraHomePosition.set(
				sceneCenter.x,
				sceneCenter.y,
				sceneCenter.z + fallbackCameraDistance,
			);
		}

		this.camera.position.copy(this.cameraHomePosition);
		this.controls.target.copy(this.lookAtTarget);
		this.camera.lookAt(this.lookAtTarget);
		this.controls.update();
	}

	private generateTrajectory(): void {
		const offset = computeMaxOffset(
			this.minDepth,
			this.metadata?.imageSize ?? [640, 480],
			this.focalLength,
			this.trajectoryParams,
		);

		const positions = createEyeTrajectory(
			this.trajectoryParams.type,
			offset,
			this.trajectoryParams.distanceMeters,
			this.trajectoryParams.numSteps,
			this.trajectoryParams.numRepeats,
		);

		this.trajectoryPlayer.setTrajectory(positions);
	}

	setTrajectoryType(type: TrajectoryType): void {
		this.trajectoryParams.type = type;
		this.generateTrajectory();
	}

	updateTrajectoryParam<K extends keyof Omit<TrajectoryParams, "type">>(
		key: K,
		value: TrajectoryParams[K],
	): void {
		this.trajectoryParams[key] = value;
		if (this.splatMesh) {
			this.generateTrajectory();
		}
	}

	resetTrajectoryParams(): void {
		this.trajectoryParams = { ...DEFAULT_TRAJECTORY_PARAMS };
		if (this.splatMesh) {
			this.generateTrajectory();
		}
	}

	getTrajectoryParams(): TrajectoryParams {
		return { ...this.trajectoryParams };
	}

	play(): void {
		if (!this.splatMesh) return;
		this.controls.enabled = false;
		this.trajectoryPlayer.play();
	}

	pause(): void {
		this.trajectoryPlayer.pause();
		this.controls.enabled = true;
	}

	reset(): void {
		this.trajectoryPlayer.reset();
		if (!this.trajectoryPlayer.isPlaying()) {
			// Reset camera to initial position
			this.camera.position.copy(this.cameraHomePosition);
			this.camera.lookAt(this.lookAtTarget);
			this.controls.update();
		}
	}

	stop(): void {
		this.trajectoryPlayer.stop();
		this.controls.enabled = true;
	}

	getPlayerState(): "stopped" | "playing" | "paused" {
		return this.trajectoryPlayer.getState();
	}

	isLoaded(): boolean {
		return this.splatMesh !== null;
	}

	/** Manually trigger resize to sync camera/renderer with container size */
	resize(): void {
		this.handleResize();
	}

	dispose(): void {
		this.isDisposed = true;

		if (this.animationFrameId !== null) {
			cancelAnimationFrame(this.animationFrameId);
		}

		window.removeEventListener("resize", this.handleResize);

		if (this.splatMesh) {
			this.scene.remove(this.splatMesh);
			this.splatMesh.dispose();
		}

		this.controls.dispose();
		this.renderer.dispose();

		if (this.renderer.domElement.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
	}
}
