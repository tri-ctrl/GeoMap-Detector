"""Metadata/preview handling for non-spatial files; never invent a location."""

import json
import mimetypes
import subprocess
import re

from PIL import Image, ImageOps


def asset(path, workdir, kind=None, message=None):
    suffix = path.suffix.lower()
    kind = kind or (
        "document"
        if suffix == ".pdf"
        else (
            "image"
            if suffix in (".png", ".jpg", ".jpeg")
            else "video" if suffix in (".mp4", ".mpg", ".mpeg") else "package"
        )
    )
    result = {
        "name": path.name,
        "kind": kind,
        "path": path,
        "bbox": None,
        "media_type": mimetypes.guess_type(path)[0] or "application/octet-stream",
        "message": message
        or "No geographic coordinates were found. This file is available in the directory.",
    }
    if kind == "image":
        with Image.open(path) as image:
            if image.width * image.height > 64_000_000:
                raise ValueError("Image exceeds the 64 megapixel preview limit")
            try:
                gps = image.getexif().get_ifd(34853)
                degrees = (
                    lambda value: float(value[0])
                    + float(value[1]) / 60
                    + float(value[2]) / 3600
                )
                lat = degrees(gps[2]) * (-1 if gps[1] == "S" else 1)
                lon = degrees(gps[4]) * (-1 if gps[3] == "W" else 1)
                if -90 <= lat <= 90 and -180 <= lon <= 180:
                    result.update(
                        bbox=[lon, lat, lon, lat],
                        message="Image location from GPS metadata.",
                    )
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                pass
            image = ImageOps.exif_transpose(image)
            image.thumbnail((2048, 2048))
            preview = workdir / "preview.png"
            image.convert("RGBA").save(preview)
            result["preview"] = preview
    elif kind == "document" and suffix == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(path)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDF is not supported; upload an unlocked copy")
        result["page_count"] = len(reader.pages)
        preview = workdir / "preview.png"
        subprocess.run(
            [
                "pdftoppm",
                "-f",
                "1",
                "-singlefile",
                "-scale-to",
                "2048",
                "-png",
                str(path),
                str(preview.with_suffix("")),
            ],
            check=True,
            capture_output=True,
            timeout=60,
        )
        result["preview"] = preview
    elif kind == "video":
        info = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        metadata = json.loads(info.stdout)
        if not any(
            stream.get("codec_type") == "video"
            for stream in metadata.get("streams", [])
        ):
            raise ValueError("The file contains no readable video stream")
        location = metadata.get("format", {}).get("tags", {}).get("location", "")
        match = re.match(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)", location)
        if match:
            lat, lon = map(float, match.groups())
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                result.update(
                    bbox=[lon, lat, lon, lat],
                    message="Video location from embedded GPS metadata.",
                )
        preview = workdir / "preview.png"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-vf",
                "scale=1024:1024:force_original_aspect_ratio=decrease",
                str(preview),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        result["preview"] = preview
    return [result]
