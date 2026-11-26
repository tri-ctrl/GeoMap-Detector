"""Kafka → Airflow REST bridge. Stable run IDs make redelivery safe."""
import logging
import os
import signal
import time

import requests

from ingestion_common.config import settings
from ingestion_common.contracts import IngestionRequest, validate_source
from ingestion_common.messaging import consumer, dead_letter, producer

log = logging.getLogger(__name__)


def trigger(session, request):
    response = session.post(os.environ["AIRFLOW_API_URL"] + "/api/v1/dags/ingest_file/dagRuns", timeout=30,
                            json={"dag_run_id": request.run_id, "conf": request.model_dump(mode="json")})
    if response.status_code != 409:
        response.raise_for_status()


def main():
    logging.basicConfig(level=logging.INFO)
    session = requests.Session()
    session.auth = (os.environ["AIRFLOW_API_USER"], os.environ["AIRFLOW_API_PASSWORD"])
    sender = producer()
    listener = consumer(settings.request_topic, "geomap-airflow-bridge-v1")
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            try:
                message = listener.poll(1)
                if message is None:
                    continue
                if message.error():
                    raise RuntimeError(message.error())
                try:
                    request = IngestionRequest.model_validate_json(message.value())
                    validate_source(request, settings.bucket)
                except ValueError as error:
                    dead_letter(sender, message, error)
                else:
                    trigger(session, request)
                    log.info("Accepted Airflow run %s", request.run_id)
                listener.commit(message=message, asynchronous=False)
            except Exception:
                log.exception("Bridge operation failed; request remains uncommitted")
                listener.close()
                if not stopping:
                    time.sleep(3)
                    listener = consumer(settings.request_topic, "geomap-airflow-bridge-v1")
    finally:
        listener.close()
        session.close()


if __name__ == "__main__":
    main()
