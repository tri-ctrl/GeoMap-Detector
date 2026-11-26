#!/usr/bin/env python3
"""Real HTTP → multipart MinIO → Kafka → Airflow Docker task → catalog smoke test.

Run after docker compose up -d: python3 scripts/smoke_ingestion.py
Creates test upload records/artifacts in this application's stack.
"""
import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8095")
    parser.add_argument("--timeout", default=600, type=int)
    args = parser.parse_args()
    base = args.url.rstrip("/")

    def request(path, body=None, method=None, expected=200, headers=None):
        payload = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=payload, method=method or ("POST" if payload is not None else "GET"),
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                assert response.status == expected, (response.status, expected)
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != expected:
                raise RuntimeError(f"{path}: HTTP {error.code}: {error.read().decode()}") from error
            return json.load(error)

    def initialize(name, data):
        body = {"id": str(uuid4()), "name": name, "size": len(data), "fingerprint": hashlib.sha256(data).hexdigest()}
        session = request("/api/uploads", body, expected=201)
        same = request("/api/uploads", body, expected=201)
        assert same["id"] == session["id"]
        return session

    def upload(name, data, verify_resume=False):
        session = initialize(name, data)
        path = f"/api/uploads/{session['id']}"
        count = (len(data) + session["part_size"] - 1) // session["part_size"]
        parts = []
        for number in range(1, count + 1):
            signed = request(path + f"/parts/{number}", {}, method="POST")
            start = (number - 1) * session["part_size"]
            chunk = data[start:start + session["part_size"]]
            req = urllib.request.Request(signed["url"], method="PUT", data=chunk, headers={"Origin": base})
            with urllib.request.urlopen(req, timeout=120) as response:
                assert response.status == 200
                etag = response.headers["ETag"].strip('"')
                exposed = response.headers.get("Access-Control-Expose-Headers", "").lower()
                assert "etag" in exposed, "MinIO must expose ETag to the browser"
                assert response.headers.get("Access-Control-Allow-Origin") in (base, "*")
            parts.append({"part_number": number, "etag": etag})
            if number == 1 and verify_resume:
                assert count >= 2, "Fixture must cover multiple chunks"
                listed = request(path + "/parts")["parts"]
                assert len(listed) == 1 and listed[0]["size"] == len(chunk)
                request(path + "/complete", {"parts": parts}, expected=409)
                print("Verified persisted first part and rejection of premature completion", flush=True)
        queued = request(path + "/complete", {"parts": parts})
        assert queued["status"] in ("queued", "processing", "completed", "failed")
        repeated = request(path + "/complete", {"parts": parts})
        assert repeated["attempt"] == 1
        return session

    def wait_for(session, expected):
        deadline = time.monotonic() + args.timeout
        last = None
        while time.monotonic() < deadline:
            row = request(f"/api/uploads/{session['id']}")
            if row["status"] != last:
                print(session["name"], row["id"], row["status"], flush=True)
                last = row["status"]
            if row["status"] in ("completed", "failed"):
                assert row["status"] == expected, row
                return row
            time.sleep(2)
        raise TimeoutError(f"Ingestion did not finish: {session['id']}; inspect docker compose logs and Airflow")

    assert request("/api/ingestion/health")["ok"]
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Smoke DXB"},
          "geometry": {"type": "Polygon", "coordinates": [[[55.35, 25.24], [55.37, 25.24], [55.37, 25.26], [55.35, 25.24]]]}}]}
    # Exactly one byte beyond a part boundary reproduces the reference uploader's off-by-one risk.
    encoded = json.dumps(fc).encode()
    data = encoded + b" " * (16 * 1024**2 + 1 - len(encoded))
    good = upload("smoke-multipart.geojson", data, verify_resume=True)
    completed = wait_for(good, "completed")
    file = completed["processed_files"][0]
    assert file["kind"] == "vector" and file["feature_count"] == 1
    signed = request(f"/api/uploads/{good['id']}/files/{file['id']}/data")
    with urllib.request.urlopen(signed["url"], timeout=30) as response:
        processed = json.load(response)
    assert processed["features"][0]["geometry"] == fc["features"][0]["geometry"]

    bad = upload("smoke-invalid.csv", b"name,lat,lon\nbad,999,55\n")
    failed = wait_for(bad, "failed")
    assert "latitude" in failed["error"].lower(), failed
    retried = request(f"/api/uploads/{bad['id']}/retry", {}, method="POST")
    assert retried["attempt"] == 2
    failed_again = wait_for(bad, "failed")
    assert failed_again["attempt"] == 2 and not failed_again["processed_files"]

    cancelled = initialize("smoke-cancelled.csv", b"lat,lon\n25,55\n")
    request(f"/api/uploads/{cancelled['id']}", method="DELETE")
    request(f"/api/uploads/{cancelled['id']}/parts/1", {}, method="POST", expected=409)
    print(json.dumps({"ok": True, "multipart_upload": good["id"], "failed_and_retried": bad["id"],
                      "cancelled": cancelled["id"], "checks": ["multipart boundary", "resume", "CORS ETag", "completion deduplication",
                      "Airflow Docker Kafka round trip", "processed download", "failure", "retry", "cancel"]}, indent=2))


if __name__ == "__main__":
    main()
