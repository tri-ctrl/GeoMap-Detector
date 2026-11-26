"""Format dispatch derived from the reference ingestion backend contract."""

import json
import math
import shutil
import sqlite3
import subprocess
from xml.etree import ElementTree as ET

import rasterio
from rasterio.shutil import copy as raster_copy
from shapely.geometry import mapping
from shapely import wkt

from ingestion_common.formats import (
    ARCHIVE_EXTENSIONS,
    IMAGE_EXTENSIONS,
    RASTER_EXTENSIONS,
    VECTOR_EXTENSIONS,
    VIDEO_EXTENSIONS,
)
from .archives import extract
from .assets import asset
from .rasters import raster_layers
from .vectors import MAX_VECTOR_BYTES, normalize, vector_layers


def native_info(path):
    try:
        result = subprocess.run(
            ["gdalinfo", "-json", str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as error:
        if str(path).lower().endswith(".ecw"):
            raise ValueError(
                "ECW requires a licensed GDAL ECW decoder in the processor image."
            ) from error
        raise ValueError(
            "GDAL could not read this raster: " + error.stderr[-500:]
        ) from error


def native_raster(path, workdir, info=None):
    info = info or native_info(path)
    width, height = info.get("size", [0, 0])
    bands = len(info.get("bands", []))
    if (
        not width
        or not height
        or not bands
        or bands > 32
        or width * height * bands * 8 > 16 * 1024**3
    ):
        raise ValueError(
            "Decoded raster exceeds the 16 GiB / 32-band conversion budget"
        )
    workdir.mkdir(parents=True, exist_ok=True)
    output = workdir / "decoded.tif"
    try:
        subprocess.run(
            [
                "gdal_translate",
                "-q",
                "-of",
                "GTiff",
                "-co",
                "TILED=YES",
                "-co",
                "BIGTIFF=IF_SAFER",
                str(path),
                str(output),
            ],
            check=True,
            capture_output=True,
            timeout=1200,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError(
            "Raster decoding failed: " + error.stderr.decode(errors="replace")[-500:]
        ) from error
    return raster_layers(output, workdir / "display")


def normalized(path, workdir, features, message=None):
    output = workdir / "features.geojson"
    count, bbox = normalize(features, output)
    return [
        {
            "name": path.stem,
            "kind": "vector",
            "path": output,
            "bbox": bbox,
            "feature_count": count,
            "message": message,
        }
    ]


def gpx_features(path):
    root = ET.parse(path).getroot()
    for tag in ("wpt", "rtept", "trkpt"):
        for point in root.findall(".//{*}" + tag):
            yield {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        float(point.attrib["lon"]),
                        float(point.attrib["lat"]),
                    ],
                },
                "properties": {
                    "name": point.findtext("{*}name", tag),
                    "time": point.findtext("{*}time", ""),
                },
            }


def spreadsheet(path, workdir):
    from openpyxl import load_workbook

    book = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = book.active
        iterator = sheet.iter_rows(values_only=True)
        headers = [str(v or "").strip().lower() for v in next(iterator, ())]
        if not {"lat", "lon"}.issubset(headers) and "wkt" not in headers:
            return asset(
                path,
                workdir,
                "document",
                "Spreadsheet has no lat/lon or WKT columns. Download it to inspect its contents.",
            )

        def features():
            for index, values in enumerate(iterator, 2):
                row = dict(zip(headers, values))
                try:
                    geometry = (
                        mapping(wkt.loads(row["wkt"]))
                        if row.get("wkt")
                        else {
                            "type": "Point",
                            "coordinates": [float(row["lon"]), float(row["lat"])],
                        }
                    )
                except (ValueError, TypeError, KeyError) as error:
                    raise ValueError(
                        f"Invalid geometry in spreadsheet row {index}"
                    ) from error
                yield {"type": "Feature", "geometry": geometry, "properties": row}

        return normalized(path, workdir, features())
    finally:
        book.close()


def czml(path, workdir):
    if path.stat().st_size > 20 * 1024**2:
        raise ValueError("CZML exceeds the 20 MiB normalization limit")
    packets = json.loads(path.read_text())
    if not isinstance(packets, list):
        raise ValueError("CZML must be an array of packets")
    features = []
    for packet in packets:
        position = packet.get("position", {}).get("cartographicDegrees")
        if position and len(position) >= 3:
            coordinates = position[:3] if len(position) == 3 else position[1:4]
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": coordinates},
                    "properties": {
                        "name": packet.get("name", packet.get("id", "Object"))
                    },
                }
            )
        for key, kind in (("polyline", "LineString"), ("polygon", "Polygon")):
            values = (
                packet.get(key, {}).get("positions", {}).get("cartographicDegrees", [])
            )
            if values:
                points = [values[i : i + 3] for i in range(0, len(values), 3)]
                if kind == "Polygon" and points[0] != points[-1]:
                    points.append(points[0])
                features.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": kind,
                            "coordinates": [points] if kind == "Polygon" else points,
                        },
                        "properties": {
                            "name": packet.get("name", packet.get("id", "Object"))
                        },
                    }
                )
    return (
        normalized(
            path,
            workdir,
            features,
            "Static geographic snapshot from CZML; download the source for its complete time-dependent content.",
        )
        if features
        else asset(
            path,
            workdir,
            message="CZML has no supported cartographic geometry. The original document is preserved.",
        )
    )


