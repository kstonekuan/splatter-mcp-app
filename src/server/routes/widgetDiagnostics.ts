import type { MCPServer } from "mcp-use/server";
import { logSplatError, logSplatInfo } from "../services/splatLogger.js";

interface WidgetErrorReportPayload {
	widgetName?: unknown;
	eventName?: unknown;
	errorMessage?: unknown;
	assetUrl?: unknown;
	displayName?: unknown;
	additionalContext?: unknown;
}

function toCappedString(value: unknown, maximumLength: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		return null;
	}
	return trimmedValue.slice(0, maximumLength);
}

let hasRegisteredWidgetDiagnosticsRoutes = false;

export function registerWidgetDiagnosticsRoutes(
	serverInstance: MCPServer,
): void {
	if (hasRegisteredWidgetDiagnosticsRoutes) {
		return;
	}
	hasRegisteredWidgetDiagnosticsRoutes = true;

	serverInstance.app.post("/diagnostics/widget-error", async (context) => {
		try {
			const requestPayload =
				(await context.req.json()) as WidgetErrorReportPayload;
			const widgetNameValue =
				toCappedString(requestPayload.widgetName, 120) ?? "unknown-widget";
			const eventNameValue =
				toCappedString(requestPayload.eventName, 120) ?? "unknown-event";
			const errorMessageValue =
				toCappedString(requestPayload.errorMessage, 4_000) ??
				"No error message provided.";
			const assetUrlValue = toCappedString(requestPayload.assetUrl, 2_000);
			const displayNameValue = toCappedString(requestPayload.displayName, 260);

			logSplatError("widget-client-error", new Error(errorMessageValue), {
				widgetName: widgetNameValue,
				eventName: eventNameValue,
				assetUrl: assetUrlValue,
				displayName: displayNameValue,
				additionalContext:
					requestPayload.additionalContext &&
					typeof requestPayload.additionalContext === "object"
						? requestPayload.additionalContext
						: undefined,
			});

			return context.json({ ok: true });
		} catch (errorValue) {
			logSplatInfo("widget-client-error-invalid-payload", {
				errorMessage:
					errorValue instanceof Error ? errorValue.message : String(errorValue),
			});
			return context.json({ ok: false }, 400);
		}
	});
}
