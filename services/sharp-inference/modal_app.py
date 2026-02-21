from __future__ import annotations

import binascii
import logging
import re
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
    input_filename = _normalize_input_filename_for_sharp(
        raw_filename=filename,
        image_bytes=image_bytes,
    )

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

        selected_output_path = _resolve_generated_ply_output_path(
            output_directory_path=output_directory_path,
            temporary_directory_path=temporary_directory_path,
            expected_output_stem=input_image_path.stem,
            command_stdout=completed_process.stdout,
            command_stderr=completed_process.stderr,
        )
        if selected_output_path is None:
            output_directory_tree = _format_directory_tree(output_directory_path)
            temporary_directory_tree = _format_directory_tree(temporary_directory_path)
            raise RuntimeError(
                "SHARP prediction did not produce a .ply output file.\n"
                f"Output directory contents:\n{output_directory_tree}\n"
                f"Temporary directory contents:\n{temporary_directory_tree}\n"
                f"stdout:\n{completed_process.stdout}\n"
                f"stderr:\n{completed_process.stderr}"
            )

        return selected_output_path.name, selected_output_path.read_bytes()


def _normalize_input_filename_for_sharp(raw_filename: str, image_bytes: bytes) -> str:
    sanitized_input_filename = Path(raw_filename).name.strip()
    if not sanitized_input_filename:
        sanitized_input_filename = "uploaded-image"

    input_stem = Path(sanitized_input_filename).stem
    existing_suffix = Path(sanitized_input_filename).suffix.strip()
    if existing_suffix:
        return sanitized_input_filename

    inferred_suffix = _infer_image_suffix_from_image_bytes(image_bytes)
    return f"{input_stem}{inferred_suffix}"


def _infer_image_suffix_from_image_bytes(image_bytes: bytes) -> str:
    if len(image_bytes) >= 3 and image_bytes[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if len(image_bytes) >= 8 and image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if len(image_bytes) >= 6 and image_bytes[:6] in {b"GIF87a", b"GIF89a"}:
        return ".gif"
    if len(image_bytes) >= 2 and image_bytes[:2] == b"BM":
        return ".bmp"
    if len(image_bytes) >= 4 and image_bytes[:4] in {b"II*\x00", b"MM\x00*"}:
        return ".tiff"
    if len(image_bytes) >= 12 and image_bytes[0:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return ".webp"
    if len(image_bytes) >= 12 and image_bytes[4:8] == b"ftyp":
        major_brand = image_bytes[8:12]
        if major_brand in {
            b"heic",
            b"heix",
            b"hevc",
            b"hevx",
            b"mif1",
            b"msf1",
        }:
            return ".heic"
        if major_brand in {b"avif", b"avis"}:
            return ".avif"
    return ".jpg"


def _resolve_generated_ply_output_path(
    output_directory_path: Path,
    temporary_directory_path: Path,
    expected_output_stem: str,
    command_stdout: str,
    command_stderr: str,
) -> Path | None:
    exact_expected_output_path = output_directory_path / f"{expected_output_stem}.ply"
    if exact_expected_output_path.exists():
        return exact_expected_output_path

    output_directory_candidates = _collect_case_insensitive_ply_paths(output_directory_path)
    if output_directory_candidates:
        return _select_preferred_ply_path(
            candidate_output_paths=output_directory_candidates,
            expected_output_stem=expected_output_stem,
        )

    temporary_directory_candidates = _collect_case_insensitive_ply_paths(temporary_directory_path)
    if temporary_directory_candidates:
        return _select_preferred_ply_path(
            candidate_output_paths=temporary_directory_candidates,
            expected_output_stem=expected_output_stem,
        )

    output_path_from_logs = _extract_ply_path_from_command_logs(
        command_stdout=command_stdout,
        command_stderr=command_stderr,
    )
    if output_path_from_logs and output_path_from_logs.exists():
        return output_path_from_logs

    return None


def _collect_case_insensitive_ply_paths(search_directory_path: Path) -> list[Path]:
    if not search_directory_path.exists():
        return []
    return sorted(
        (
            candidate_file_path
            for candidate_file_path in search_directory_path.rglob("*")
            if candidate_file_path.is_file() and candidate_file_path.suffix.lower() == ".ply"
        ),
        key=lambda candidate_file_path: str(candidate_file_path),
    )


def _select_preferred_ply_path(
    candidate_output_paths: list[Path],
    expected_output_stem: str,
) -> Path:
    expected_stem_matches = [
        candidate_output_path
        for candidate_output_path in candidate_output_paths
        if candidate_output_path.stem == expected_output_stem
    ]
    if expected_stem_matches:
        return expected_stem_matches[0]

    newest_candidate_output_path = max(
        candidate_output_paths,
        key=lambda candidate_output_path: candidate_output_path.stat().st_mtime,
    )
    return newest_candidate_output_path


def _extract_ply_path_from_command_logs(
    command_stdout: str,
    command_stderr: str,
) -> Path | None:
    command_log_text = f"{command_stdout}\n{command_stderr}"
    for log_line in command_log_text.splitlines():
        normalized_log_line = log_line.strip().strip("\"'")
        if normalized_log_line.lower().endswith(".ply"):
            candidate_output_path = Path(normalized_log_line)
            if candidate_output_path.exists():
                return candidate_output_path

        regex_match = re.search(r"(/[^\s\"']+\.ply)\b", normalized_log_line, re.IGNORECASE)
        if regex_match:
            candidate_output_path = Path(regex_match.group(1))
            if candidate_output_path.exists():
                return candidate_output_path

    return None


def _format_directory_tree(root_directory_path: Path) -> str:
    if not root_directory_path.exists():
        return f"(missing directory: {root_directory_path})"

    listed_relative_paths: list[str] = []
    for candidate_path in sorted(root_directory_path.rglob("*")):
        try:
            relative_path_string = str(candidate_path.relative_to(root_directory_path))
        except ValueError:
            relative_path_string = str(candidate_path)
        listed_relative_paths.append(relative_path_string)

    if not listed_relative_paths:
        return "(empty)"
    return "\n".join(listed_relative_paths)


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
