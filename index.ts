import { MCPServer } from "mcp-use/server";
import { registerSplatFeatures } from "./src/server/bootstrap/registerSplatFeatures";

const server = new MCPServer({
	name: "manufact-hack",
	title: "manufact-hack", // display name
	version: "1.0.0",
	description: "MCP server with MCP Apps integration",
	baseUrl: process.env["MCP_URL"] || "http://localhost:3000", // Full base URL (e.g., https://myserver.com)
	favicon: "favicon.ico",
	websiteUrl: "https://mcp-use.com", // Can be customized later
	icons: [
		{
			src: "icon.svg",
			mimeType: "image/svg+xml",
			sizes: ["512x512"],
		},
	],
});

try {
	await registerSplatFeatures(server);
} catch (startupError) {
	console.error("Failed to register MCP server features:", startupError);
	throw startupError;
}
