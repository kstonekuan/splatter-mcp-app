from __future__ import annotations

import binascii
from base64 import b64decode
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

AllowedGpuTier = Literal["t4", "l4", "a10", "a100", "h100"]


class GenerateSplatRequest(BaseModel):
    imageBytesBase64: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=512)
    gpuTier: AllowedGpuTier = "a10"

    @field_validator("imageBytesBase64")
    @classmethod
    def validate_base64_payload(cls, base64_payload: str) -> str:
        try:
            decoded_bytes = b64decode(base64_payload, validate=True)
        except (binascii.Error, ValueError) as base64_error:
            raise ValueError("imageBytesBase64 must be valid base64 data.") from base64_error

        if not decoded_bytes:
            raise ValueError("imageBytesBase64 must not decode to an empty payload.")
        return base64_payload

    @field_validator("filename")
    @classmethod
    def normalize_filename(cls, filename_value: str) -> str:
        normalized_filename = Path(filename_value).name.strip()
        if not normalized_filename:
            raise ValueError("filename must include at least one visible character.")
        return normalized_filename


class GenerateSplatResponse(BaseModel):
    outputFilename: str = Field(min_length=1)
    plyBytesBase64: str = Field(min_length=1)
    elapsedMs: float = Field(ge=0)