def pointcloud(path, workdir):
    import laspy
    from pyproj import Transformer

    with laspy.open(path) as source:
        crs = source.header.parse_crs()
        if crs is None:
            return asset(
                path,
                workdir,
                "pointcloud",
                "Point cloud has no CRS. Its source is preserved; a projection is required to place it on the globe.",
            )
        transform = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        stride = max(1, math.ceil(source.header.point_count / 8000))

        def features():
            offset = 0
            for points in source.chunk_iterator(100000):
                start = (-offset) % stride
                for x, y, z in zip(
                    points.x[start::stride],
                    points.y[start::stride],
                    points.z[start::stride],
                ):
                    lon, lat = transform.transform(x, y)
                    yield {
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [lon, lat, float(z)],
                        },
                        "properties": {},
                    }
                offset += len(points)

        return normalized(
            path,
            workdir,
            features(),
            f"Globe preview samples at most 8,000 of {source.header.point_count:,} points. The original point cloud is preserved.",
        )


def mbtiles(path, workdir):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as database:
        metadata = dict(database.execute("SELECT name,value FROM metadata"))
        if metadata.get("format", "").lower() not in ("pbf", "mvt"):
            return raster_layers(path, workdir)
        import mapbox_vector_tile

        levels = list(
            database.execute(
                "SELECT zoom_level,count(*) FROM tiles GROUP BY zoom_level ORDER BY zoom_level DESC"
            )
        )
        level = next((z for z, count in levels if count <= 512), None)
        if level is None:
            raise ValueError("Vector MBTiles exceeds the 512-tile normalization limit")

        def features():
            import gzip

            for x, y, data in database.execute(
                "SELECT tile_column,tile_row,tile_data FROM tiles WHERE zoom_level=?",
                (level,),
            ):
                if len(data) > 10 * 1024**2:
                    raise ValueError("MBTiles tile exceeds size limit")
                if data[:2] == b"\x1f\x8b":
                    from io import BytesIO

                    with gzip.GzipFile(fileobj=BytesIO(data)) as stream:
                        data = stream.read(10 * 1024**2 + 1)
                    if len(data) > 10 * 1024**2:
                        raise ValueError("Decompressed vector tile exceeds limit")
                for name, layer in mapbox_vector_tile.decode(
                    data, default_options={"y_coord_down": True}
                ).items():
                    extent = layer["extent"]
                    tile_y = 2**level - 1 - y

                    def coordinates(value):
                        if value and isinstance(value[0], (int, float)):
                            lon = (x + value[0] / extent) / 2**level * 360 - 180
                            lat = math.degrees(
                                math.atan(
                                    math.sinh(
                                        math.pi
                                        * (
                                            1
                                            - 2
                                            * (tile_y + value[1] / extent)
                                            / 2**level
                                        )
                                    )
                                )
                            )
                            return [lon, lat]
                        return [coordinates(v) for v in value]

                    for feature in layer["features"]:
                        feature["geometry"]["coordinates"] = coordinates(
                            feature["geometry"]["coordinates"]
                        )
                        feature.setdefault("properties", {})["source_layer"] = name
                        yield feature

        return normalized(
            path,
            workdir,
            features(),
            f"Vector tile snapshot at zoom {level}; boundary features may be split across tiles.",
        )


