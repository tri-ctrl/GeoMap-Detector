import math
from contextlib import asynccontextmanager
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import Field
from psycopg.errors import UniqueViolation

from ingestion_common.config import settings
from ingestion_common.contracts import Contract, SUPPORTED_EXTENSIONS
from ingestion_common.storage import s3
from .db import enqueue, initialize, pool, view
from .uploads import assert_uploading, complete_object, list_parts


@asynccontextmanager
async def lifespan(_app):
    initialize()
    yield
    pool.close()


app = FastAPI(title="GeoVision File Ingestion", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)
storage = s3()
signer = s3(public=True)


@app.exception_handler(ClientError)
@app.exception_handler(BotoCoreError)
async def storage_error(_request, _error):
    return JSONResponse(
        status_code=503,
        content={"detail": "Object storage is unavailable; retry this operation"},
    )


class StartUpload(Contract):
    id: UUID
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0, strict=True)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    content_type: str = Field(default="application/octet-stream", max_length=100)
    folder_id: UUID | None = None


class CreateFolder(Contract):
    id: UUID
    parent_id: UUID | None = None
    name: str = Field(min_length=1, max_length=80)


class MoveFile(Contract):
    folder_id: UUID | None


def folder_exists(conn, folder_id):
    if (
        folder_id is not None
        and not conn.execute(
            "SELECT id FROM ingestion.folders WHERE id=%s", (folder_id,)
        ).fetchone()
    ):
        raise HTTPException(404, "Directory not found")


@app.get("/api/directories")
def directories():
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id,parent_id,name FROM ingestion.folders ORDER BY lower(name),id LIMIT 1001"
        ).fetchall()
    if len(rows) > 1000:
        raise HTTPException(409, "Directory limit exceeded")
    return {"items": rows}


@app.post("/api/directories", status_code=201)
def create_directory(body: CreateFolder):
    name = body.name.strip()
    if (
        not name
        or name in (".", "..")
        or any(c in name for c in ("/", "\\"))
        or any(ord(c) < 32 for c in name)
    ):
        raise HTTPException(
            422, "Use a directory name without slashes or control characters"
        )
    try:
        with pool.connection() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(35036)")
            existing = conn.execute(
                "SELECT id,parent_id,name FROM ingestion.folders WHERE id=%s",
                (body.id,),
            ).fetchone()
            if existing:
                if existing["name"] != name or existing["parent_id"] != body.parent_id:
                    raise HTTPException(409, "Directory ID already exists")
                return existing
            folder_exists(conn, body.parent_id)
            ancestor, depth = body.parent_id, 1
            while ancestor is not None:
                depth += 1
                if depth > 12:
                    raise HTTPException(
                        409, "Directory nesting is limited to 12 levels"
                    )
                ancestor = conn.execute(
                    "SELECT parent_id FROM ingestion.folders WHERE id=%s", (ancestor,)
                ).fetchone()["parent_id"]
            if (
                conn.execute("SELECT count(*) AS n FROM ingestion.folders").fetchone()[
                    "n"
                ]
                >= 1000
            ):
                raise HTTPException(409, "Directory limit reached")
            return conn.execute(
                "INSERT INTO ingestion.folders(id,parent_id,name) VALUES (%s,%s,%s) RETURNING id,parent_id,name",
                (body.id, body.parent_id, name),
            ).fetchone()
    except UniqueViolation as error:
        raise HTTPException(
            409, "A directory with that name already exists here"
        ) from error


class Part(Contract):
    part_number: int = Field(ge=1, le=10000, strict=True)
    etag: str = Field(min_length=1, max_length=128)


class CompleteUpload(Contract):
    parts: list[Part] = Field(min_length=1, max_length=10000)


