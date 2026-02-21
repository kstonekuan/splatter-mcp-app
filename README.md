# MCP Splat Viewer App (mcp-use)

`README.md` at the repository root is the canonical documentation for this project.

This MCP server includes:

- `open-ply-upload`: open a widget that uploads either a `.ply` or source image directly to this MCP server, then renders/generates
- `view-ply-splat`: render an uploaded or URL-based `.ply` file in an interactive widget
- `generate-splat-from-image`: send one image directly to a Modal endpoint, then render the returned `.ply`

## TypeScript Server

```bash
pnpm install
pnpm run dev
```

The inspector URL is printed at startup (look for `[INSPECTOR]`), usually
`http://localhost:3000/inspector`. If port `3000` is already in use, `mcp-use`
automatically selects the next available port.

For direct local file uploads in ChatGPT, call `open-ply-upload` and use the
widget file picker. It accepts:

- `.ply` uploads: stored and rendered directly
- image uploads: stored, then passed to `generate-splat-from-image`

This bypasses ChatGPT file-ID resolution and uploads straight to
`POST /uploads/asset` on this server.

## Modal Endpoint Configuration

Environment variables for the TypeScript MCP server:

- `SHARP_MODAL_ENDPOINT_URL` (required): full URL to the deployed Modal `generate_splat_from_image` endpoint
- `SHARP_MODAL_TIMEOUT_MS` (optional, default `300000`)
- `SHARP_MODAL_TIMEOUT_SECONDS` (optional compatibility fallback if `SHARP_MODAL_TIMEOUT_MS` is unset, default `300`)

The TypeScript server calls `SHARP_MODAL_ENDPOINT_URL` directly.

Deploy the Modal backend endpoint:

```bash
cd services/sharp-inference
uv run modal token new
uv run modal deploy modal_app.py
```

## Quality Checks

TypeScript:

```bash
pnpm check
```

Python:

```bash
cd services/sharp-inference
uv run ruff check --fix
uv run ruff format
uv run ty check
```

## Related Repository

This implementation references:

- `ml-sharp-web-viewer`: https://github.com/kstonekuan/ml-sharp-web-viewer
- Modal inference pattern: `src/sharp/modal/app.py`
- Modal runtime image pattern: `src/sharp/modal/image.py`
- Viewer trajectory/camera behavior mirrored in this app’s `resources/splat-viewer/*`
