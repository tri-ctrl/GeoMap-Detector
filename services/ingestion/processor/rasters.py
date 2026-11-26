"""Windowed COG conversion and bounded, correctly projected display previews."""

import math

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds


def raster_layers(path, workdir):
    workdir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path) as source:
        if not source.crs:
            raise ValueError("Raster has no CRS; upload a georeferenced GeoTIFF")
        if source.width * source.height > 4_000_000_000 or source.count > 32:
            raise ValueError("Raster dimensions or band count exceed processing limits")
        bbox = transform_bounds(source.crs, "EPSG:4326", *source.bounds, densify_pts=21)
        if not all(math.isfinite(v) for v in bbox) or not (
            -180 <= bbox[0] < bbox[2] <= 180 and -85 <= bbox[1] < bbox[3] <= 85
        ):
            raise ValueError(
                "Raster footprint is outside supported Web Mercator bounds"
            )
        bounds = transform_bounds("EPSG:4326", "EPSG:3857", *bbox, densify_pts=21)
        width_m, height_m = bounds[2] - bounds[0], bounds[3] - bounds[1]
        scale = 2048 / max(width_m, height_m)
        width, height = max(1, round(width_m * scale)), max(1, round(height_m * scale))
        transform = from_bounds(*bounds, width, height)
        bands = [1, 2, 3] if source.count >= 3 else [1]
        with WarpedVRT(
            source,
            crs="EPSG:3857",
            transform=transform,
            width=width,
            height=height,
            resampling=Resampling.bilinear,
            add_alpha=source.count not in (2, 4),
        ) as vrt:
            pixels = vrt.read(bands, masked=True)
            valid = vrt.dataset_mask() > 0
        rgb = np.zeros((height, width, 3), dtype=np.uint8)
        for index in range(3):
            band = pixels[min(index, len(bands) - 1)]
            data = band.filled(0).astype(np.float32)
            selected = data[valid & np.isfinite(data)]
            if source.dtypes[bands[min(index, len(bands) - 1)] - 1] == "uint8":
                rgb[:, :, index] = data.clip(0, 255).astype(np.uint8)
            elif selected.size:
                low, high = np.percentile(selected, [2, 98])
                if high <= low:
                    high = low + 1
                rgb[:, :, index] = (
                    np.nan_to_num((data - low) / (high - low) * 255)
                    .clip(0, 255)
                    .astype(np.uint8)
                )
        preview = workdir / "preview.png"
        Image.fromarray(np.dstack((rgb, valid.astype(np.uint8) * 255))).save(preview)
    cog = workdir / "image.tif"
    raster_copy(
        path,
        cog,
        driver="COG",
        compress="DEFLATE",
        blocksize=512,
        BIGTIFF="IF_SAFER",
        NUM_THREADS="2",
    )
    return [
        {
            "name": path.name,
            "path": cog,
            "preview": preview,
            "kind": "raster",
            "bbox": list(bbox),
        }
    ]