def get_row(conn, upload_id, lock=False):
    row = conn.execute(
        "SELECT * FROM ingestion.uploads WHERE id=%s" + (" FOR UPDATE" if lock else ""),
        (upload_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Upload not found")
    return row


@app.get("/api/ingestion/health")
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    storage.head_bucket(Bucket=settings.bucket)
    return {
        "ok": True,
        "max_upload_bytes": settings.max_upload_bytes,
        "extensions": SUPPORTED_EXTENSIONS,
    }


@app.post("/api/uploads", status_code=201)
def start(body: StartUpload):
    if (
        "/" in body.name
        or "\\" in body.name
        or any(ord(c) < 32 for c in body.name)
        or not body.name.lower().endswith(SUPPORTED_EXTENSIONS)
    ):
        raise HTTPException(
            422, "This file extension is not accepted by the ingestion service"
        )
    if body.size > settings.max_upload_bytes:
        raise HTTPException(413, "File exceeds the configured upload size limit")
    part_size = max(settings.part_size, math.ceil(body.size / 10000), 5 * 1024**2)
    key = f"uploads/{body.id}/{body.name}"
    with pool.connection() as conn:
        # Serialize retries of initialization, including concurrent retries after lost responses.
        conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (str(body.id),)
        )
        existing = conn.execute(
            "SELECT * FROM ingestion.uploads WHERE id=%s", (body.id,)
        ).fetchone()
        if existing:
            if (existing["name"], existing["size"], existing["fingerprint"]) != (
                body.name,
                body.size,
                body.fingerprint,
            ):
                raise HTTPException(
                    409, "Upload ID already belongs to a different file"
                )
            return view(existing)
        folder_exists(conn, body.folder_id)
        remote = storage.create_multipart_upload(
            Bucket=settings.bucket,
            Key=key,
            ContentType=body.content_type,
            Metadata={"upload-id": str(body.id)},
        )
        try:
            row = conn.execute(
                """INSERT INTO ingestion.uploads
                (id,name,size,fingerprint,content_type,object_key,s3_upload_id,part_size,folder_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (
                    body.id,
                    body.name,
                    body.size,
                    body.fingerprint,
                    body.content_type,
                    key,
                    remote["UploadId"],
                    part_size,
                    body.folder_id,
                ),
            ).fetchone()
            conn.commit()
        except Exception:
            storage.abort_multipart_upload(
                Bucket=settings.bucket, Key=key, UploadId=remote["UploadId"]
            )
            raise
    return view(row)


@app.get("/api/uploads")
def catalog(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    folder: str | None = None,
    q: str = Query("", max_length=255),
):
    clauses, values = [], []
    if folder == "root":
        clauses.append("folder_id IS NULL")
    elif folder is not None:
        try:
            folder_id = UUID(folder)
        except ValueError as error:
            raise HTTPException(422, "Invalid directory ID") from error
        clauses.append("folder_id=%s")
        values.append(folder_id)
    if q:
        clauses.append("strpos(lower(name),lower(%s)) > 0")
        values.append(q)
    with pool.connection() as conn:
        if folder not in (None, "root"):
            folder_exists(conn, folder_id)
        rows = conn.execute(
            "SELECT * FROM ingestion.uploads"
            + (" WHERE " + " AND ".join(clauses) if clauses else "")
            + " ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s",
            (*values, limit, offset),
        ).fetchall()
    return {"items": [view(row) for row in rows], "limit": limit, "offset": offset}


@app.patch("/api/uploads/{upload_id}/directory")
def move_file(upload_id: UUID, body: MoveFile):
    with pool.connection() as conn:
        get_row(conn, upload_id, lock=True)
        folder_exists(conn, body.folder_id)
        return view(
            conn.execute(
                "UPDATE ingestion.uploads SET folder_id=%s WHERE id=%s RETURNING *",
                (body.folder_id, upload_id),
            ).fetchone()
        )


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: UUID):
    with pool.connection() as conn:
        return view(get_row(conn, upload_id))


@app.get("/api/uploads/{upload_id}/source")
def source_download(upload_id: UUID):
    with pool.connection() as conn:
        row = get_row(conn, upload_id)
    if row["status"] in ("uploading", "cancelled", "expired"):
        raise HTTPException(409, "Source upload is not complete")
    from urllib.parse import quote

    return {
        "url": signer.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.bucket,
                "Key": row["object_key"],
                "ResponseContentDisposition": "attachment; filename*=UTF-8''"
                + quote(row["name"]),
            },
            ExpiresIn=settings.url_ttl,
        )
    }


@app.get("/api/uploads/{upload_id}/parts")
def uploaded_parts(upload_id: UUID):
    with pool.connection() as conn:
        row = get_row(conn, upload_id)
    assert_uploading(row)
    return {
        "parts": [
            {
                "part_number": p["PartNumber"],
                "etag": p["ETag"].strip('"'),
                "size": p["Size"],
            }
            for p in list_parts(storage, row)
        ]
    }


@app.post("/api/uploads/{upload_id}/parts/{part_number}")
def sign_part(upload_id: UUID, part_number: int):
    with pool.connection() as conn:
        row = get_row(conn, upload_id)
    assert_uploading(row)
    if not 1 <= part_number <= math.ceil(row["size"] / row["part_size"]):
        raise HTTPException(422, "Invalid part number")
    url = signer.generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": settings.bucket,
            "Key": row["object_key"],
            "UploadId": row["s3_upload_id"],
            "PartNumber": part_number,
        },
        ExpiresIn=settings.url_ttl,
    )
    return {"url": url, "expires_in": settings.url_ttl}


@app.post("/api/uploads/{upload_id}/complete")
def complete(upload_id: UUID, body: CompleteUpload):
    with pool.connection() as conn:
        row = get_row(conn, upload_id, lock=True)
        if row["status"] in ("queued", "processing", "completed", "failed"):
            return view(row)
        assert_uploading(row)
        complete_object(storage, row, body.parts)
        row = conn.execute(
            "UPDATE ingestion.uploads SET status='queued', updated_at=now() WHERE id=%s RETURNING *",
            (upload_id,),
        ).fetchone()
        enqueue(conn, row)
    return view(row)


@app.delete("/api/uploads/{upload_id}")
def cancel(upload_id: UUID):
    with pool.connection() as conn:
        row = get_row(conn, upload_id, lock=True)
        if row["status"] in ("cancelled", "expired"):
            return view(row)
        assert_uploading(row)
        try:
            storage.abort_multipart_upload(
                Bucket=settings.bucket,
                Key=row["object_key"],
                UploadId=row["s3_upload_id"],
            )
        except ClientError as error:
            if error.response["Error"]["Code"] != "NoSuchUpload":
                raise
        storage.delete_object(Bucket=settings.bucket, Key=row["object_key"])
        row = conn.execute(
            "UPDATE ingestion.uploads SET status='cancelled', updated_at=now() WHERE id=%s RETURNING *",
            (upload_id,),
        ).fetchone()
    return view(row)


@app.post("/api/uploads/{upload_id}/retry")
def retry(upload_id: UUID):
    with pool.connection() as conn:
        row = get_row(conn, upload_id, lock=True)
        if row["status"] != "failed":
            raise HTTPException(409, "Only failed processing can be retried")
        row = conn.execute(
            """UPDATE ingestion.uploads SET status='queued', attempt=attempt+1,
            error=NULL, processed_files='[]', updated_at=now() WHERE id=%s RETURNING *""",
            (upload_id,),
        ).fetchone()
        enqueue(conn, row)
    return view(row)


@app.get("/api/uploads/{upload_id}/files/{file_id}/{role}")
def download(upload_id: UUID, file_id: str, role: str, download: bool = False):
    with pool.connection() as conn:
        row = get_row(conn, upload_id)
    if row["status"] != "completed":
        raise HTTPException(409, "Processed files are not available yet")
    artifact = next(
        (
            a
            for f in row["processed_files"]
            if f["id"] == file_id
            for a in f["artifacts"]
            if a["role"] == role
        ),
        None,
    )
    if not artifact:
        raise HTTPException(404, "Artifact not found")
    # Sign the configured public origin directly; rewriting a signed URL invalidates it.
    params = {"Bucket": settings.bucket, "Key": artifact["key"]}
    if download:
        params["ResponseContentDisposition"] = (
            'attachment; filename="' + artifact["key"].rsplit("/", 1)[-1] + '"'
        )
    return {
        "url": signer.generate_presigned_url(
            "get_object", Params=params, ExpiresIn=settings.url_ttl
        ),
        "expires_in": settings.url_ttl,
        "media_type": artifact["media_type"],
        "size": artifact["size"],
    }
