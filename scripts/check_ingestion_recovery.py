#!/usr/bin/env python3
"""Verify poison-message isolation and worker restart recovery in the local stack."""
import argparse
import hashlib
import json
import subprocess
import time
import urllib.request
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8095")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    # Both consumers must quarantine invalid events and continue to later work.
    poison_check = '''
import json, time
from uuid import uuid4
from ingestion_common.config import settings
from ingestion_common.messaging import consumer, producer, publish
marker = str(uuid4())
sender = producer()
listener = consumer(settings.dead_letter_topic, "recovery-check-" + marker)
for topic in (settings.request_topic, settings.result_topic):
    publish(sender, topic, marker, {"version": 99, "marker": marker})
seen = set()
deadline = time.monotonic() + 30
try:
    while len(seen) < 2 and time.monotonic() < deadline:
        message = listener.poll(1)
        if message is not None and not message.error():
            payload = json.loads(message.value())
            if marker in payload.get("payload", ""):
                seen.add(payload["topic"])
    assert len(seen) == 2, seen
finally:
    listener.close()
print("Both invalid events reached the dead-letter topic")
'''
    subprocess.run(["docker", "compose", "exec", "-T", "upload-api", "python", "-c", poison_check], check=True)
    data = b"name,lat,lon\nRecovery,25.25,55.36\n"
    id_ = str(uuid4())
    subprocess.run(["docker", "compose", "stop", "ingestion-worker"], check=True)
    try:
        request("/api/uploads", {"id": id_, "name": "smoke-recovery.csv", "size": len(data), "fingerprint": hashlib.sha256(data).hexdigest()})
        signed = request(f"/api/uploads/{id_}/parts/1", {})
        with urllib.request.urlopen(urllib.request.Request(signed["url"], data=data, method="PUT"), timeout=30) as response:
            etag = response.headers["ETag"].strip('"')
        request(f"/api/uploads/{id_}/complete", {"parts": [{"part_number": 1, "etag": etag}]})
        assert request(f"/api/uploads/{id_}")["status"] == "queued"
    finally:
        subprocess.run(["docker", "compose", "start", "ingestion-worker"], check=True)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        row = request(f"/api/uploads/{id_}")
        if row["status"] == "completed":
            assert row["processed_files"][0]["feature_count"] == 1
            print(json.dumps({"ok": True, "upload_id": id_, "dead_letter_consumers": 2,
                              "queued_while_worker_stopped": True, "completed_after_restart": True}, indent=2))
            return
        if row["status"] == "failed":
            raise AssertionError(row)
        time.sleep(2)
    raise TimeoutError("Queued upload did not recover after worker restart")


if __name__ == "__main__":
    main()
