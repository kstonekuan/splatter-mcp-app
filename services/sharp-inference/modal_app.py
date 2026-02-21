from __future__ import annotations

import binascii
import logging
import subprocess
import time
from base64 import b64decode, b64encode
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal
from urllib.request import urlretrieve

import modal
from pydantic import BaseModel, Field, field_validator

LOGGER = logging.getLogger(__name__)

APP_NAME = "sharp-mcp-inference"
MODEL_CACHE_VOLUME_NAME = "sharp-model-cache"
MODEL_CACHE_DIRECTORY = "/cache/models"
MODEL_CHECKPOINT_URL = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
MODEL_CHECKPOINT_FILENAME = "sharp_2572gikvuh.pt"
INFERENCE_TIMEOUT_SECONDS = 900

AllowedGpuTier = Literal["t4", "l4", "a10", "a100", "h100"]

modal_app = modal.App(name=APP_NAME)
model_cache_volume = modal.Volume.from_name(
    MODEL_CACHE_VOLUME_NAME,
    create_if_missing=True,
)
modal_runtime_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git")
    .pip_install("fastapi[standard]>=0.115.0", "pillow-heif>=1.1.1")
    .run_commands("pip install git+https://github.com/kstonekuan/ml-sharp-web-viewer.git")
)


class ModalGenerateSplatRequest(BaseModel):
    imageBytesBase64: str = Field(min_length=1)
    filename: str = Field(min_length=1)
    gpuTier: AllowedGpuTier = "a10"

    @field_validator("imageBytesBase64")
    @classmethod
    def validate_base64_payload(cls, encoded_image_bytes: str) -> str:
        try:
            decoded_image_bytes = b64decode(encoded_image_bytes, validate=True)
        except (binascii.Error, ValueError) as decode_error:
            raise ValueError("imageBytesBase64 must be valid base64.") from decode_error

        if not decoded_image_bytes:
            raise ValueError("imageBytesBase64 cannot be empty.")
        return encoded_image_bytes

    @field_validator("filename")
    @classmethod
    def normalize_filename(cls, input_filename: str) -> str:
        sanitized_filename = Path(input_filename).name.strip()
        if not sanitized_filename:
            raise ValueError("filename must contain visible characters.")
        return sanitized_filename


class ModalGenerateSplatResponse(BaseModel):
    outputFilename: str
    plyBytesBase64: str
    elapsedMs: float


