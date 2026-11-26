"""Bounded vector normalization, with streaming reads/writes for large inputs."""

import csv
import json
import math
import stat
import zipfile
from xml.etree import ElementTree as ET

import fiona
from fiona.model import to_dict
from rasterio.warp import transform_geom
from shapely.geometry import shape

MAX_FEATURES = 100000
MAX_VECTOR_BYTES = 256 * 1024**2
MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_ARCHIVE_FILES = 200


def extract_shapefile(path, destination):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if (
            len(entries) > MAX_ARCHIVE_FILES
            or sum(e.file_size for e in entries) > MAX_ARCHIVE_BYTES
        ):
            raise ValueError("Archive exceeds extraction limits")
        for entry in entries:
            target = (destination / entry.filename).resolve()
            if (
                not target.is_relative_to(destination.resolve())
                or "\\" in entry.filename
                or stat.S_ISLNK(entry.external_attr >> 16)
                or entry.flag_bits & 1
            ):
                raise ValueError("Unsafe archive member")
            if entry.file_size > max(1, entry.compress_size) * 200:
                raise ValueError("Archive compression ratio exceeds limit")
        archive.extractall(destination)
    files = sorted(destination.rglob("*.shp")) + sorted(destination.rglob("*.SHP"))
    if not files or len(files) > 20:
        raise ValueError(
            "ZIP must contain between 1 and 20 Shapefiles with their sidecar files"
        )
    return files


def csv_features(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or not {"lat", "lon"}.issubset(reader.fieldnames):
            raise ValueError("CSV requires lat and lon column headers")
        for index, row in enumerate(reader, 2):
            try:
                lat, lon = float(row["lat"]), float(row["lon"])
                if (
                    not math.isfinite(lat)
                    or not math.isfinite(lon)
                    or not (-90 <= lat <= 90 and -180 <= lon <= 180)
                ):
                    raise ValueError()
            except (ValueError, TypeError) as error:
                raise ValueError(
                    f"Invalid latitude or longitude on CSV row {index}"
                ) from error
            yield {
                "type": "Feature",
                "properties": row,
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            }


def kml_geometry(element):
    tag = element.tag.rsplit("}", 1)[-1]

    def coords(node):
        text = node.findtext(".//{*}coordinates", "")
        return [[float(n) for n in value.split(",")[:2]] for value in text.split()]

    if tag == "Point":
        return {"type": "Point", "coordinates": coords(element)[0]}
    if tag == "LineString":
        return {"type": "LineString", "coordinates": coords(element)}
    if tag == "Polygon":
        outer = element.find("{*}outerBoundaryIs")
        if outer is None:
            raise ValueError("KML polygon requires an outer boundary")
        return {
            "type": "Polygon",
            "coordinates": [coords(outer)]
            + [coords(r) for r in element.findall("{*}innerBoundaryIs")],
        }
    if tag == "MultiGeometry":
        return {
            "type": "GeometryCollection",
            "geometries": [kml_geometry(child) for child in element],
        }
    raise ValueError("Unsupported KML geometry")


def kml_features(path):
    # No network links, external references or DTDs are resolved.
    with path.open("rb") as stream:
        for _, element in ET.iterparse(stream, events=["end"]):
            if element.tag.rsplit("}", 1)[-1] != "Placemark":
                continue
            geometry = next(
                (
                    e
                    for e in element
                    if e.tag.rsplit("}", 1)[-1]
                    in ("Point", "LineString", "Polygon", "MultiGeometry")
                ),
                None,
            )
            if geometry is None:
                raise ValueError("KML placemark has no supported geometry")
            yield {
                "type": "Feature",
                "properties": {"name": element.findtext("{*}name", "")},
                "geometry": kml_geometry(geometry),
            }
            element.clear()


def normalize(features, destination):
    count = 0
    bbox = [math.inf, math.inf, -math.inf, -math.inf]
    with destination.open("w", encoding="utf8") as output:
        output.write('{"type":"FeatureCollection","features":[')
        for feature in features:
            count += 1
            if count > MAX_FEATURES:
                raise ValueError(f"Vector exceeds the {MAX_FEATURES:,} feature limit")
            geometry = feature.get("geometry")
            if not geometry:
                raise ValueError(f"Feature {count} has no geometry")
            geom = shape(geometry)
            if geom.is_empty or not geom.is_valid:
                raise ValueError(f"Feature {count} has empty or invalid geometry")
            west, south, east, north = geom.bounds
            if not all(math.isfinite(n) for n in geom.bounds) or not (
                -180 <= west <= east <= 180 and -90 <= south <= north <= 90
            ):
                raise ValueError(f"Feature {count} is outside WGS84 bounds")
            bbox = [
                min(bbox[0], west),
                min(bbox[1], south),
                max(bbox[2], east),
                max(bbox[3], north),
            ]
            clean = {
                "type": "Feature",
                "geometry": geometry,
                "properties": feature.get("properties") or {},
            }
            if count > 1:
                output.write(",")
            output.write(
                json.dumps(
                    clean,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    default=str,
                )
            )
            if output.tell() > MAX_VECTOR_BYTES:
                raise ValueError("Normalized vector exceeds the 256 MiB size limit")
        output.write("]}")
    if not count:
        raise ValueError("Vector has no features")
    return count, bbox


def read_fiona(path, layer):
    with fiona.open(path, layer=layer) as source:
        crs = source.crs_wkt or source.crs
        if not crs and path.suffix.lower() not in (".json", ".geojson"):
            raise ValueError("Vector has no CRS; supply its projection information")
        for feature in source:
            feature = to_dict(feature)
            if feature.get("geometry") and crs:
                feature["geometry"] = transform_geom(
                    crs, "EPSG:4326", feature["geometry"]
                )
            yield feature


def vector_layers(path, workdir):
    if path.stat().st_size > MAX_VECTOR_BYTES and path.suffix.lower() != ".zip":
        raise ValueError("Vector input exceeds the 256 MiB size limit")
    paths = (
        extract_shapefile(path, workdir / "extracted")
        if path.suffix.lower() == ".zip"
        else [path]
    )
    outputs = []
    for source in paths:
        extension = source.suffix.lower()
        layers = (
            fiona.listlayers(source)
            if extension not in (".csv", ".kml")
            else [source.stem]
        )
        for layer in layers:
            if len(outputs) >= 20:
                raise ValueError("File contains more than 20 layers")
            features = (
                csv_features(source)
                if extension == ".csv"
                else (
                    kml_features(source)
                    if extension == ".kml"
                    else read_fiona(source, layer)
                )
            )
            destination = workdir / f"layer-{len(outputs)}.geojson"
            count, bbox = normalize(features, destination)
            outputs.append(
                {
                    "name": str(layer)[:255],
                    "path": destination,
                    "kind": "vector",
                    "bbox": bbox,
                    "feature_count": count,
                }
            )
    return outputs
