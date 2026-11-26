"""Real Airflow/native subprocess/S3 HTTP flow; Kafka publication is captured."""

import importlib.util
import base64
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
server = None
module = None
client = None


def setUpModule():
    global server, module, client
    if os.getenv("INGESTION_TEST_NATIVE") != "1":
        raise unittest.SkipTest(
            "Native Airflow integration requires INGESTION_TEST_NATIVE=1 and isolated metadata"
        )
    if not os.getenv("AIRFLOW_HOME") or not os.getenv(
        "AIRFLOW__DATABASE__SQL_ALCHEMY_CONN", ""
    ).startswith("sqlite:///"):
        raise ValueError(
            "Native Airflow tests require an explicit AIRFLOW_HOME and SQLite metadata URL"
        )
    from moto.server import ThreadedMotoServer

    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    os.environ.update(
        {
            "INGESTION_EXECUTOR": "python",
            "AIRFLOW__CORE__LOAD_EXAMPLES": "false",
            "AIRFLOW__CORE__FERNET_KEY": base64.urlsafe_b64encode(bytes(32)).decode(),
            "INGESTION_PYTHON": str(ROOT / ".runtime/venvs/processor/bin/python"),
            "INGESTION_PROCESSOR_ROOT": str(ROOT / "services/ingestion"),
            "S3_ENDPOINT": f"http://{host}:{port}",
            "S3_ACCESS_KEY": "native-test-key",
            "S3_SECRET_KEY": "native-test-secret",
            "S3_BUCKET": "geomap-files",
            "AWS_EC2_METADATA_DISABLED": "true",
        }
    )
    from airflow.utils import db

    db.initdb()
    spec = importlib.util.spec_from_file_location(
        "native_ingestion_dag", ROOT / "services/airflow/dags/ingest_file.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    for task in module.dag.tasks:
        task.retries = 0
    client = module.s3()
    client.create_bucket(Bucket="geomap-files")


def tearDownModule():
    if server:
        server.stop()


class NativeAirflowTests(unittest.TestCase):
    def test_native_dag_has_no_docker_dependency(self):
        self.assertIsNone(importlib.util.find_spec("docker"))
        self.assertEqual(
            module.dag.get_task("process_file").__class__.__name__, "PythonOperator"
        )

    def ingest(self, content):
        from ingestion_common.contracts import IngestionRequest, Source

        id_ = uuid4()
        request = IngestionRequest(
            upload_id=id_,
            attempt=1,
            source=Source(
                bucket="geomap-files",
                key=f"uploads/{id_}/points.csv",
                name="points.csv",
                size=len(content),
            ),
        )
        client.put_object(Bucket="geomap-files", Key=request.source.key, Body=content)
        results = []
        with patch.object(module, "send", side_effect=results.append):
            run = module.dag.test(run_conf=request.model_dump(mode="json"))
        return request, run, results

    def test_actual_airflow_native_processing_publishes_compatible_manifest(self):
        request, run, results = self.ingest(b"name,lat,lon\nDXB,25.25,55.36\n")
        self.assertEqual(run.state, "success")
        self.assertEqual(
            [result.status for result in results], ["processing", "completed"]
        )
        result = results[-1]
        self.assertEqual(result.upload_id, request.upload_id)
        self.assertEqual(result.processed_files[0].bbox, (55.36, 25.25, 55.36, 25.25))
        artifact = next(
            a for a in result.processed_files[0].artifacts if a.role == "data"
        )
        data = client.get_object(Bucket="geomap-files", Key=artifact.key)["Body"].read()
        self.assertEqual(json.loads(data)["features"][0]["properties"]["name"], "DXB")

    def test_invalid_native_input_preserves_failed_dag_and_user_error(self):
        request, run, results = self.ingest(b"lat,lon\n999,55\n")
        self.assertEqual(run.state, "failed")
        self.assertEqual(
            [result.status for result in results], ["processing", "failed"]
        )
        self.assertIn("row 2", results[-1].error)
        self.assertEqual(results[-1].upload_id, request.upload_id)


if __name__ == "__main__":
    unittest.main()
