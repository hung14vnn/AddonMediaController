"""Tiny internal HTTP sidecar for CPU-friendly MDX vocal separation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.getenv("KARAOKE_WORKER_HOST", "0.0.0.0")
PORT = int(os.getenv("KARAOKE_WORKER_PORT", "8091"))
MUSIC_ROOTS = [
    Path(value).resolve()
    for value in os.getenv("KARAOKE_MUSIC_ROOTS", "/music").split(",")
    if value.strip()
]
CACHE_TMP_ROOT = Path(
    os.getenv("KARAOKE_CACHE_TMP_ROOT", "/app/cache/karaoke/tmp")
).resolve()
MODEL_NAME = os.getenv("KARAOKE_MODEL_NAME", "UVR_MDXNET_9482.onnx")
MODEL_DIR = Path(
    os.getenv(
        "AUDIO_SEPARATOR_MODEL_DIR", "/app/.cache/audio-separator/models"
    )
).resolve()
JOB_TIMEOUT = int(os.getenv("KARAOKE_WORKER_JOB_TIMEOUT", "840"))


def _inside(path: Path, roots: list[Path]) -> bool:
    return any(path.is_relative_to(root) for root in roots)


def _run(argv: list[str], timeout: int = JOB_TIMEOUT) -> None:
    subprocess.run(
        argv,
        check=True,
        timeout=timeout,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def separate(input_path: str, output_dir: str) -> None:
    source = Path(input_path).resolve(strict=True)
    destination = Path(output_dir).resolve()
    if not source.is_file() or not _inside(source, MUSIC_ROOTS):
        raise ValueError("Input is outside configured music roots")
    if not destination.is_relative_to(CACHE_TMP_ROOT):
        raise ValueError("Output is outside karaoke temporary cache")

    destination.mkdir(parents=True, exist_ok=True)
    separated = destination / "separated"
    shutil.rmtree(separated, ignore_errors=True)
    _run(
        [
            "audio-separator",
            str(source),
            "--model_filename",
            MODEL_NAME,
            "--model_file_dir",
            str(MODEL_DIR),
            "--output_dir",
            str(separated),
            "--output_format",
            "WAV",
            "--mdx_batch_size",
            "1",
            "--mdx_segment_size",
            "256",
            "--mdx_overlap",
            "0.25",
            "--custom_output_names",
            '{"Vocals":"vocals","Instrumental":"instrumental"}',
            "--log_level",
            "WARNING",
        ]
    )
    accompaniment = separated / "instrumental.wav"
    vocals = separated / "vocals.wav"
    if not accompaniment.is_file() or not vocals.is_file():
        raise RuntimeError("Audio separator did not create both stems")

    _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(accompaniment),
            "-map_metadata",
            "-1",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            str(destination / "instrumental.m4a"),
        ]
    )
    _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(vocals),
            "-map_metadata",
            "-1",
            "-af",
            "volume=1.12",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            str(destination / "vocals.m4a"),
        ]
    )
    shutil.rmtree(separated, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "DroppedNeedleKaraoke/1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._json(404, {"error": "not found"})
            return
        self._json(200, {"status": "ok"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/separate":
            self._json(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 16_384:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(size))
            separate(str(body["input_path"]), str(body["output_dir"]))
            self._json(200, {"status": "ready"})
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "Separation timed out"})
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or "Audio separator failed").strip()[-500:]
            self._json(500, {"error": detail})
        except (KeyError, ValueError, OSError, RuntimeError) as exc:
            self._json(400, {"error": str(exc)[:500]})

    def log_message(self, format: str, *args: object) -> None:
        print(f"karaoke-worker: {format % args}", flush=True)

    def _json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    CACHE_TMP_ROOT.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
