"""Batch job: for every AOI x every selected Wayback release ->
clip imagery to AOI, detect objects, write GeoJSON + images, build a zip export."""
from __future__ import annotations

import json
import copy
import re
import threading
import time
import traceback
import uuid
import zipfile
from pathlib import Path

from shapely.geometry import mapping, shape

import wayback
import identity
from telemetry import Trace

OUT_DIR = Path(__file__).resolve().parent.parent / "outputs"
JOBS: dict[str, dict] = {}


def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(s)).strip("_")[:60] or "aoi"


def aoi_name(f: dict, i: int) -> str:
    p = f.get("properties") or {}
    for k in ("name", "Name", "NAME", "iata", "IATA", "icao", "ICAO", "id", "title"):
        if p.get(k):
            return str(p[k])
    return f"AOI_{i + 1}"


def resolve_releases(geom, mode: str, chosen: list[int], zoom: int) -> list[dict]:
    if mode == "latest":
        return wayback.get_releases()[:1]
    if mode == "local":
        c = geom.representative_point()
        return wayback.local_change_releases(c.x, c.y, min(zoom, 17))
    return [wayback.release_info(r) for r in chosen]


def start_job(params: dict) -> str:
    params = copy.deepcopy(params)
    params["aois"]["features"] = identity.prepare_aois(params["aois"]["features"])
    job_id = time.strftime("%Y%m%d_%H%M%S_") + str(uuid.uuid4())
    JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0.0, "log": [], "params": params,
                    "results": [], "started": time.time()}
    threading.Thread(target=_run, args=(job_id,), daemon=True).start()
    return job_id


def _log(job, msg):
    job["log"].append(f'{time.strftime("%H:%M:%S")}  {msg}')


def job_diagnostics(job):
    trace = job.get("_diagnostic_trace")
    return trace.snapshot() if trace else job.get("diagnostics")


def _stage(job, name, **tags):
    return job["_diagnostic_trace"].span(name, jobId=job["id"], parentId=job.get("_diagnostic_parent"), **tags)


