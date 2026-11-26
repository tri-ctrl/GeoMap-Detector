import io
import json
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from PIL import Image
from processor.archives import extract
from processor.dispatch import process


class FormatTests(unittest.TestCase):
    def test_dwg_geographic_geometry(self):
        import subprocess

        source = self.root / "input.geojson"
        source.write_text(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "properties": {},
                            "geometry": {
                                "type": "Point",
                                "coordinates": [55.36, 25.25],
                            },
                        }
                    ],
                }
            )
        )
        drawing = self.root / "drawing.dxf"
        target = self.root / "drawing.dwg"
        subprocess.run(
            ["ogr2ogr", "-f", "DXF", str(drawing), str(source)],
            check=True,
            capture_output=True,
            timeout=30,
        )
        subprocess.run(
            ["dxf2dwg", "-o", str(target), str(drawing)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        layer = self.run_format(target)[0]
        self.assertEqual(layer["kind"], "vector")
        self.assertEqual(layer["bbox"], [55.36, 25.25, 55.36, 25.25])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_format(self, path):
        return process(path, self.root / "output")

    def test_kmz_and_tar_vector_contents(self):
        path = self.root / "data.kmz"
        kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>55,25</coordinates></Point></Placemark></kml>'
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("doc.kml", kml)
        self.assertEqual(self.run_format(path)[0]["bbox"], [55, 25, 55, 25])
        path = self.root / "data.tar"
        with tarfile.open(path, "w") as archive:
            info = tarfile.TarInfo("points.csv")
            content = b"lat,lon\n25,55\n"
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        self.assertEqual(self.run_format(path)[0]["kind"], "vector")

    def test_tar_rejects_links_and_traversal(self):
        for name in ("../escape", "symlink"):
            path = self.root / "unsafe.tar"
            with tarfile.open(path, "w") as archive:
                info = tarfile.TarInfo(name)
                if name == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../escape"
                archive.addfile(info, io.BytesIO())
            with self.assertRaises(ValueError):
                extract(path, self.root / "extract")

    def test_unlocated_image_is_not_a_fake_map_layer(self):
        path = self.root / "photo.png"
        Image.new("RGB", (20, 10), "red").save(path)
        layer = self.run_format(path)[0]
        self.assertEqual(layer["kind"], "image")
        self.assertIsNone(layer["bbox"])
        self.assertTrue(layer["preview"].exists())

    def test_pdf_preview(self):
        from pypdf import PdfWriter

        path = self.root / "document.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=120, height=120)
        with path.open("wb") as output:
            writer.write(output)
        layer = self.run_format(path)[0]
        self.assertEqual(layer["kind"], "document")
        self.assertIsNone(layer["bbox"])
        self.assertTrue(layer["preview"].exists())

    def test_spreadsheet_spatial_and_unlocated(self):
        from openpyxl import Workbook

        path = self.root / "points.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.append(["name", "lat", "lon"])
        sheet.append(["Dubai", 25, 55])
        book.save(path)
        book.close()
        layer = self.run_format(path)[0]
        self.assertEqual(layer["kind"], "vector")
        self.assertEqual(layer["bbox"], [55, 25, 55, 25])
        path = self.root / "table.xlsx"
        book = Workbook()
        book.active.append(["name", "value"])
        book.active.append(["A", 1])
        book.save(path)
        book.close()
        self.assertEqual(self.run_format(path)[0]["kind"], "document")

    def test_gpx_and_czml_geography(self):
        path = self.root / "track.gpx"
        path.write_text(
            '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="25" lon="55"/></trkseg></trk></gpx>'
        )
        self.assertEqual(self.run_format(path)[0]["bbox"], [55, 25, 55, 25])
        path = self.root / "points.czml"
        path.write_text(
            json.dumps(
                [
                    {"id": "document", "version": "1.0"},
                    {"id": "p", "position": {"cartographicDegrees": [55, 25, 10]}},
                ]
            )
        )
        self.assertEqual(self.run_format(path)[0]["kind"], "vector")

    def test_las_location_and_original_point_count(self):
        import laspy
        from pyproj import CRS

        path = self.root / "points.las"
        header = laspy.LasHeader(point_format=3, version="1.2")
        header.add_crs(CRS.from_epsg(4326))
        header.scales = [0.000001, 0.000001, 0.01]
        data = laspy.LasData(header)
        data.x = [55, 55.1]
        data.y = [25, 25.1]
        data.z = [1, 2]
        data.write(path)
        for extension in ("las", "laz"):
            target = path.with_suffix("." + extension)
            data.write(target)
            layer = self.run_format(target)[0]
            self.assertEqual(layer["feature_count"], 2)
            self.assertAlmostEqual(layer["bbox"][0], 55)

    def test_video_preview(self):
        import subprocess

        path = self.root / "movie.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=32x32:d=0.2",
                "-c:v",
                "mpeg4",
                str(path),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        layer = self.run_format(path)[0]
        self.assertEqual(layer["kind"], "video")
        self.assertIsNone(layer["bbox"])
        self.assertTrue(layer["preview"].exists())

    def test_application_package_keeps_unrecognized_contents(self):
        path = self.root / "workspace.giq"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("workspace.json", '{"id":"workspace"}')
        self.assertEqual(self.run_format(path)[0]["kind"], "package")

    def test_vector_mbtiles_coordinates(self):
        import sqlite3, mapbox_vector_tile

        path = self.root / "vectors.mbtiles"
        data = mapbox_vector_tile.encode(
            {
                "name": "places",
                "features": [
                    {
                        "geometry": {"type": "Point", "coordinates": [2048, 2048]},
                        "properties": {"name": "centre"},
                    }
                ],
            },
            default_options={"y_coord_down": True},
        )
        with sqlite3.connect(path) as database:
            database.execute("CREATE TABLE metadata(name TEXT,value TEXT)")
            database.execute("INSERT INTO metadata VALUES ('format','pbf')")
            database.execute(
                "CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB)"
            )
            database.execute("INSERT INTO tiles VALUES (0,0,0,?)", (data,))
        layer = self.run_format(path)[0]
        self.assertEqual(layer["bbox"], [0, 0, 0, 0])
        self.assertEqual(layer["feature_count"], 1)

    def test_raster_driver_family(self):
        import subprocess, numpy as np, rasterio
        from rasterio.transform import from_bounds

        source = self.root / "input.tif"
        with rasterio.open(
            source,
            "w",
            driver="GTiff",
            width=64,
            height=64,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=from_bounds(54, 24, 55, 25, 64, 64),
        ) as dataset:
            dataset.write(np.full((1, 64, 64), 100, dtype=np.uint8))
        for extension, driver, options in [
            ("jp2", "JP2OpenJPEG", []),
            ("ntf", "NITF", ["-co", "ICORDS=G"]),
            ("img", "HFA", []),
            ("nc", "netCDF", []),
            ("grb", "GRIB", []),
        ]:
            with self.subTest(extension=extension):
                target = self.root / ("raster." + extension)
                subprocess.run(
                    [
                        "gdal_translate",
                        "-q",
                        "-of",
                        driver,
                        *options,
                        str(source),
                        str(target),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
                layer = process(target, self.root / ("output-" + extension))[0]
                self.assertEqual(layer["kind"], "raster")
                self.assertTrue(layer["preview"].exists())


if __name__ == "__main__":
    unittest.main()
