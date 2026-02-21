import type { MCPServer } from "mcp-use/server";
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
			return context.text("Artifact identifier is required.", 400);
		}

		const storedArtifact =
			await temporaryArtifactStore.getArtifactIfAvailable(artifactIdentifier);
		if (!storedArtifact) {
			return context.text("Artifact not found or expired.", 404);
		}

		const artifactBytes = await temporaryArtifactStore.readArtifactBytes(
			storedArtifact.artifactId,
		);
		if (!artifactBytes) {
			return context.text("Artifact not found or expired.", 404);
		}

		return new Response(Buffer.from(artifactBytes), {
			headers: {
				"content-type": storedArtifact.mimeType,
				"cache-control": "no-store, max-age=0",
				"content-disposition": `inline; filename="${storedArtifact.displayName}"`,
			},
		});
	});
}
