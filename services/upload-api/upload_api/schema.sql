CREATE SCHEMA IF NOT EXISTS ingestion;
CREATE TABLE IF NOT EXISTS ingestion.uploads (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    size bigint NOT NULL CHECK (size > 0),
    fingerprint text NOT NULL,
    content_type text NOT NULL,
    object_key text NOT NULL UNIQUE,
    s3_upload_id text NOT NULL,
    part_size integer NOT NULL,
    status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','queued','processing','completed','failed','cancelled','expired')),
    attempt integer NOT NULL DEFAULT 1,
    error text,
    processed_files jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS uploads_created_idx ON ingestion.uploads (created_at DESC);
CREATE TABLE IF NOT EXISTS ingestion.outbox (
    id text PRIMARY KEY,
    upload_id uuid NOT NULL REFERENCES ingestion.uploads(id),
    payload jsonb NOT NULL,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_unsent_idx ON ingestion.outbox (created_at) WHERE sent_at IS NULL;
