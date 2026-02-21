import type { MCPServer } from "mcp-use/server";
import { logSplatInfo, logSplatWarning } from "../services/splatLogger";
import { temporaryArtifactStore } from "../services/tempArtifactStore";

let hasRegisteredArtifactRoutes = false;

export function registerSplatArtifactRoutes(serverInstance: MCPServer): void {
	if (hasRegisteredArtifactRoutes) {
		return;
	}
	hasRegisteredArtifactRoutes = true;

	serverInstance.app.get("/artifacts/:artifactId", async (context) => {
		const artifactIdentifier = context.req.param("artifactId");
		if (!artifactIdentifier) {
			logSplatWarning("artifact-get-missing-id", {
				requestPath: context.req.path,
			});
			return context.text("Artifact identifier is required.", 400);
		}

		const storedArtifact =
			await temporaryArtifactStore.getArtifactIfAvailable(artifactIdentifier);
		if (!storedArtifact) {
			logSplatWarning("artifact-get-not-found", {
				artifactId: artifactIdentifier,
				requestPath: context.req.path,
			});
			return context.text("Artifact not found or expired.", 404);
		}

		const artifactBytes = await temporaryArtifactStore.readArtifactBytes(
			storedArtifact.artifactId,
		);
		if (!artifactBytes) {
			logSplatWarning("artifact-bytes-not-found", {
				artifactId: artifactIdentifier,
				absoluteFilePath: storedArtifact.absoluteFilePath,
			});
			return context.text("Artifact not found or expired.", 404);
		}
		logSplatInfo("artifact-get-success", {
			artifactId: storedArtifact.artifactId,
			mimeType: storedArtifact.mimeType,
			fileSizeBytes: storedArtifact.fileSizeBytes,
		});

		return new Response(Buffer.from(artifactBytes), {
			headers: {
				"content-type": storedArtifact.mimeType,
				"cache-control": "no-store, max-age=0",
				"content-disposition": `inline; filename="${storedArtifact.displayName}"`,
			},
		});
	});
}
