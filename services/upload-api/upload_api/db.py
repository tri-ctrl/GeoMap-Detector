from pathlib import Path

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from ingestion_common.config import settings
from ingestion_common.contracts import IngestionRequest, Source

pool = ConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=8,
    open=False,
    kwargs={"row_factory": dict_row},
    timeout=15,
)


def initialize():
    pool.open(wait=True, timeout=60)
    with pool.connection() as conn:
        conn.execute(Path(__file__).with_name("schema.sql").read_text())


def enqueue(conn, row):
    request = IngestionRequest(
        upload_id=row["id"],
        attempt=row["attempt"],
        source=Source(
            bucket=settings.bucket,
            key=row["object_key"],
            name=row["name"],
            size=row["size"],
        ),
    )
    conn.execute(
        "INSERT INTO ingestion.outbox (id, upload_id, payload) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
        (request.run_id, row["id"], Jsonb(request.model_dump(mode="json"))),
    )


def view(row):
    return {
        key: row[key]
        for key in (
            "id",
            "folder_id",
            "name",
            "size",
            "fingerprint",
            "part_size",
            "status",
            "attempt",
            "error",
            "processed_files",
            "created_at",
            "updated_at",
            "expires_at",
        )
    }
