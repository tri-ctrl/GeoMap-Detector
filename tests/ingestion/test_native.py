import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from uuid import uuid4
from unittest.mock import patch

import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import from_bounds

from ingestion_common.contracts import IngestionRequest, Source
from ingestion_common.execution import run_processor
from processor.local import ingest


class NativeLocalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="geomap native ")
        self.root = Path(self.temp.name)
        self.output = self.root / "bundle"

    def tearDown(self):
        self.temp.cleanup()

    def test_cli_vector_bundle_has_durable_relative_artifacts(self):
        source = self.root / "a file.csv"
        source.write_text("name,lat,lon\nDXB,25.25,55.36\nPort,24,54\n")
        result = subprocess.run(
            [sys.executable, "-m", "processor.local", str(source), str(self.output)],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout)["files"], 1)
        manifest = json.loads((self.output / "manifest.json").read_text())
        layer = manifest["processed_files"][0]
        self.assertEqual(layer["bbox"], [54, 24, 55.36, 25.25])
        self.assertEqual(layer["feature_count"], 2)
        for artifact in layer["artifacts"]:
            path = self.output / artifact["key"]
            self.assertTrue(path.is_relative_to(self.output))
            self.assertEqual(path.stat().st_size, artifact["size"])
        data = self.output / next(
            a["key"] for a in layer["artifacts"] if a["role"] == "data"
        )
        self.assertEqual(
            json.loads(data.read_text())["features"][0]["properties"]["name"], "DXB"
        )

    def test_native_geotiff_cog_and_web_mercator_preview(self):
        source = self.root / "image.tif"
        with rasterio.open(
            source,
            "w",
            driver="GTiff",
            width=20,
            height=20,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=from_bounds(54, 24, 55, 25, 20, 20),
        ) as dataset:
            dataset.write(np.arange(400, dtype=np.uint8).reshape(1, 20, 20))
        manifest = ingest(source, self.output)
        layer = manifest["processed_files"][0]
        self.assertEqual(layer["kind"], "raster")
        data = next(a for a in layer["artifacts"] if a["role"] == "data")
        with rasterio.open(self.output / data["key"]) as cog:
            self.assertEqual(cog.tags(ns="IMAGE_STRUCTURE")["LAYOUT"], "COG")
        metadata = next(a for a in layer["artifacts"] if a["role"] == "metadata")
        self.assertEqual(
            json.loads((self.output / metadata["key"]).read_text())["preview_crs"],
            "EPSG:3857",
        )

    def test_unlocated_asset_survives_removal_of_input(self):
        source = self.root / "photo.png"
        Image.new("RGB", (8, 8), "red").save(source)
        manifest = ingest(source, self.output)
        source.unlink()
        layer = manifest["processed_files"][0]
        self.assertIsNone(layer["bbox"])
        data = next(a for a in layer["artifacts"] if a["role"] == "data")
        with Image.open(self.output / data["key"]) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))

    def test_failed_input_and_existing_output_leave_no_partial_bundle(self):
        source = self.root / "invalid.csv"
        source.write_text("lat,lon\n999,55\n")
        with self.assertRaisesRegex(ValueError, "row 2"):
            ingest(source, self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".geomap-ingest-*")))
        self.output.mkdir()
        marker = self.output / "preserve.txt"
        marker.write_text("keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            ingest(source, self.output)
        self.assertEqual(marker.read_text(), "keep")


class NativeExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native runner ")
        self.root = Path(self.temp.name)
        (self.root / "processor").mkdir()
        (self.root / "processor/__init__.py").touch()
        self.module = self.root / "processor/main.py"
        id_ = uuid4()
        self.request = IngestionRequest(
            upload_id=id_,
            attempt=1,
            source=Source(
                bucket="geomap-files",
                key=f"uploads/{id_}/file.csv",
                name="file.csv",
                size=20,
            ),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_request_handoff_uses_stdin_and_correct_python_environment(self):
        output = self.root / "request.json"
        self.module.write_text(
            "import json,os,sys\nfrom pathlib import Path\nassert sys.argv[1:]==['--request-stdin']\nassert 'INGESTION_REQUEST' not in os.environ\nPath(os.environ['NATIVE_TEST_OUTPUT']).write_text(sys.stdin.read())\n"
        )
        run_processor(
            self.request,
            python=sys.executable,
            root=self.root,
            environment={
                "NATIVE_TEST_OUTPUT": str(output),
                "INGESTION_REQUEST": "stale",
            },
        )
        self.assertEqual(
            json.loads(output.read_text()), self.request.model_dump(mode="json")
        )

    def test_nonzero_processor_exit_is_a_failed_attempt(self):
        self.module.write_text("raise SystemExit(7)\n")
        with self.assertRaises(subprocess.CalledProcessError) as result:
            run_processor(self.request, root=self.root)
        self.assertEqual(result.exception.returncode, 7)

    def test_timeout_reaps_processor_and_decoder_descendant(self):
        marker = self.root / "decoder.pid"
        self.module.write_text(
            "import json,os,subprocess,sys,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\nPath(os.environ['TMPDIR'],'decoder.tmp').write_text('unfinished')\nPath(os.environ['NATIVE_TEST_OUTPUT']).write_text(json.dumps({'pid':p.pid,'scratch':os.environ['TMPDIR']}))\ntime.sleep(60)\n"
        )
        with self.assertRaises(subprocess.TimeoutExpired):
            run_processor(
                self.request,
                root=self.root,
                timeout=1,
                environment={"NATIVE_TEST_OUTPUT": str(marker)},
            )
        result = json.loads(marker.read_text())
        self.assertFalse(Path(result["scratch"]).exists())
        pid = result["pid"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            state = subprocess.check_output(
                ["ps", "-o", "stat=", "-p", str(pid)], text=True
            ).strip()
            self.assertTrue(
                state.startswith("Z"),
                "Decoder must be stopped, rather than continue processing",
            )

    def test_airflow_cancellation_reaps_the_process(self):
        self.module.write_text("import time;time.sleep(60)\n")
        original = subprocess.Popen
        children = []

        def start(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child

        with patch(
            "ingestion_common.execution.subprocess.Popen", side_effect=start
        ), patch.object(original, "communicate", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                run_processor(self.request, root=self.root)
        self.assertIsNotNone(children[0].poll())


if __name__ == "__main__":
    unittest.main()
