from __future__ import annotations

from fastapi import FastAPI, HTTPException

from .modal_adapter import (
    InferenceConfigurationError,
    InferenceUpstreamError,
    ModalSharpInferenceAdapter,
)
from .schemas import GenerateSplatRequest, GenerateSplatResponse

app = FastAPI(
    title="SHARP Inference Adapter",
    version="0.1.0",
    description="Bridges MCP TypeScript tools to a Modal-hosted ML-SHARP generation endpoint.",
)
modal_sharp_inference_adapter = ModalSharpInferenceAdapter()


@app.get("/healthz")
async def get_healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/generate-splat", response_model=GenerateSplatResponse)
async def generate_splat_from_image(
    generation_request: GenerateSplatRequest,
) -> GenerateSplatResponse:
    try:
        return await modal_sharp_inference_adapter.generate_splat_from_image(generation_request)
    except InferenceConfigurationError as configuration_error:
        raise HTTPException(
            status_code=503, detail=str(configuration_error)
        ) from configuration_error
    except InferenceUpstreamError as upstream_error:
        raise HTTPException(status_code=502, detail=str(upstream_error)) from upstream_error
