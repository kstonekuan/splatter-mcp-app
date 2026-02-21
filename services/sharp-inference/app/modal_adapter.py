from __future__ import annotations

import os
import time
from base64 import b64encode
from pathlib import Path
from struct import pack

import httpx

from .schemas import GenerateSplatRequest, GenerateSplatResponse

DEFAULT_MODAL_TIMEOUT_SECONDS = 300.0


class InferenceConfigurationError(RuntimeError):
    """Raised when inference cannot run because service configuration is incomplete."""


class InferenceUpstreamError(RuntimeError):
    """Raised when the upstream Modal service fails or returns invalid data."""


class ModalSharpInferenceAdapter:
    def __init__(self) -> None:
        self._modal_endpoint_url = os.getenv("SHARP_MODAL_ENDPOINT_URL", "").strip()
        self._request_timeout_seconds = _parse_positive_float(
            os.getenv("SHARP_MODAL_TIMEOUT_SECONDS"),
            DEFAULT_MODAL_TIMEOUT_SECONDS,
        )
        self._allow_mock_inference = _parse_boolean_environment_variable(
            os.getenv("SHARP_ALLOW_MOCK_INFERENCE"),
        )

    async def generate_splat_from_image(
        self,
        inference_request: GenerateSplatRequest,
    ) -> GenerateSplatResponse:
        if self._modal_endpoint_url:
            return await self._generate_from_modal_endpoint(inference_request)

        if self._allow_mock_inference:
            return self._generate_mock_splat(inference_request)

        raise InferenceConfigurationError(
            "SHARP_MODAL_ENDPOINT_URL is not configured. Set SHARP_ALLOW_MOCK_INFERENCE=true "
            "for a local placeholder response."
        )

    async def _generate_from_modal_endpoint(
        self,
        inference_request: GenerateSplatRequest,
    ) -> GenerateSplatResponse:
        request_started_at_seconds = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self._request_timeout_seconds) as http_client:
                modal_response = await http_client.post(
                    self._modal_endpoint_url,
                    json=inference_request.model_dump(),
                )
        except httpx.HTTPError as request_error:
            raise InferenceUpstreamError(
                f"Failed to reach Modal endpoint: {request_error}"
            ) from request_error

        if modal_response.status_code >= 400:
            raise InferenceUpstreamError(
                f"Modal endpoint returned HTTP {modal_response.status_code}: {modal_response.text}"
            )

        try:
            response_payload = modal_response.json()
        except ValueError as response_parse_error:
            raise InferenceUpstreamError(
                "Modal endpoint response was not valid JSON."
            ) from response_parse_error

        if not isinstance(response_payload, dict):
            raise InferenceUpstreamError("Modal endpoint response must be a JSON object.")

        response_payload.setdefault(
            "outputFilename",
            f"{Path(inference_request.filename).stem}.ply",
        )
        response_payload.setdefault(
            "elapsedMs",
            round((time.perf_counter() - request_started_at_seconds) * 1000, 2),
        )

        try:
            return GenerateSplatResponse.model_validate(response_payload)
        except Exception as schema_error:
            raise InferenceUpstreamError(
                "Modal endpoint response did not match expected schema."
            ) from schema_error

    def _generate_mock_splat(
        self,
        inference_request: GenerateSplatRequest,
    ) -> GenerateSplatResponse:
        mock_ply_bytes = _build_single_point_ply_bytes()
        generated_filename = f"{Path(inference_request.filename).stem}-mock.ply"
        return GenerateSplatResponse(
            outputFilename=generated_filename,
            plyBytesBase64=b64encode(mock_ply_bytes).decode("ascii"),
            elapsedMs=5.0,
        )


def _build_single_point_ply_bytes() -> bytes:
    ascii_header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "element vertex 1\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "end_header\n"
    ).encode("ascii")
    vertex_payload = pack("<fff", 0.0, 0.0, 2.0)
    return ascii_header + vertex_payload


def _parse_positive_float(raw_value: str | None, fallback_value: float) -> float:
    if not raw_value:
        return fallback_value

    try:
        parsed_value = float(raw_value)
    except ValueError:
        return fallback_value

    if parsed_value <= 0:
        return fallback_value
    return parsed_value


def _parse_boolean_environment_variable(raw_value: str | None) -> bool:
    if raw_value is None:
        return False
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}
