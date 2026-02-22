# Splatter MCP App

MCP app built with `mcp-use` for 3D Gaussian splatting.

## Introduction

This app is a lightweight spatial review layer for teams that need to move from source media to interactive 3D quickly.

Best fit for:

- Media and virtual production teams
- Design and creative studios
- Architecture / AEC teams
- Real estate and experience design teams

## Features

- Upload `.ply` and view instantly in an interactive widget.
- Upload an image and generate a splat via Modal (async job flow).
- View from URL or ChatGPT attachment references.
- Artifact hosting with TTL and diagnostic logging for failures.

## Tools Exposed

- `open-ply-upload`: opens upload widget (recommended entrypoint).
- `view-ply-splat`: render an existing `.ply`.
- `generate-splat-from-image`: direct image-to-splat tool path.

## Local Development

```bash
pnpm install
pnpm run dev
```

For ChatGPT connector testing:

```bash
pnpm run dev -- --tunnel
```

## Environment Variables

- `SHARP_MODAL_ENDPOINT_URL` (required): deployed Modal image-to-splat endpoint.
- `SHARP_MODAL_TIMEOUT_MS` (optional, default `300000`).
- `SHARP_MODAL_TIMEOUT_SECONDS` (optional fallback).
- `MCP_URL` (recommended for tunnel/deployed absolute URLs).

## Modal Backend

Deploy from `services/sharp-inference`:

```bash
cd services/sharp-inference
uv run modal token new
uv run modal deploy modal_app.py::modal_app
```

## Quality Checks

```bash
pnpm check
cd services/sharp-inference
uv run ruff check --fix
uv run ruff format
uv run ty check
```

## Troubleshooting

- Viewer not opening after generation: check logs for
  - `[splat-error] widget-client-error`
  - `[splat-warning] artifact-get-not-found`
  - `[splat-info] image-generation-job-succeeded`
- Wrong asset URLs in widgets/tools: set `MCP_URL` to the externally reachable base URL.
- Tunnel subdomain conflict: stop old tunnel processes and restart.
