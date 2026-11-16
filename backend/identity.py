"""Version-1 provenance and additive compatibility for optional server records."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path

_annotations_lock = threading.RLock()


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def prepare_aois(features: list[dict]) -> list[dict]:
    """Deduplicate external content before assigning internal IDs; never names."""
    output, seen, ids = [], set(), set()
    for feature in features:
        external = {k: v for k, v in feature.items() if k not in ("_gmd_id", "_gmd_aliases")}
        key = canonical(external)
        if key in seen:
            continue
        seen.add(key)
        feature = copy.deepcopy(feature)
        old = feature.get("_gmd_id")
        if not isinstance(old, str) or not old or old in ids:
            if old:
                feature["_gmd_aliases"] = list(dict.fromkeys([*feature.get("_gmd_aliases", []), old]))
            feature["_gmd_id"] = str(uuid.uuid4())
        ids.add(feature["_gmd_id"])
        output.append(feature)
    return output


def clip_id(job_id: str, aoi_id: str, release: int, model: str) -> str:
    return "gmd:c1:" + digest([job_id, aoi_id, release, model])


def geometry_key(geometry: dict):
    def ring(points):
        points = list(points)
        if points and points[0] == points[-1]:
            points.pop()
        if not points:
            return []
        start = min(range(len(points)), key=lambda i: canonical(points[i]))
        forward = points[start:] + points[:start]
        backward = [points[(start - i) % len(points)] for i in range(len(points))]
        return min((forward, backward), key=canonical)

    if geometry.get("type") == "Polygon":
        rings = geometry["coordinates"]
        return ["Polygon", ring(rings[0]), *sorted((ring(r) for r in rings[1:]), key=canonical)]
    return geometry


def prediction_id(scope: str, geometry: dict, cls: str, occurrence: int = 0) -> str:
    return f"gmd:p1:{scope}:{digest([cls, geometry_key(geometry)])}:{occurrence}"


def upsert_annotations(current: dict, incoming: dict, replace_ids: bool = True) -> dict:
    """Only explicit scopes authorize replacement. Preserve conflicting legacy IDs."""
    features = copy.deepcopy(current.get("features", []))
    positions = {}
    for i, feature in enumerate(features):
        scope = (feature.get("properties") or {}).get("gmd_clip_id")
        if scope and feature.get("id") is not None:
            key = (scope, canonical(feature["id"]))
            # Ambiguous existing duplicates cannot authorize an overwrite.
            positions[key] = i if key not in positions else None
    exact = {canonical(f) for f in features}
    for feature in incoming.get("features", []):
        if replace_ids and canonical(feature) in exact:
            continue
        scope = (feature.get("properties") or {}).get("gmd_clip_id")
        key = (scope, canonical(feature.get("id")))
        index = positions.get(key) if scope and feature.get("id") is not None and replace_ids else None
        if index is not None:
            exact.discard(canonical(features[index]))
            features[index] = copy.deepcopy(feature)
        else:
            features.append(copy.deepcopy(feature))
            if scope and feature.get("id") is not None and key not in positions:
                positions[key] = len(features) - 1
        exact.add(canonical(feature))
    return {**current, "type": "FeatureCollection", "features": features}


def save_annotations(path: Path, incoming: dict, replace_ids: bool = True) -> dict:
    """Atomic additive migration; keep the original file as an immutable backup."""
    with _annotations_lock:
        current = json.loads(path.read_text()) if path.exists() else {"type": "FeatureCollection", "features": []}
        output = upsert_annotations(current, incoming, replace_ids)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            backup = path.with_name(path.stem + ".legacy-v1" + path.suffix)
            created = False
            try:
                with backup.open("xb") as stream:
                    created = True
                    stream.write(path.read_bytes())
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                saved = json.loads(backup.read_text())
                if not isinstance(saved, dict) or saved.get("type") != "FeatureCollection" or not isinstance(saved.get("features"), list):
                    raise ValueError("Invalid annotation backup; current file preserved")
            except BaseException:
                if created:
                    backup.unlink(missing_ok=True)
                raise
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".annotations-", delete=False) as stream:
                temp = Path(stream.name)
                json.dump(output, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            if json.loads(path.read_text()) != output:
                raise ValueError("Annotation read-back verification failed; original backup retained")
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
        return output
