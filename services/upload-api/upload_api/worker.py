"""Durable outbox and idempotent result application, separate from HTTP workers."""
import logging
import signal
import time

from botocore.exceptions import ClientError
from pydantic import ValidationError
from psycopg.types.json import Jsonb

from ingestion_common.config import settings
from ingestion_common.contracts import IngestionResult
from ingestion_common.messaging import consumer, dead_letter, producer, publish
from ingestion_common.storage import s3
from .db import initialize, pool

log = logging.getLogger(__name__)


def apply_result(result):
    with pool.connection() as conn:
        row = conn.execute("SELECT * FROM ingestion.uploads WHERE id=%s FOR UPDATE", (result.upload_id,)).fetchone()
        if not row or row["attempt"] != result.attempt or row["status"] not in ("queued", "processing"):
            return
        conn.execute("""UPDATE ingestion.uploads SET status=%s, processed_files=%s,
            error=%s, updated_at=now() WHERE id=%s""",
            (result.status, Jsonb([f.model_dump(mode="json") for f in result.processed_files]), result.error, result.upload_id))


def dispatch(client):
    with pool.connection() as conn:
        row = conn.execute("SELECT * FROM ingestion.outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetchone()
        if row:
            publish(client, settings.request_topic, row["upload_id"], row["payload"])
            conn.execute("UPDATE ingestion.outbox SET sent_at=now() WHERE id=%s", (row["id"],))


def expire_uploads():
    storage = s3()
    with pool.connection() as conn:
        rows = conn.execute("""SELECT * FROM ingestion.uploads WHERE status='uploading' AND expires_at < now()
            LIMIT 10 FOR UPDATE SKIP LOCKED""").fetchall()
        for row in rows:
            try:
                storage.abort_multipart_upload(Bucket=settings.bucket, Key=row["object_key"], UploadId=row["s3_upload_id"])
            except ClientError as error:
                if error.response["Error"]["Code"] != "NoSuchUpload":
                    raise
            storage.delete_object(Bucket=settings.bucket, Key=row["object_key"])
            conn.execute("UPDATE ingestion.uploads SET status='expired', updated_at=now() WHERE id=%s", (row["id"],))
        # A lost scheduler or exhausted result-delivery task must not leave a file
        # permanently processing. This exceeds both task and DAG timeout limits.
        conn.execute("""UPDATE ingestion.uploads SET status='failed', updated_at=now(),
            error='Processing timed out. Inspect Airflow or retry processing.'
            WHERE status='processing' AND updated_at < now() - interval '2 hours'""")


def main():
    logging.basicConfig(level=logging.INFO)
    initialize()
    sender = producer()
    listener = consumer(settings.result_topic, "geomap-backend-results-v1")
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    cleanup_at = 0
    try:
        while not stopping:
            try:
                dispatch(sender)
                if time.monotonic() >= cleanup_at:
                    expire_uploads()
                    cleanup_at = time.monotonic() + 60
                message = listener.poll(1)
                if message is None:
                    continue
                if message.error():
                    raise RuntimeError(message.error())
                try:
                    result = IngestionResult.model_validate_json(message.value())
                except (ValueError, ValidationError) as error:
                    dead_letter(sender, message, error)
                else:
                    apply_result(result)
                listener.commit(message=message, asynchronous=False)
            except Exception:
                log.exception("Worker operation failed; retrying without advancing the offset")
                # Restart the consumer assignment at the last committed offset.
                listener.close()
                if not stopping:
                    time.sleep(2)
                    listener = consumer(settings.result_topic, "geomap-backend-results-v1")
    finally:
        listener.close()
        sender.flush(5)
        pool.close()


if __name__ == "__main__":
    main()
