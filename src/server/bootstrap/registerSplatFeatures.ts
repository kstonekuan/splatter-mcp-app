import type { MCPServer } from "mcp-use/server";
import { registerSplatArtifactRoutes } from "../routes/artifacts.js";
import { registerImageGenerationJobRoutes } from "../routes/imageGenerationJobs.js";
import { registerSplatUploadRoutes } from "../routes/uploads.js";
import { registerWidgetDiagnosticsRoutes } from "../routes/widgetDiagnostics.js";
import { temporaryArtifactStore } from "../services/tempArtifactStore.js";
import { registerGenerateSplatFromImageTool } from "../tools/generateSplatFromImageTool.js";
import { registerOpenPlyUploadTool } from "../tools/openPlyUploadTool.js";
import { registerViewPlySplatTool } from "../tools/viewPlySplatTool.js";

let hasRegisteredSplatFeatures = false;

export async function registerSplatFeatures(
	serverInstance: MCPServer,
): Promise<void> {
	if (hasRegisteredSplatFeatures) {
		return;
	}
	hasRegisteredSplatFeatures = true;

	await temporaryArtifactStore.initialize();
	registerSplatArtifactRoutes(serverInstance);
	registerImageGenerationJobRoutes(serverInstance);
	registerSplatUploadRoutes(serverInstance);
	registerWidgetDiagnosticsRoutes(serverInstance);
	registerOpenPlyUploadTool(serverInstance);
	registerViewPlySplatTool(serverInstance);
	registerGenerateSplatFromImageTool(serverInstance);
}