@modal_app.function(
    image=modal_runtime_image,
    gpu="t4",
    timeout=INFERENCE_TIMEOUT_SECONDS,
    volumes={MODEL_CACHE_DIRECTORY: model_cache_volume},
)
def predict_gaussian_splat_t4(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    return _predict_with_sharp_cli(image_bytes=image_bytes, filename=filename)


@modal_app.function(
    image=modal_runtime_image,
    gpu="l4",
    timeout=INFERENCE_TIMEOUT_SECONDS,
    volumes={MODEL_CACHE_DIRECTORY: model_cache_volume},
)
def predict_gaussian_splat_l4(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    return _predict_with_sharp_cli(image_bytes=image_bytes, filename=filename)


@modal_app.function(
    image=modal_runtime_image,
    gpu="a10",
    timeout=INFERENCE_TIMEOUT_SECONDS,
    volumes={MODEL_CACHE_DIRECTORY: model_cache_volume},
)
def predict_gaussian_splat_a10(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    return _predict_with_sharp_cli(image_bytes=image_bytes, filename=filename)


@modal_app.function(
    image=modal_runtime_image,
    gpu="a100",
    timeout=INFERENCE_TIMEOUT_SECONDS,
    volumes={MODEL_CACHE_DIRECTORY: model_cache_volume},
)
def predict_gaussian_splat_a100(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    return _predict_with_sharp_cli(image_bytes=image_bytes, filename=filename)


@modal_app.function(
    image=modal_runtime_image,
    gpu="h100",
    timeout=INFERENCE_TIMEOUT_SECONDS,
    volumes={MODEL_CACHE_DIRECTORY: model_cache_volume},
)
def predict_gaussian_splat_h100(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    return _predict_with_sharp_cli(image_bytes=image_bytes, filename=filename)


@modal_app.function(
    image=modal_runtime_image,
    timeout=INFERENCE_TIMEOUT_SECONDS,
)
@modal.fastapi_endpoint(method="POST", docs=True)
def generate_splat_from_image(
    request_payload: ModalGenerateSplatRequest,
) -> ModalGenerateSplatResponse:
    request_started_at_seconds = time.perf_counter()
    image_bytes = b64decode(request_payload.imageBytesBase64)
    predict_function = get_predict_function_for_gpu_tier(request_payload.gpuTier)

    output_filename, output_ply_bytes = predict_function.remote(
        image_bytes=image_bytes,
        filename=request_payload.filename,
    )
    elapsed_milliseconds = round(
        (time.perf_counter() - request_started_at_seconds) * 1000,
        2,
    )
    return ModalGenerateSplatResponse(
        outputFilename=output_filename,
        plyBytesBase64=b64encode(output_ply_bytes).decode("ascii"),
        elapsedMs=elapsed_milliseconds,
    )


def get_predict_function_for_gpu_tier(gpu_tier: AllowedGpuTier):
    predict_function_by_gpu_tier = {
        "t4": predict_gaussian_splat_t4,
        "l4": predict_gaussian_splat_l4,
        "a10": predict_gaussian_splat_a10,
        "a100": predict_gaussian_splat_a100,
        "h100": predict_gaussian_splat_h100,
    }
    return predict_function_by_gpu_tier[gpu_tier]


def _predict_with_sharp_cli(image_bytes: bytes, filename: str) -> tuple[str, bytes]:
    model_checkpoint_path = _ensure_model_checkpoint_cached()
    input_filename = Path(filename).name or "uploaded-image.jpg"

    with TemporaryDirectory(prefix="sharp-inference-") as temporary_directory_path_string:
        temporary_directory_path = Path(temporary_directory_path_string)
        input_directory_path = temporary_directory_path / "inputs"
        output_directory_path = temporary_directory_path / "outputs"
        input_directory_path.mkdir(parents=True, exist_ok=True)
        output_directory_path.mkdir(parents=True, exist_ok=True)

        input_image_path = input_directory_path / input_filename
        input_image_path.write_bytes(image_bytes)

        predict_command = [
            "sharp",
            "predict",
            "-i",
            str(input_image_path),
            "-o",
            str(output_directory_path),
            "-c",
            str(model_checkpoint_path),
        ]
        LOGGER.info("Running command: %s", " ".join(predict_command))
        completed_process = subprocess.run(
            predict_command,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed_process.returncode != 0:
            raise RuntimeError(
                "SHARP prediction failed with non-zero exit code: "
                f"{completed_process.returncode}\n"
                f"stdout:\n{completed_process.stdout}\n"
                f"stderr:\n{completed_process.stderr}"
            )

        default_output_path = output_directory_path / f"{input_image_path.stem}.ply"
        if default_output_path.exists():
            return default_output_path.name, default_output_path.read_bytes()

        matching_ply_paths = sorted(output_directory_path.glob("*.ply"))
        if not matching_ply_paths:
            raise RuntimeError(
                "SHARP prediction did not produce a .ply output file in the output directory."
            )
        selected_output_path = matching_ply_paths[0]
        return selected_output_path.name, selected_output_path.read_bytes()


def _ensure_model_checkpoint_cached() -> Path:
    model_cache_directory_path = Path(MODEL_CACHE_DIRECTORY)
    model_cache_directory_path.mkdir(parents=True, exist_ok=True)
    model_checkpoint_path = model_cache_directory_path / MODEL_CHECKPOINT_FILENAME
    if model_checkpoint_path.exists():
        return model_checkpoint_path

    LOGGER.info("Downloading SHARP checkpoint from %s", MODEL_CHECKPOINT_URL)
    urlretrieve(MODEL_CHECKPOINT_URL, model_checkpoint_path)
    model_cache_volume.commit()
    return model_checkpoint_path
