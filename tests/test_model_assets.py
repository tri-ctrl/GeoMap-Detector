"""Model manifests must not be published without their referenced binaries."""
import importlib.util
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_onnx.py"
MODULE = importlib.util.spec_from_file_location(
    "export_onnx", SCRIPT
)
export_onnx = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(export_onnx)


class ModelAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)

    def manifest(self, entries):
        (self.out / "models.json").write_text(json.dumps(entries))

    def test_missing_binary_despite_manifest(self):
        self.manifest([{"file": "yolo11n-obb.onnx"}])
        with self.assertRaisesRegex(FileNotFoundError, "Missing or empty ONNX model"):
            export_onnx.check_models(self.out)

    def test_empty_binary(self):
        self.manifest([{"file": "yolo11n-obb.onnx"}])
        (self.out / "yolo11n-obb.onnx").touch()
        with self.assertRaises(FileNotFoundError):
            export_onnx.check_models(self.out)

    def test_every_manifest_entry_needs_a_binary(self):
        self.manifest([{"file": "nano.onnx"}, {"file": "small.onnx"}])
        (self.out / "nano.onnx").write_bytes(b"model bytes")
        with self.assertRaisesRegex(FileNotFoundError, "small.onnx"):
            export_onnx.check_models(self.out)
        (self.out / "small.onnx").write_bytes(b"model bytes")
        self.assertEqual(len(export_onnx.check_models(self.out)), 2)

    def test_empty_manifest(self):
        self.manifest([])
        with self.assertRaisesRegex(ValueError, "at least one exported model"):
            export_onnx.check_models(self.out)

    def test_missing_manifest(self):
        with self.assertRaisesRegex(FileNotFoundError, "Missing model manifest"):
            export_onnx.check_models(self.out)

    def test_invalid_manifest_json(self):
        (self.out / "models.json").write_text("{invalid json")
        with self.assertRaisesRegex(ValueError, "Invalid JSON in model manifest"):
            export_onnx.check_models(self.out)

    def test_manifest_must_be_a_list(self):
        self.manifest({"file": "nano.onnx"})
        with self.assertRaisesRegex(ValueError, "at least one exported model"):
            export_onnx.check_models(self.out)

    def test_entries_require_a_file_name(self):
        for entry in [None, "nano.onnx", {}, {"file": None}, {"file": 123}, {"file": " "}]:
            with self.subTest(entry=entry):
                self.manifest([entry])
                with self.assertRaisesRegex(ValueError, "expected a non-empty 'file' name"):
                    export_onnx.check_models(self.out)

    def check_cli(self, out=None):
        # -S excludes site-packages, like a fresh cache-hit runner without ML dependencies.
        return subprocess.run(
            [sys.executable, "-S", str(SCRIPT), "--check", "--out", str(out or self.out)],
            text=True, capture_output=True, timeout=10,
        )

    def test_check_cli_validates_cached_assets_without_ml_dependencies(self):
        self.manifest([{"file": "nano.onnx"}, {"file": "small.onnx"}])
        for name in ["nano.onnx", "small.onnx"]:
            (self.out / name).write_bytes(b"cached model bytes")
        result = self.check_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified 2 ONNX model(s)", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_check_cli_returns_failure_for_missing_binary(self):
        self.manifest([{"file": "nano.onnx"}])
        result = self.check_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Model asset check failed", result.stderr)
        self.assertIn("nano.onnx", result.stderr)
        self.assertIn("Run python scripts/export_onnx.py first", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_check_cli_returns_failure_for_invalid_manifest(self):
        (self.out / "models.json").write_text("not json")
        result = self.check_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid JSON in model manifest", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_normal_export_packages_both_default_models_for_later_cache_validation(self):
        # Fake only the expensive ML export; exercise real packaging, manifest, and check CLI.
        generated = self.out / "generated"
        generated.mkdir()
        published = self.out / "published"
        exported = []

        class FakeYOLO:
            names = {1: "ship", 0: "plane"}
            task = "obb"

            def __init__(self, weights):
                self.weights = weights

            def export(self, **options):
                exported.append(self.weights)
                onnx = generated / Path(self.weights).with_suffix(".onnx").name
                onnx.write_bytes(b"exported model bytes")
                return str(onnx)

        ultralytics = types.ModuleType("ultralytics")
        ultralytics.YOLO = FakeYOLO
        with mock.patch.dict(sys.modules, {"ultralytics": ultralytics}), mock.patch.object(
            sys, "argv", [str(SCRIPT), "--out", str(published)]
        ), contextlib.redirect_stdout(io.StringIO()):
            export_onnx.main()

        self.assertEqual(exported, ["yolo11n-obb.pt", "yolo11s-obb.pt"])
        entries = json.loads((published / "models.json").read_text())
        self.assertEqual([entry["file"] for entry in entries], ["yolo11n-obb.onnx", "yolo11s-obb.onnx"])
        self.assertEqual(entries[0]["names"], ["plane", "ship"])
        self.assertEqual(entries[0]["task"], "obb")
        result = self.check_cli(published)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified 2 ONNX model(s)", result.stdout)


if __name__ == "__main__":
    unittest.main()
