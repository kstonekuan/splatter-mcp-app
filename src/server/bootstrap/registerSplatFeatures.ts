import type { MCPServer } from "mcp-use/server";
import { registerSplatArtifactRoutes } from "../routes/artifacts";
import { registerImageGenerationJobRoutes } from "../routes/imageGenerationJobs";
import { registerSplatUploadRoutes } from "../routes/uploads";
import { registerWidgetDiagnosticsRoutes } from "../routes/widgetDiagnostics";
import { temporaryArtifactStore } from "../services/tempArtifactStore";
import { registerGenerateSplatFromImageTool } from "../tools/generateSplatFromImageTool";
import { registerOpenPlyUploadTool } from "../tools/openPlyUploadTool";
import { registerViewPlySplatTool } from "../tools/viewPlySplatTool";

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
