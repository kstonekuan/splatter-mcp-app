interface SplatLogContext {
	[key: string]: unknown;
}

function isDebugLoggingEnabled(): boolean {
	const normalizedFlag =
		process.env["SPLAT_DEBUG_LOGS"]?.trim().toLowerCase() ?? "";
	return ["1", "true", "yes", "on"].includes(normalizedFlag);
}

export function logSplatDebug(
	eventName: string,
	logContext: SplatLogContext,
): void {
	if (!isDebugLoggingEnabled()) {
		return;
	}
	console.info(`[splat-debug] ${eventName}`, logContext);
}

export function logSplatInfo(
	eventName: string,
	logContext: SplatLogContext,
): void {
	console.info(`[splat-info] ${eventName}`, logContext);
}

export function logSplatWarning(
	eventName: string,
	logContext: SplatLogContext,
): void {
	console.warn(`[splat-warning] ${eventName}`, logContext);
}

export function logSplatError(
	eventName: string,
	errorValue: unknown,
	logContext: SplatLogContext = {},
): void {
	const errorMessage =
		errorValue instanceof Error ? errorValue.message : String(errorValue);
	const errorStack = errorValue instanceof Error ? errorValue.stack : undefined;
	console.error(`[splat-error] ${eventName}`, {
		...logContext,
		errorMessage,
		errorStack,
	});
}
