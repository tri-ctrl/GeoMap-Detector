"""One immutable upload attempt → one isolated processor → one result event."""
import os
from datetime import datetime, timedelta, timezone

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.empty import EmptyOperator
from airflow.providers.docker.operators.docker import DockerOperator
from airflow.utils.state import TaskInstanceState
from airflow.utils.trigger_rule import TriggerRule

from ingestion_common.config import settings
from ingestion_common.contracts import IngestionRequest, IngestionResult, validate_source
from ingestion_common.messaging import producer, publish
from ingestion_common.storage import read_json, s3


def request_from(context):
    request = IngestionRequest.model_validate(context["dag_run"].conf)
    validate_source(request, settings.bucket)
    return request


def send(result):
    publish(producer(), settings.result_topic, result.upload_id, result.model_dump(mode="json"))


def started(**context):
    request = request_from(context)
    send(IngestionResult(upload_id=request.upload_id, attempt=request.attempt, status="processing"))


def finish(**context):
    request = request_from(context)
    process = context["dag_run"].get_task_instance("process_file")
    if process.state == TaskInstanceState.SUCCESS:
        result = IngestionResult.model_validate(read_json(s3(), request.prefix + "manifest.json"))
        if result.upload_id != request.upload_id or result.attempt != request.attempt or result.status != "completed":
            raise ValueError("Processor returned a mismatched manifest")
    else:
        error = "Ingestion container failed. Check this run in Airflow for task logs."
        # A processor validation failure provides a bounded, user-facing error file.
        try:
            detail = read_json(s3(), request.prefix + "error.json", limit=4096)
            error = str(detail.get("error", error))[:1000]
        except Exception:
            pass
        result = IngestionResult(upload_id=request.upload_id, attempt=request.attempt, status="failed", error=error)
    send(result)


with DAG("ingest_file", description="Process uploaded geospatial files in Docker", schedule=None,
         start_date=datetime(2025, 1, 1, tzinfo=timezone.utc), catchup=False, max_active_runs=2,
         is_paused_upon_creation=False, dagrun_timeout=timedelta(hours=1),
         default_args={"retries": 2, "retry_delay": timedelta(seconds=10), "retry_exponential_backoff": True},
         tags=["geomap", "ingestion"]) as dag:
    begin = PythonOperator(task_id="processing_started", python_callable=started)
    process = DockerOperator(
        task_id="process_file", image=os.getenv("INGESTION_IMAGE", "geomap-ingestion:local"),
        docker_url="unix://var/run/docker.sock", api_version="auto",
        network_mode=os.environ["INGESTION_DOCKER_NETWORK"],
        environment={"INGESTION_REQUEST": "{{ dag_run.conf | tojson }}"},
        private_environment={"S3_ENDPOINT": settings.s3_endpoint, "S3_BUCKET": settings.bucket,
                             "S3_ACCESS_KEY": settings.s3_access_key, "S3_SECRET_KEY": settings.s3_secret_key,
                             "MAX_UPLOAD_BYTES": str(settings.max_upload_bytes)},
        mount_tmp_dir=False, auto_remove="force", force_pull=False,
        mem_limit="2g", cpus=1, do_xcom_push=False,
        execution_timeout=timedelta(minutes=30), retries=1,
        labels={"app": "geomap-ingestion"})
    final = PythonOperator(task_id="publish_result", python_callable=finish, trigger_rule=TriggerRule.ALL_DONE)
    begin >> process >> final
    # Keep the DAG failed when the processor fails, even after failure notification succeeds.
    success = EmptyOperator(task_id="ingestion_succeeded")
    [process, final] >> success
