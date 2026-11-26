"""Manage GeoMap's native services against native/managed PostgreSQL, Kafka and S3."""

import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / ".runtime"
SERVICES = RUNTIME / "venvs/services/bin/python"
PROCESSOR = RUNTIME / "venvs/processor/bin/python"


def environment(path):
    from dotenv import dotenv_values

    if not path.is_file():
        raise ValueError(
            "Copy .env.native.example to .env.native and configure native infrastructure"
        )
    env = {
        **os.environ,
        **{
            key: value
            for key, value in dotenv_values(path).items()
            if value is not None
        },
    }
    env.pop("INGESTION_DOCKER_NETWORK", None)
    database = env.get("DATABASE_URL", "")
    if not database.startswith("postgresql://"):
        raise ValueError("DATABASE_URL must be a PostgreSQL connection URL")
    for key in (
        "S3_ENDPOINT",
        "S3_PUBLIC_ENDPOINT",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
        "KAFKA_BOOTSTRAP_SERVERS",
        "AIRFLOW_API_USER",
        "AIRFLOW_API_PASSWORD",
        "AIRFLOW_SECRET_KEY",
        "AIRFLOW_FERNET_KEY",
    ):
        if not env.get(key) or env[key].startswith("replace-with"):
            raise ValueError(f"Configure {key} in the native environment")
    port = env.get("NATIVE_AIRFLOW_PORT", "8099")
    env.update(
        {
            "PYTHONPATH": os.pathsep.join(
                str(ROOT / path) for path in ("services/common", "services/upload-api")
            ),
            "PATH": str(SERVICES.parent) + os.pathsep + env.get("PATH", ""),
            "PYTHONUNBUFFERED": "1",
            "AIRFLOW_HOME": str(RUNTIME / "airflow"),
            "AIRFLOW__CORE__DAGS_FOLDER": str(ROOT / "services/airflow/dags"),
            "AIRFLOW__CORE__EXECUTOR": "LocalExecutor",
            "AIRFLOW__CORE__LOAD_EXAMPLES": "false",
            "AIRFLOW__CORE__PARALLELISM": "4",
            "AIRFLOW__CORE__DAGS_ARE_PAUSED_AT_CREATION": "false",
            "AIRFLOW__CORE__FERNET_KEY": env["AIRFLOW_FERNET_KEY"],
            "AIRFLOW__DATABASE__SQL_ALCHEMY_CONN": database.replace(
                "postgresql://", "postgresql+psycopg2://", 1
            ),
            "AIRFLOW__WEBSERVER__SECRET_KEY": env["AIRFLOW_SECRET_KEY"],
            "AIRFLOW__WEBSERVER__WORKERS": "2",
            "AIRFLOW__API__AUTH_BACKENDS": "airflow.api.auth.backend.basic_auth,airflow.api.auth.backend.session",
            "AIRFLOW_API_URL": "http://127.0.0.1:" + port,
            "INGESTION_EXECUTOR": "python",
            "INGESTION_PYTHON": str(PROCESSOR),
            "INGESTION_PROCESSOR_ROOT": str(ROOT / "services/ingestion"),
        }
    )
    return env


def initialize(env):
    subprocess.run([str(SERVICES), "-m", "upload_api.bootstrap"], env=env, check=True)
    subprocess.run(
        [str(SERVICES), "-m", "airflow", "db", "migrate"], env=env, check=True
    )
    subprocess.run(
        [
            str(SERVICES),
            "-m",
            "airflow",
            "users",
            "create",
            "--username",
            env["AIRFLOW_API_USER"],
            "--password",
            env["AIRFLOW_API_PASSWORD"],
            "--firstname",
            "Geo",
            "--lastname",
            "Map",
            "--role",
            "Admin",
            "--email",
            "native@example.invalid",
        ],
        env=env,
        check=True,
    )


def serve(env):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] == "/ingestion-config.json":
                value = env.get(
                    "INGESTION_API_URL",
                    "http://localhost:" + env.get("NATIVE_API_PORT", "8097"),
                )
                body = json.dumps({"api_url": value}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                super().do_GET()

    handler = functools.partial(Handler, directory=str(ROOT / "frontend"))
    with http.server.ThreadingHTTPServer(
        (
            env.get("NATIVE_WEB_HOST", "127.0.0.1"),
            int(env.get("NATIVE_WEB_PORT", "8098")),
        ),
        handler,
    ) as server:
        server.serve_forever()


def run(env, env_file):
    commands = [
        [
            str(SERVICES),
            "-m",
            "uvicorn",
            "upload_api.app:app",
            "--host",
            env.get("NATIVE_API_HOST", "127.0.0.1"),
            "--port",
            env.get("NATIVE_API_PORT", "8097"),
        ],
        [str(SERVICES), "-m", "upload_api.worker"],
        [
            str(SERVICES),
            "-m",
            "airflow",
            "webserver",
            "--hostname",
            "127.0.0.1",
            "--port",
            env.get("NATIVE_AIRFLOW_PORT", "8099"),
        ],
        [str(SERVICES), "-m", "airflow", "scheduler"],
        [str(SERVICES), str(ROOT / "services/airflow/bridge.py")],
        [
            str(SERVICES),
            str(Path(__file__).resolve()),
            "serve",
            "--env-file",
            str(env_file),
        ],
    ]
    children = []
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        for command in commands:
            children.append(
                subprocess.Popen(command, cwd=ROOT, env=env, start_new_session=True)
            )
        print("Native services started. Press Ctrl-C to stop.", flush=True)
        while not stopping:
            for child in children:
                if child.poll() is not None:
                    raise RuntimeError(
                        f"Native service exited with status {child.returncode}; see its logs above"
                    )
            time.sleep(0.3)
    finally:
        for child in reversed(children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 15
        for child in children:
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "init", "run", "serve"))
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env.native")
    args = parser.parse_args()
    if not SERVICES.is_file() or not PROCESSOR.is_file():
        parser.error("Run scripts/setup_native_ingestion.py with Python 3.12 first")
    if Path(sys.prefix).resolve() != SERVICES.parent.parent.resolve():
        os.execv(
            str(SERVICES), [str(SERVICES), str(Path(__file__).resolve()), *sys.argv[1:]]
        )
    try:
        env = environment(args.env_file.resolve())
        if args.action == "check":
            subprocess.run(
                [
                    str(PROCESSOR),
                    "-c",
                    "import processor.dispatch; print('Native processor imports OK')",
                ],
                env={
                    **env,
                    "PYTHONPATH": str(ROOT / "services/common")
                    + os.pathsep
                    + str(ROOT / "services/ingestion"),
                },
                check=True,
            )
            print("Native configuration OK; no infrastructure connections made.")
            print(
                "Optional format tools:",
                {
                    name: bool(shutil.which(name))
                    for name in (
                        "gdalinfo",
                        "gdal_translate",
                        "ffprobe",
                        "ffmpeg",
                        "pdftoppm",
                        "dwgread",
                    )
                },
            )
        elif args.action == "init":
            initialize(env)
        elif args.action == "serve":
            serve(env)
        else:
            run(env, args.env_file.resolve())
    except (ValueError, OSError, subprocess.CalledProcessError, RuntimeError) as error:
        # Connection exceptions may carry credentials. Report only the safe exception type for child failures.
        print(
            (
                str(error)
                if isinstance(error, (ValueError, RuntimeError))
                else f"Native command failed ({type(error).__name__}); see service logs"
            ),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
