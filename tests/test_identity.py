"""Identity/file contracts exercise real code without ML or imagery dependencies."""
import copy
import hashlib
import importlib.util
import json
import tempfile
import time
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename, modules=None):
    spec = importlib.util.spec_from_file_location(name, ROOT / "backend" / filename)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict("sys.modules", modules or {}):
        spec.loader.exec_module(module)
    return module


identity = load("gmd_identity", "identity.py")


def feature(name="Same name", x=55):
    return {"type": "Feature", "id": "external-business-id", "properties": {"name": name, "unknown": {"kept": True}},
            "geometry": {"type": "Polygon", "coordinates": [[[x, 25], [x + .01, 25], [x + .01, 25.01], [x, 25]]]}}


def annotation(scope=None, status="verified", x=55):
    f = feature(x=x)
    f["id"] = "same-rank-id"
    f["properties"].update(status=status, release=101, **({"gmd_clip_id": scope} if scope else {}))
    return f


class IdentityTests(unittest.TestCase):
    def test_aois_dedupe_before_uuid_assignment_and_preserve_business_ids(self):
        a, b = feature(), feature(x=56)
        a["_gmd_id"] = b["_gmd_id"] = "collision"
        duplicate = {**copy.deepcopy(a), "_gmd_id": "other"}
        inputs = [a, b, duplicate]
        original = copy.deepcopy(inputs)
        result = identity.prepare_aois(inputs)
        self.assertEqual(len(result), 2)
        self.assertNotEqual(result[0]["_gmd_id"], result[1]["_gmd_id"])
        self.assertEqual(result[1]["id"], "external-business-id")
        self.assertEqual(inputs, original)
        identifier = result[0]["_gmd_id"]
        result[0]["properties"]["name"] = "Renamed"
        self.assertEqual(identity.prepare_aois(result)[0]["_gmd_id"], identifier)

    def test_clips_cover_all_provenance_and_predictions_ignore_rank(self):
        base = ["job", "aoi", 101, "model"]
        scope = identity.clip_id(*base)
        for index in range(4):
            other = base.copy()
            other[index] = str(other[index]) + "different"
            self.assertNotEqual(identity.clip_id(*other), scope)
        geom = feature()["geometry"]
        first = identity.prediction_id(scope, geom, "aircraft")
        rotated = copy.deepcopy(geom)
        ring = rotated["coordinates"][0][:-1]
        ring = ring[1:] + ring[:1]
        rotated["coordinates"][0] = list(reversed(ring + ring[:1]))
        self.assertEqual(first, identity.prediction_id(scope, rotated, "aircraft"))
        self.assertNotEqual(first, identity.prediction_id("another-clip", geom, "aircraft"))
        self.assertNotEqual(first, identity.prediction_id(scope, geom, "aircraft", 1))

    def test_annotation_upserts_preserve_conflicting_legacy_and_scope_different_jobs(self):
        legacy = annotation()
        current = {"type": "FeatureCollection", "unknown": {"kept": 1}, "features": [legacy, copy.deepcopy(legacy)]}
        incoming = {"features": [annotation("job-a"), annotation("job-b", "corrected")]}
        result = identity.upsert_annotations(current, incoming)
        self.assertEqual(len(result["features"]), 4)
        result = identity.upsert_annotations(result, {"features": [annotation("job-a", "rejected")]})
        self.assertEqual(len(result["features"]), 4)
        self.assertEqual(result["features"][3]["properties"]["status"], "corrected")
        self.assertEqual(result["features"][2]["properties"]["status"], "rejected")
        self.assertEqual(result["features"][:2], current["features"])
        self.assertEqual(result["unknown"], {"kept": 1})
        self.assertEqual(identity.upsert_annotations(result, incoming)["features"][:2], current["features"])
        appended = identity.upsert_annotations(current, {"features": [legacy]}, replace_ids=False)
        self.assertEqual(len(appended["features"]), 3)

    def test_atomic_annotation_failure_preserves_original_backup_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "annotations.geojson"
            original = {"type": "FeatureCollection", "features": [annotation()]}
            path.write_text(json.dumps(original))
            with mock.patch.object(identity.os, "replace", side_effect=OSError("Interrupted write")):
                with self.assertRaises(OSError):
                    identity.save_annotations(path, {"features": [annotation("job-a")]})
            self.assertEqual(json.loads(path.read_text()), original)
            backup = path.with_name("annotations.legacy-v1.geojson")
            self.assertEqual(json.loads(backup.read_text()), original)
            self.assertFalse(list(Path(directory).glob(".annotations-*")))
            saved = identity.save_annotations(path, {"features": [annotation("job-a")]})
            self.assertEqual(len(saved["features"]), 2)
            self.assertEqual(json.loads(backup.read_text()), original)

    def dependencies(self):
        geometry = types.ModuleType("shapely.geometry")
        geometry.mapping = lambda g: g.geometry
        geometry.shape = lambda value: types.SimpleNamespace(geometry=value, geom_type="Polygon", centroid=types.SimpleNamespace(x=55, y=25))
        geometry.Polygon = object
        wayback = types.ModuleType("wayback")
        wayback.Raster = object
        wayback.get_releases = lambda: [{"release": 101, "date": "2026-10-29"}]
        wayback.build_raster = lambda *args, **kwargs: types.SimpleNamespace(zoom=18, ground_res=lambda lat: 1)
        wayback.raster_bounds_ll = lambda ras: [55, 25, 56, 26]

        def save_raster(ras, directory):
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "image.png").write_bytes(b"fixture pixels")
            return {"png": "image.png"}
        wayback.save_raster = save_raster
        return {"identity": identity, "wayback": wayback, "shapely": types.ModuleType("shapely"), "shapely.geometry": geometry, "numpy": types.ModuleType("numpy")}

    def test_real_pipeline_isolates_colliding_names_and_exports_alias_manifest(self):
        modules = self.dependencies()
        pipeline = load("gmd_pipeline", "pipeline.py", modules)
        with tempfile.TemporaryDirectory() as directory:
            pipeline.OUT_DIR = Path(directory)
            params = {"aois": {"type": "FeatureCollection", "features": [feature("A B"), feature("A_B", 56)]}, "detect": False}
            original = copy.deepcopy(params)
            with mock.patch.object(pipeline.threading, "Thread"):
                job_id = pipeline.start_job(params)
            self.assertEqual(params, original)
            pipeline._run(job_id)
            job = pipeline.JOBS[job_id]
            self.assertEqual(job["status"], "done", job["log"])
            rows = job["results"]
            self.assertEqual(len({r["path"] for r in rows}), 2)
            self.assertEqual(len({r["storeId"] for r in rows}), 2)
            self.assertEqual(rows[0]["legacy_path"], rows[1]["legacy_path"])
            for row in rows:
                output = json.loads((pipeline.OUT_DIR / job_id / row["path"] / "aoi.geojson").read_text())
                self.assertEqual(output["id"], "external-business-id")
                self.assertEqual(output["properties"]["unknown"], {"kept": True})
            with zipfile.ZipFile(pipeline.OUT_DIR / (job_id + ".zip")) as archive:
                self.assertEqual(len([n for n in archive.namelist() if n.endswith("/image.png")]), 2)
                summary = json.loads(archive.read(job_id + "/summary.json"))
                self.assertEqual(summary["identity_schema"], 1)

    def test_real_detector_feature_conversion_keeps_geometry_and_ids_across_confidence_reordering(self):
        detector = load("gmd_detector", "detector.py", self.dependencies())

        def detection(x, confidence):
            return {"cls": "aircraft", "conf": confidence, "poly": types.SimpleNamespace(
                exterior=types.SimpleNamespace(coords=[(x, 0), (x + 1, 0), (x + 1, 1), (x, 1), (x, 0)]), centroid=types.SimpleNamespace(x=x + .5, y=.5))}
        raster = types.SimpleNamespace(pixel_to_lonlat=lambda x, y: (55 + x / 100, 25 + y / 100), ground_res=lambda lat: 1)
        props = {"aoi_id": "A", "release": 101, "gmd_clip_id": "clip"}
        first = detector.to_features([detection(0, .9), detection(2, .8)], raster, props)
        second = detector.to_features([detection(2, .95), detection(0, .7)], raster, props)
        self.assertEqual(first[0]["id"], second[1]["id"])
        self.assertEqual(first[1]["id"], second[0]["id"])
        self.assertEqual(first[0]["geometry"], second[1]["geometry"])
        self.assertEqual(first[0]["properties"]["gmd_legacy_ids"], ["A_101_0000"])

    def test_checkpoint_fingerprint_reads_actual_model_bytes(self):
        detector = load("gmd_detector", "detector.py", self.dependencies())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.pt"
            path.write_bytes(b"checkpoint one")
            detector.load_model = lambda name: types.SimpleNamespace(ckpt_path=str(path))
            self.assertEqual(detector.model_fingerprint(), "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest())
            previous = detector.model_fingerprint()
            path.write_bytes(b"checkpoint two")
            self.assertNotEqual(previous, detector.model_fingerprint())

    def test_cached_model_keeps_its_loaded_fingerprint_when_the_filename_is_replaced(self):
        detector = load("gmd_detector", "detector.py", self.dependencies())
        with tempfile.TemporaryDirectory() as directory:
            detector.MODELS_DIR = Path(directory)
            path = Path(directory) / "model.pt"
            path.write_bytes(b"loaded checkpoint")
            ultralytics = types.ModuleType("ultralytics")
            ultralytics.YOLO = lambda source: types.SimpleNamespace(ckpt_path=source, loaded=Path(source).read_bytes())
            with mock.patch.dict("sys.modules", {"ultralytics": ultralytics}):
                model = detector.load_model("model.pt")
                original = detector.model_fingerprint("model.pt")
                path.write_bytes(b"replacement checkpoint")
                self.assertIs(detector.load_model("model.pt"), model)
                self.assertEqual(detector.model_fingerprint("model.pt"), original)
                self.assertEqual(original, "sha256:" + hashlib.sha256(model.loaded).hexdigest())


if __name__ == "__main__":
    unittest.main()
