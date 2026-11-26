import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
import fiona
import rasterio
from PIL import Image
from rasterio.transform import from_bounds

from processor.vectors import extract_shapefile, vector_layers
from processor.rasters import raster_layers


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "input").mkdir()

    def tearDown(self):
        self.directory.cleanup()

    def test_csv_validation_and_geojson(self):
        source = self.root / "input/points.csv"
        source.write_text('name,lat,lon\nDXB,25.25,55.36\nPort,24,54\n')
        layer = vector_layers(source, self.root)[0]
        self.assertEqual(layer["feature_count"], 2)
        self.assertEqual(layer["bbox"], [54, 24, 55.36, 25.25])
        self.assertEqual(json.loads(layer["path"].read_text())["features"][0]["properties"]["name"], "DXB")
        source.write_text('name,lat,lon\nbad,999,55\n')
        with self.assertRaisesRegex(ValueError, "row 2"):
            vector_layers(source, self.root)

    def test_kml_polygon(self):
        source = self.root / "input/area.kml"
        source.write_text('<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>A</name><Polygon><outerBoundaryIs><LinearRing><coordinates>54,24 55,24 55,25 54,24</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>')
        self.assertEqual(vector_layers(source, self.root)[0]["feature_count"], 1)

    def test_projected_geopackage_and_zipped_shapefile(self):
        schema = {"geometry": "Point", "properties": {"name": "str"}}
        source = self.root / "input/layers.gpkg"
        for name in ("first", "second"):
            with fiona.open(source, "w", driver="GPKG", layer=name, crs="EPSG:3857", schema=schema) as dataset:
                dataset.write({"type": "Feature", "properties": {"name": name}, "geometry": {"type": "Point", "coordinates": [0, 0]}})
        layers = vector_layers(source, self.root)
        self.assertEqual(len(layers), 2)
        self.assertEqual(layers[0]["bbox"], [0, 0, 0, 0])
        folder = self.root / "shape"
        folder.mkdir()
        with fiona.open(folder / "points.shp", "w", driver="ESRI Shapefile", crs="EPSG:4326", schema=schema) as dataset:
            dataset.write({"type": "Feature", "properties": {"name": "UAE"}, "geometry": {"type": "Point", "coordinates": [55, 25]}})
        archive_path = self.root / "input/points.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            for file in folder.iterdir():
                archive.write(file, arcname=file.name)
        result = vector_layers(archive_path, self.root)[0]
        self.assertEqual(result["bbox"], [55, 25, 55, 25])

    def test_archive_path_traversal_and_missing_shapefile(self):
        source = self.root / "input/bad.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("../escape.shp", "bad")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            extract_shapefile(source, self.root / "extract")
        self.assertFalse((self.root / "escape.shp").exists())

    def test_raster_cog_and_projected_preview(self):
        source = self.root / "input/image.tif"
        with rasterio.open(source, "w", driver="GTiff", width=40, height=30, count=3, dtype="uint8",
                           crs="EPSG:4326", transform=from_bounds(54, 24, 55, 25, 40, 30)) as dataset:
            dataset.write(np.full((3, 30, 40), 100, dtype=np.uint8))
        layer = raster_layers(source, self.root)[0]
        with rasterio.open(layer["path"]) as cog:
            self.assertEqual(cog.tags(ns="IMAGE_STRUCTURE").get("LAYOUT"), "COG")
        with Image.open(layer["preview"]) as preview:
            self.assertLessEqual(max(preview.size), 2048)
            self.assertEqual(preview.mode, "RGBA")
        self.assertEqual(layer["bbox"], [54, 24, 55, 25])

    def test_missing_raster_projection_is_explicit(self):
        source = self.root / "input/unprojected.tif"
        with rasterio.open(source, "w", driver="GTiff", width=10, height=10, count=1, dtype="uint8") as dataset:
            dataset.write(np.zeros((1, 10, 10), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "no CRS"):
            raster_layers(source, self.root)


if __name__ == "__main__":
    unittest.main()
