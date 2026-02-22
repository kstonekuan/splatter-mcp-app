import type { AllowedGpuTier, GeneratedSplatResult } from "../types/splat.js";
import { logSplatDebug, logSplatError } from "./splatLogger.js";

const DEFAULT_MODAL_INFERENCE_TIMEOUT_MILLISECONDS = 300_000;

interface ModalEndpointResponse {
	outputFilename: string;
	plyBytesBase64: string;
	elapsedMs: number;
}

function assertLooksLikePlyPayload(
	decodedPlyBytes: Uint8Array,
	outputFilename: string,
): void {
	if (decodedPlyBytes.byteLength === 0) {
		throw new Error(
			`Modal endpoint returned an empty PLY payload for ${outputFilename}.`,
		);
	}

	const headerPreviewText = new TextDecoder("utf-8").decode(
		decodedPlyBytes.slice(0, Math.min(16, decodedPlyBytes.byteLength)),
	);
	if (!headerPreviewText.startsWith("ply")) {
		throw new Error(
			`Modal endpoint returned non-PLY bytes for ${outputFilename}. Header preview: ${JSON.stringify(headerPreviewText)}.`,
		);
	}
}

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

function parsePositiveFloatEnvironmentValue(
	environmentVariableValue: string | undefined,
	fallbackValue: number,
): number {
	const parsedValue = Number.parseFloat(environmentVariableValue ?? "");
	if (Number.isNaN(parsedValue) || parsedValue <= 0) {
		return fallbackValue;
	}
	return parsedValue;
}

function resolveTimeoutMilliseconds(): number {
	const timeoutMillisecondsOverride = parsePositiveIntegerEnvironmentValue(
		process.env["SHARP_MODAL_TIMEOUT_MS"],
		-1,
	);
	if (timeoutMillisecondsOverride > 0) {
		return timeoutMillisecondsOverride;
	}

	const timeoutSecondsValue = parsePositiveFloatEnvironmentValue(
		process.env["SHARP_MODAL_TIMEOUT_SECONDS"],
		DEFAULT_MODAL_INFERENCE_TIMEOUT_MILLISECONDS / 1000,
	);
	return Math.round(timeoutSecondsValue * 1000);
}

function resolveModalEndpointUrlFromEnvironment(): string {
	const modalEndpointUrlFromEnvironment =
		process.env["SHARP_MODAL_ENDPOINT_URL"]?.trim() ?? "";
	if (!modalEndpointUrlFromEnvironment) {
		throw new Error(
			"SHARP_MODAL_ENDPOINT_URL is not configured. Set it to your deployed Modal generate_splat_from_image endpoint URL.",
		);
	}

	try {
		return new URL(modalEndpointUrlFromEnvironment).toString();
	} catch {
		throw new Error(
			`SHARP_MODAL_ENDPOINT_URL is not a valid URL: ${modalEndpointUrlFromEnvironment}`,
		);
	}
}

export class ModalInferenceClient {
	private readonly timeoutMilliseconds: number;

	public constructor() {
		this.timeoutMilliseconds = resolveTimeoutMilliseconds();
	}

	public async generateSplatFromImage(
		imageBytes: Uint8Array,
		filename: string,
		gpuTier: AllowedGpuTier,
	): Promise<GeneratedSplatResult> {
		const requestAbortController = new AbortController();
		const timeoutTimer = setTimeout(() => {
			requestAbortController.abort();
		}, this.timeoutMilliseconds);
		const modalEndpointUrl = resolveModalEndpointUrlFromEnvironment();
		const requestStartedAtMilliseconds = Date.now();

		try {
			logSplatDebug("modal-request-start", {
				modalEndpointUrl,
				filename,
				gpuTier,
				timeoutMilliseconds: this.timeoutMilliseconds,
				imageByteLength: imageBytes.byteLength,
			});

			const response = await fetch(modalEndpointUrl, {
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
			});

			if (!response.ok) {
				const errorResponseText = await response.text();
				logSplatError(
					"modal-request-non-200",
					new Error(`HTTP ${response.status}`),
					{
						modalEndpointUrl,
						filename,
						gpuTier,
						statusCode: response.status,
						errorResponseTextPreview: errorResponseText.slice(0, 1_000),
					},
				);
				throw new Error(
					`Modal inference request failed with HTTP ${response.status}: ${errorResponseText}`,
				);
			}

			const modalEndpointResponse =
				(await response.json()) as ModalEndpointResponse;
			if (
				typeof modalEndpointResponse.outputFilename !== "string" ||
				typeof modalEndpointResponse.plyBytesBase64 !== "string" ||
				typeof modalEndpointResponse.elapsedMs !== "number"
			) {
				throw new Error(
					"Modal endpoint response did not match expected schema.",
				);
			}

			const decodedPlyBytes = new Uint8Array(
				Buffer.from(modalEndpointResponse.plyBytesBase64, "base64"),
			);
			assertLooksLikePlyPayload(
				decodedPlyBytes,
				modalEndpointResponse.outputFilename,
			);
			logSplatDebug("modal-request-success", {
				modalEndpointUrl,
				filename,
				gpuTier,
				returnedFilename: modalEndpointResponse.outputFilename,
				elapsedMsReportedByModal: modalEndpointResponse.elapsedMs,
				decodedPlyByteLength: decodedPlyBytes.byteLength,
				roundTripDurationMs: Date.now() - requestStartedAtMilliseconds,
			});

			return {
				outputFilename: modalEndpointResponse.outputFilename,
				plyBytes: decodedPlyBytes,
				elapsedMs: modalEndpointResponse.elapsedMs,
			};
		} catch (modalClientErrorValue) {
			logSplatError("modal-request-failed", modalClientErrorValue, {
				modalEndpointUrl,
				filename,
				gpuTier,
				roundTripDurationMs: Date.now() - requestStartedAtMilliseconds,
			});
			throw modalClientErrorValue;
		} finally {
			clearTimeout(timeoutTimer);
		}
	}
}

export const modalInferenceClient = new ModalInferenceClient();
