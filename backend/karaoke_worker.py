"""Tiny internal HTTP sidecar for CPU-friendly Spleeter vocal separation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
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
MODEL_DIR = Path(os.getenv("KARAOKE_MODEL_DIR", "/app/models")).resolve()
MODEL_FILES = ("vocals.fp16.onnx", "accompaniment.fp16.onnx")
WORKER_THREADS = int(os.getenv("KARAOKE_WORKER_THREADS", "2"))
JOB_TIMEOUT = int(os.getenv("KARAOKE_WORKER_JOB_TIMEOUT", "840"))
SAMPLE_RATE = 44_100


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


def _ensure_models() -> None:
    missing = [name for name in MODEL_FILES if not (MODEL_DIR / name).is_file()]
    if missing:
        raise RuntimeError(f"Missing karaoke model files: {', '.join(missing)}")


def _decode(source: Path, target: Path) -> None:
    _run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "2",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_f32le",
            str(target),
        ]
    )


def _encode(source: Path, target: Path, *, vocal_gain: bool = False) -> None:
    argv = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-map_metadata",
        "-1",
    ]
    if vocal_gain:
        argv.extend(["-af", "volume=1.12"])
    argv.extend(
        ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(target)]
    )
    _run(argv)


def _separate_worker(source: Path, destination: Path) -> None:
    import numpy as np
    import sherpa_onnx
    import soundfile as sf

    _ensure_models()
    source_wav = destination / "source.wav"
    vocals_wav = destination / "vocals.wav"
    instrumental_wav = destination / "instrumental.wav"
    try:
        _decode(source, source_wav)
        samples, sample_rate = sf.read(
            str(source_wav), dtype="float32", always_2d=True
        )
        if sample_rate != SAMPLE_RATE or samples.shape[1] != 2:
            raise RuntimeError("Decoded audio is not 44.1 kHz stereo")
        config = sherpa_onnx.OfflineSourceSeparationConfig(
            model=sherpa_onnx.OfflineSourceSeparationModelConfig(
                spleeter=sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(
                    vocals=str(MODEL_DIR / MODEL_FILES[0]),
                    accompaniment=str(MODEL_DIR / MODEL_FILES[1]),
                ),
                num_threads=WORKER_THREADS,
                debug=False,
                provider="cpu",
            )
        )
        if not config.validate():
            raise RuntimeError("Invalid karaoke model configuration")
        separator = sherpa_onnx.OfflineSourceSeparation(config)
        output = separator.process(
            sample_rate=sample_rate, samples=np.ascontiguousarray(samples.T)
        )
        if len(output.stems) != 2:
            raise RuntimeError("Karaoke model did not return two stems")
        # Spleeter returns vocals first, then accompaniment.
        for stem, path in (
            (output.stems[0], vocals_wav),
            (output.stems[1], instrumental_wav),
        ):
            sf.write(
                str(path),
                np.ascontiguousarray(stem.data.T),
                output.sample_rate,
                subtype="FLOAT",
            )
        _encode(instrumental_wav, destination / "instrumental.m4a")
        _encode(vocals_wav, destination / "vocals.m4a", vocal_gain=True)
    finally:
        for path in (source_wav, vocals_wav, instrumental_wav):
            path.unlink(missing_ok=True)


def separate(input_path: str, output_dir: str) -> None:
    source = Path(input_path).resolve(strict=True)
    destination = Path(output_dir).resolve()
    if not source.is_file() or not _inside(source, MUSIC_ROOTS):
        raise ValueError("Input is outside configured music roots")
    if not destination.is_relative_to(CACHE_TMP_ROOT):
        raise ValueError("Output is outside karaoke temporary cache")

    destination.mkdir(parents=True, exist_ok=True)
    _run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--separate-worker",
            str(source),
            str(destination),
        ]
    )
    for filename in ("instrumental.m4a", "vocals.m4a"):
        path = destination / filename
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError("Audio separator did not create both stems")


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
    if len(sys.argv) == 4 and sys.argv[1] == "--separate-worker":
        _separate_worker(
            Path(sys.argv[2]).resolve(strict=True),
            Path(sys.argv[3]).resolve(),
        )
    else:
        _ensure_models()
        CACHE_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
