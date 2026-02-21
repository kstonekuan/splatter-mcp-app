import type {
	AllowedGpuTier,
	PythonSplatGenerationResult,
} from "../types/splat";

const DEFAULT_INFERENCE_SERVICE_BASE_URL = "http://127.0.0.1:8001";
const DEFAULT_INFERENCE_SERVICE_TIMEOUT_MILLISECONDS = 300_000;

interface InferenceServiceResponse {
	outputFilename: string;
	plyBytesBase64: string;
	elapsedMs: number;
}

function parsePositiveIntegerValue(
	environmentVariableValue: string | undefined,
	fallbackValue: number,
): number {
	const parsedValue = Number.parseInt(environmentVariableValue ?? "", 10);
	if (Number.isNaN(parsedValue) || parsedValue <= 0) {
		return fallbackValue;
	}
	return parsedValue;
}

export class PythonInferenceClient {
	private readonly inferenceServiceBaseUrl: string;
	private readonly timeoutMilliseconds: number;

	public constructor() {
		this.inferenceServiceBaseUrl =
			process.env["PYTHON_INFERENCE_BASE_URL"] ??
			DEFAULT_INFERENCE_SERVICE_BASE_URL;
		this.timeoutMilliseconds = parsePositiveIntegerValue(
			process.env["PYTHON_INFERENCE_TIMEOUT_MS"],
			DEFAULT_INFERENCE_SERVICE_TIMEOUT_MILLISECONDS,
		);
	}

	public async generateSplatFromImage(
		imageBytes: Uint8Array,
		filename: string,
		gpuTier: AllowedGpuTier,
	): Promise<PythonSplatGenerationResult> {
		const requestAbortController = new AbortController();
		const timeoutTimer = setTimeout(() => {
			requestAbortController.abort();
		}, this.timeoutMilliseconds);

		try {
			const response = await fetch(
				new URL("/v1/generate-splat", this.inferenceServiceBaseUrl),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify({
						imageBytesBase64: Buffer.from(imageBytes).toString("base64"),
						filename,
						gpuTier,
					}),
					signal: requestAbortController.signal,
				},
			);

			if (!response.ok) {
				const errorResponseText = await response.text();
				throw new Error(
					`Inference service request failed with HTTP ${response.status}: ${errorResponseText}`,
				);
			}

			const inferenceServiceResponse =
				(await response.json()) as InferenceServiceResponse;
			if (
				typeof inferenceServiceResponse.outputFilename !== "string" ||
				typeof inferenceServiceResponse.plyBytesBase64 !== "string" ||
				typeof inferenceServiceResponse.elapsedMs !== "number"
			) {
				throw new Error(
					"Inference service response did not match expected schema.",
				);
			}

			return {
				outputFilename: inferenceServiceResponse.outputFilename,
				plyBytes: new Uint8Array(
					Buffer.from(inferenceServiceResponse.plyBytesBase64, "base64"),
				),
				elapsedMs: inferenceServiceResponse.elapsedMs,
			};
		} finally {
			clearTimeout(timeoutTimer);
		}
	}
}

export const pythonInferenceClient = new PythonInferenceClient();
