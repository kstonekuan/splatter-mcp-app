# MCP Splat Viewer App (mcp-use)

`README.md` at the repository root is the canonical documentation for this project.

This MCP server includes:

- `open-ply-upload`: open a widget that uploads `.ply` directly to this MCP server, then opens the viewer
- `view-ply-splat`: render an uploaded or URL-based `.ply` file in an interactive widget
- `generate-splat-from-image`: send one image to a Python service that forwards inference to Modal, then render the returned `.ply`

## TypeScript Server

```bash
pnpm install
pnpm run dev
```

The inspector URL is printed at startup (look for `[INSPECTOR]`), usually
`http://localhost:3000/inspector`. If port `3000` is already in use, `mcp-use`
automatically selects the next available port.

For direct local file uploads in ChatGPT, call `open-ply-upload` and use the
widget file picker. This bypasses ChatGPT file-ID resolution and uploads
straight to `POST /uploads/ply` on this server.

## Python Inference Service (Stage 2)

```bash
cd services/sharp-inference
uv sync
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Environment variables:

- `SHARP_MODAL_ENDPOINT_URL` (required for real inference)
- `SHARP_MODAL_TIMEOUT_SECONDS` (optional, default `300`)
- `SHARP_ALLOW_MOCK_INFERENCE` (optional, default `false`)

The TypeScript server calls `POST /v1/generate-splat` on `PYTHON_INFERENCE_BASE_URL` (default `http://127.0.0.1:8001`).

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
