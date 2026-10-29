"""Optional local CoreML-LLM process adapter for Sweetiebot commit generation.

The bridge is an explicitly configured, local executable. No shell or remote API.
Each Python process keeps a single model process warm across its generation steps.
"""
from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import threading
import time

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 256 * 1024


def available(command: str) -> bool:
    path = Path(command).expanduser()
    return (sys.platform == "darwin" and path.is_file()
            and os.access(path, os.X_OK))


class ModelWorker:
    def __init__(self, command: str):
        self.command = str(Path(command).expanduser())
        self.process = None
        self.pending = bytearray()
        self.lock = threading.Lock()

    def close(self):
        process = self.process
        self.process = None
        self.pending.clear()
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for stream in (process.stdin, process.stdout):
                if stream:
                    stream.close()

    def _start(self):
        if self.process is not None and self.process.poll() is None:
            return
        self.close()
        if not available(self.command):
            raise FileNotFoundError("Core ML bridge not executable. Build it using native/coreml-llm-bridge/install.sh")
        self.process = subprocess.Popen(
            [self.command, "--serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, bufsize=0, close_fds=True,
        )

    def request(self, data: dict, timeout: float) -> dict:
        payload = (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")
        if len(payload) > MAX_REQUEST_BYTES:
            raise ValueError("Core ML prompt exceeds the bridge input limit")
        if timeout <= 0:
            raise TimeoutError("Core ML request deadline exceeded")
        with self.lock:
            self._start()
            try:
                self.process.stdin.write(payload)
                self.process.stdin.flush()
                deadline = time.monotonic() + timeout
                while b"\n" not in self.pending:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Core ML inference timed out")
                    readable, _, _ = select.select([self.process.stdout], [], [], remaining)
                    if not readable:
                        raise TimeoutError("Core ML inference timed out")
                    chunk = os.read(self.process.stdout.fileno(), 32768)
                    if not chunk:
                        raise OSError("Core ML bridge exited unexpectedly")
                    self.pending.extend(chunk)
                    if len(self.pending) > MAX_RESPONSE_BYTES:
                        raise ValueError("Core ML response too large")
                line, _, tail = self.pending.partition(b"\n")
                self.pending = bytearray(tail)
                result = json.loads(line)
                if not isinstance(result, dict) or not isinstance(result.get("response"), str):
                    raise ValueError("Core ML bridge returned an invalid response")
                if result.get("error"):
                    raise RuntimeError("Core ML inference failed: " + str(result["error"])[:200])
                return result
            except Exception:
                self.close()
                raise


_WORKERS: dict[str, ModelWorker] = {}
_WORKERS_LOCK = threading.Lock()


def worker_for(command: str) -> ModelWorker:
    command = str(Path(command).expanduser())
    with _WORKERS_LOCK:
        if command not in _WORKERS:
            _WORKERS[command] = ModelWorker(command)
        return _WORKERS[command]


@atexit.register
def shutdown():
    with _WORKERS_LOCK:
        workers = list(_WORKERS.values())
        _WORKERS.clear()
    for worker in workers:
        worker.close()


def generate(command: str, payload: dict, timeout: float) -> dict:
    """Adapt Ollama's non-streaming /api/generate shape to the Swift bridge.

    The Swift package currently accepts natural-language prompts, not an
    Ollama JSON-schema constraint. Sweetiebot's normal JSON/output validators
    must still inspect every response.
    """
    if not available(command):
        raise FileNotFoundError("Core ML bridge is unavailable; install it first")
    model = payload.get("model")
    prompt = payload.get("prompt")
    if not isinstance(model, str) or not model or not isinstance(prompt, str):
        raise ValueError("Core ML requires a model and prompt")
    schema = payload.get("format")
    if isinstance(schema, dict):
        prompt += "\n\nReturn ONLY one valid JSON object matching this JSON Schema:\n"
        prompt += json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    options = payload.get("options") or {}
    tokens = options.get("num_predict", 256)
    if not isinstance(tokens, int) or isinstance(tokens, bool):
        tokens = 256
    tokens = max(16, min(1024, tokens))
    return worker_for(command).request({
        "model": model, "prompt": prompt, "max_tokens": tokens,
    }, timeout)