def process(path, workdir, depth=0):
    suffix = path.suffix.lower()
    workdir.mkdir(parents=True, exist_ok=True)
    if suffix in VECTOR_EXTENSIONS and path.stat().st_size > MAX_VECTOR_BYTES:
        raise ValueError("Vector input exceeds the 256 MiB processing limit")
    if suffix in ARCHIVE_EXTENSIONS:
        if depth >= 2:
            raise ValueError("Nested archive depth exceeds limit")
        files = extract(path, workdir / "extracted")
        outputs = []
        for index, file in enumerate(files):
            extension = file.suffix.lower()
            if (
                extension
                not in RASTER_EXTENSIONS
                | VECTOR_EXTENSIONS
                | IMAGE_EXTENSIONS
                | VIDEO_EXTENSIONS
                | {".pdf", ".mbtiles", ".las", ".laz"}
            ):
                continue
            # Sidecar JSON in a raster/vendor package is metadata, not a vector layer.
            if extension == ".json":
                try:
                    data = json.loads(file.read_text())
                    if not isinstance(data, dict) or data.get("type") not in (
                        "FeatureCollection",
                        "Feature",
                    ):
                        continue
                except (ValueError, UnicodeError):
                    continue
            outputs.extend(process(file, workdir / f"item-{index}", depth + 1))
            if len(outputs) > 20:
                raise ValueError("Package contains more than 20 processable layers")
        return outputs or asset(
            path,
            workdir,
            "package",
            "Package preserved. No supported geographic layers were found in its contents.",
        )
    if suffix in RASTER_EXTENSIONS:
        try:
            with rasterio.open(path):
                pass
        except rasterio.errors.RasterioIOError:
            info = native_info(path)
            subdatasets = [
                value
                for key, value in info.get("metadata", {})
                .get("SUBDATASETS", {})
                .items()
                if key.endswith("_NAME")
            ]
            if len(subdatasets) > 20:
                raise ValueError("Raster contains more than 20 subdatasets")
            if subdatasets:
                return [
                    layer
                    for index, subdataset in enumerate(subdatasets)
                    for layer in native_raster(subdataset, workdir / f"part-{index}")
                ]
            return native_raster(path, workdir, info)
        with rasterio.open(path) as source:
            if source.subdatasets:
                if len(source.subdatasets) > 20:
                    raise ValueError(
                        "Raster contains more than 20 subdatasets; select a subset before uploading"
                    )
                outputs = []
                for index, subdataset in enumerate(source.subdatasets[:20]):
                    target = workdir / f"subdataset-{index}.tif"
                    with rasterio.open(subdataset) as source:
                        if (
                            source.width * source.height > 4_000_000_000
                            or source.count > 32
                        ):
                            raise ValueError(
                                "Raster subdataset exceeds processing limits"
                            )
                    raster_copy(subdataset, target, driver="GTiff")
                    outputs.extend(raster_layers(target, workdir / f"part-{index}"))
                return outputs
        return raster_layers(path, workdir)
    if suffix in IMAGE_EXTENSIONS or suffix == ".pdf":
        try:
            with rasterio.open(path) as source:
                spatial = bool(source.crs)
        except rasterio.errors.RasterioIOError:
            spatial = False
            if suffix == ".pdf":
                info = native_info(path)
                if (info.get("coordinateSystem") or {}).get("wkt"):
                    return native_raster(path, workdir, info)
        return raster_layers(path, workdir) if spatial else asset(path, workdir)
    if suffix in VIDEO_EXTENSIONS:
        return asset(path, workdir)
    if suffix == ".xlsx":
        return spreadsheet(path, workdir)
    if suffix == ".gpx":
        return normalized(path, workdir, gpx_features(path))
    if suffix == ".czml":
        return czml(path, workdir)
    if suffix in (".las", ".laz"):
        return pointcloud(path, workdir)
    if suffix == ".mbtiles":
        return mbtiles(path, workdir)
    if suffix == ".dwg":
        converter = shutil.which("dwgread")
        if not converter:
            raise ValueError(
                "DWG requires the LibreDWG dwgread decoder in the processor image."
            )
        output = workdir / "drawing.geojson"
        subprocess.run(
            [converter, "-O", "GeoJSON", "-o", str(output), str(path)],
            check=True,
            capture_output=True,
            timeout=120,
        )
        content = json.loads(output.read_text())
        return normalized(
            path,
            workdir,
            (
                feature
                for feature in content.get("features", [])
                if feature.get("geometry")
            ),
            "DWG geographic geometry. Drawings without geographic coordinates must be reprojected before globe display.",
        )
    return vector_layers(path, workdir)
