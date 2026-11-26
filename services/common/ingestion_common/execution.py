"""Native processor execution, with bounded lifetime and descendant cleanup."""

import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path


def run_processor(request, *, python=None, root=None, timeout=1740, environment=None):
    if timeout <= 0:
        raise ValueError("Processor timeout must be positive")
    python = Path(python or os.getenv("INGESTION_PYTHON", sys.executable))
    root = Path(
        root
        or os.getenv(
            "INGESTION_PROCESSOR_ROOT",
            Path(__file__).resolve().parents[2] / "ingestion",
        )
    )
    if not python.is_absolute() or not os.access(python, os.X_OK):
        raise ValueError(
            "INGESTION_PYTHON must name an executable absolute Python path"
        )
    if not (root / "processor/main.py").is_file():
        raise ValueError("INGESTION_PROCESSOR_ROOT must contain processor/main.py")
    encoded = json.dumps(request.model_dump(mode="json"), allow_nan=False).encode()
    if len(encoded) > 65536:
        raise ValueError("Processor request exceeds the 64 KiB handoff limit")
    env = {**os.environ, **(environment or {})}
    common = str(Path(__file__).resolve().parent.parent)
    env["PYTHONPATH"] = os.pathsep.join([str(root.resolve()), common])
    env["PYTHONUNBUFFERED"] = "1"
    # A request travels over stdin, not a shell command, process arguments or a log.
    env.pop("INGESTION_REQUEST", None)
    with tempfile.TemporaryDirectory(prefix="geomap-native-") as scratch:
        env["TMPDIR"] = scratch
        child = subprocess.Popen(
            [str(python), "-m", "processor.main", "--request-stdin"],
            stdin=subprocess.PIPE,
            env=env,
            cwd=root,
            start_new_session=os.name == "posix",
        )
        try:
            child.communicate(encoded, timeout=timeout)
            if child.returncode:
                raise subprocess.CalledProcessError(
                    child.returncode, [str(python), "-m", "processor.main"]
                )
        finally:
            # Also retire decoder grandchildren (ffmpeg/GDAL) after failure, timeout or Airflow cancellation.
            if os.name == "posix":
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            elif child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            if os.name == "posix":
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif child.poll() is None:
                child.kill()
            child.wait()
            if child.stdin is not None:
                try:
                    child.stdin.close()
                except OSError:
                    pass
