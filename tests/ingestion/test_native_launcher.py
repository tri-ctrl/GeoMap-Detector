import base64
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "native_services", ROOT / "scripts/native_services.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class NativeLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "native.env"
        self.values = {
            "DATABASE_URL": "postgresql://native:password@127.0.0.1:5545/test",
            "S3_ENDPOINT": "http://127.0.0.1:9018",
            "S3_PUBLIC_ENDPOINT": "https://files.example.test",
            "S3_ACCESS_KEY": "native-test-key",
            "S3_SECRET_KEY": "native-test-secret",
            "KAFKA_BOOTSTRAP_SERVERS": "127.0.0.1:19095",
            "AIRFLOW_API_USER": "native",
            "AIRFLOW_API_PASSWORD": "native-test-password",
            "AIRFLOW_SECRET_KEY": "native-test-secret",
            "AIRFLOW_FERNET_KEY": base64.urlsafe_b64encode(bytes(32)).decode(),
            "INGESTION_API_URL": "https://files.example.test",
        }
        self.write()

    def write(self):
        self.path.write_text(
            "".join(f"{key}={value}\n" for key, value in self.values.items())
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_native_environment_uses_separate_processor_and_no_docker(self):
        self.values["INGESTION_EXECUTOR"] = "docker"
        self.write()
        env = launcher.environment(self.path)
        self.assertEqual(env["INGESTION_EXECUTOR"], "python")
        self.assertEqual(
            env["INGESTION_PYTHON"], str(ROOT / ".runtime/venvs/processor/bin/python")
        )
        self.assertTrue(
            env["AIRFLOW__DATABASE__SQL_ALCHEMY_CONN"].startswith(
                "postgresql+psycopg2://"
            )
        )
        self.assertNotIn("INGESTION_DOCKER_NETWORK", env)

    def test_unconfigured_infrastructure_is_reported_before_start(self):
        del self.values["AIRFLOW_FERNET_KEY"]
        self.write()
        with self.assertRaisesRegex(ValueError, "AIRFLOW_FERNET_KEY"):
            launcher.environment(self.path)

    def test_native_frontend_serves_remote_api_config_without_editing_source(self):
        before = (ROOT / "frontend/ingestion-config.json").read_bytes()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.values["NATIVE_WEB_PORT"] = str(port)
        self.write()
        with tempfile.TemporaryFile() as logs:
            child = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "scripts/native_services.py"),
                    "serve",
                    "--env-file",
                    str(self.path),
                ],
                stdout=logs,
                stderr=logs,
            )
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}/ingestion-config.json", timeout=1
                        ) as response:
                            self.assertEqual(
                                json.load(response)["api_url"],
                                "https://files.example.test",
                            )
                        break
                    except OSError:
                        if child.poll() is not None or time.monotonic() >= deadline:
                            logs.seek(0)
                            self.fail(
                                "Native frontend failed to start: "
                                + logs.read().decode()
                            )
                        time.sleep(0.1)
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/uploads.js"
                ) as response:
                    self.assertEqual(
                        response.read(), (ROOT / "frontend/uploads.js").read_bytes()
                    )
            finally:
                child.terminate()
                child.wait(timeout=5)
        self.assertEqual(before, (ROOT / "frontend/ingestion-config.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