def _run(job_id: str):
    job = JOBS[job_id]
    job.setdefault("id", job_id)
    trace = job["_diagnostic_trace"] = Trace()
    try:
        with trace.span("job", jobId=job_id) as parent:
            job["_diagnostic_parent"] = parent
            _run_owned(job_id)
    except Exception as error:
        if job.get("status") != "error":
            job["status"] = "error"
            _log(job, f"ERROR: {error}")
    finally:
        job["diagnostics"] = trace.snapshot()
        job.pop("_diagnostic_trace", None)
        job.pop("_diagnostic_parent", None)
        # Optional sidecar: older summaries/API responses remain readable. The
        # original archive is unchanged; the local diagnostics download is separate.
        root = OUT_DIR / job_id
        temporary = root / (".diagnostics-" + str(uuid.uuid4()) + ".tmp")
        try:
            if root.is_dir():
                temporary.write_text(json.dumps(job["diagnostics"]))
                temporary.replace(root / "diagnostics.json")
        except OSError:
            job["diagnostics"]["persistence"] = "unavailable"
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _run_owned(job_id: str):
    job = JOBS[job_id]
    p = job["params"]
    root = OUT_DIR / job_id
    root.mkdir(parents=True, exist_ok=True)
    job["status"] = "running"
    all_feats, summary = [], []
    try:
        aois = identity.prepare_aois(p["aois"]["features"])
        p["aois"]["features"] = aois
        zoom = int(p.get("zoom", 18))
        detect_on = p.get("detect", True)
        with _stage(job, "model.load", modelKey=p.get("model"), provider="server"):
            if detect_on:
                import detector  # heavy import only when needed
            model_id = detector.model_fingerprint(p.get("model")) if detect_on else "imagery"
        p["model_fingerprint"] = model_id
        (root / "aois.geojson").write_text(json.dumps(p["aois"]))

        plan = []
        for i, f in enumerate(aois):
            geom = shape(f["geometry"])
            if geom.geom_type not in ("Polygon", "MultiPolygon"):
                geom = geom.buffer(0.01)                    # point/line AOI -> ~1 km buffer
            name = aoi_name(f, i)
            with _stage(job, "job", stage="dates"):
                rels = resolve_releases(geom, p.get("release_mode", "latest"), p.get("releases", []), zoom)
            _log(job, f"{name}: {len(rels)} release(s) — " + ", ".join(r["date"] for r in rels[:8])
                 + (" …" if len(rels) > 8 else ""))
            for r in rels:
                plan.append((i, name, geom, r))

        for n, (i, name, geom, rel) in enumerate(plan):
            base = n / len(plan)
            step = 1 / len(plan)
            feature = aois[i]
            clip_id = identity.clip_id(job_id, feature["_gmd_id"], rel["release"], model_id)
            legacy_path = f'{slug(name)}/{rel["date"] or rel["release"]}'
            sub = root / (slug(name) + "__" + identity.digest(feature["_gmd_id"])) / (str(rel["release"]) + "__" + clip_id.split(":")[-1])
            _log(job, f"[{n + 1}/{len(plan)}] {name} · {rel['date']} — fetching imagery")
            with _stage(job, "imagery", clipId=clip_id, zoom=zoom):
                ras = wayback.build_raster(geom, rel["release"], zoom,
                                           progress=lambda f: job.__setitem__("progress", base + step * 0.5 * f))
            job["_diagnostic_trace"].count("rasterBytes", getattr(getattr(ras, "image", None), "nbytes", 0) + getattr(getattr(ras, "mask", None), "nbytes", 0))
            with _stage(job, "export.output", clipId=clip_id, stage="raster.encode", zoom=ras.zoom):
                files = wayback.save_raster(ras, sub)
            bounds = wayback.raster_bounds_ll(ras)
            props = {"aoi_id": slug(name), "aoi_name": name, "release": rel["release"],
                     "gmd_identity_version": 1, "gmd_job_id": job_id, "gmd_clip_id": clip_id,
                     "gmd_aoi_id": feature["_gmd_id"], "gmd_model_id": model_id, "gmd_model_key": p.get("model"),
                     "imagery_date": rel["date"], "zoom": ras.zoom,
                     "gsd_m": round(ras.ground_res(geom.centroid.y), 3), "source": "Esri Wayback"}
            feats, counts = [], {}
            if detect_on and ras.mask.any():
                _log(job, f"    detecting ({ras.image.shape[1]}×{ras.image.shape[0]} px, z{ras.zoom})")
                with _stage(job, "inference", clipId=clip_id, modelFingerprint=model_id, provider="server", zoom=ras.zoom):
                    dets = detector.detect(ras, p.get("model"), p.get("classes") or None,
                                           float(p.get("conf", 0.3)),
                                           progress=lambda f: job.__setitem__("progress", base + step * (0.5 + 0.5 * f)))
                feats = detector.to_features(dets, ras, props)
                detector.draw_preview(ras, dets, sub / "preview_detections.jpg")
                files["preview"] = "preview_detections.jpg"
                for ft in feats:
                    counts[ft["properties"]["class"]] = counts.get(ft["properties"]["class"], 0) + 1
            fc = {"type": "FeatureCollection", "features": feats,
                  "properties": {**props, "image_bounds": bounds}}
            (sub / "detections.geojson").write_text(json.dumps(fc))
            (sub / "aoi.geojson").write_text(json.dumps(
                {**feature, "geometry": mapping(geom)}))
            all_feats.extend(feats)
            rel_path = sub.relative_to(root).as_posix()
            entry = {"aoi": name, "aoi_id": slug(name), "release": rel["release"], "date": rel["date"],
                     "storeId": clip_id, "identity": props, "aoiFeature": feature, "legacy_path": legacy_path,
                     "zoom": ras.zoom, "bounds": bounds, "path": rel_path, "files": files,
                     "counts": counts, "total": len(feats)}
            summary.append(entry)
            for filename in files.values():
                file = sub / filename
                if file.is_file():
                    job["_diagnostic_trace"].count("encodedBytes", file.stat().st_size)
            job["results"] = summary
            _log(job, f"    {len(feats)} objects " + (str(counts) if counts else ""))
            job["progress"] = base + step

        (root / "all_detections.geojson").write_text(json.dumps(
            {"type": "FeatureCollection", "features": all_feats}))
        (root / "summary.json").write_text(json.dumps(
            {"job": job_id, "identity_schema": 1, "createdAt": int(job["started"] * 1000),
             "params": {k: v for k, v in p.items() if k != "aois"}, "results": summary}, indent=2))
        with _stage(job, "export.zip"):
            archive = make_zip(job_id)
            job["_diagnostic_trace"].count("archiveBytes", archive.stat().st_size)
        job["status"] = "done"
        job["progress"] = 1.0
        _log(job, f"Finished: {len(all_feats)} objects across {len(summary)} AOI/date clips")
    except Exception as e:
        job["status"] = "error"
        _log(job, f"ERROR: {e}")
        _log(job, traceback.format_exc().splitlines()[-1])
        raise


def make_zip(job_id: str) -> Path:
    root = OUT_DIR / job_id
    zpath = OUT_DIR / f"{job_id}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in root.rglob("*"):
            if f.is_file():
                z.write(f, f"{job_id}/{f.relative_to(root).as_posix()}")
    return zpath
