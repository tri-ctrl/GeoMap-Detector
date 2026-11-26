"""Process a file into a durable local layer bundle without other services."""

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from ingestion_common.config import settings
from ingestion_common.contracts import Artifact
from ingestion_common.formats import SUPPORTED_EXTENSIONS
from .dispatch import process
from .outputs import artifacts, metadata, processed_file


def write_json(path, value):
    path.write_text(
        json.dumps(value, allow_nan=False, separators=(",", ":")), encoding="utf-8"
    )
    return path.stat().st_size


def ingest(source, destination):
    source, destination = Path(source).resolve(), Path(destination).absolute()
    if not source.is_file():
        raise ValueError("Input must be an existing file")
    if not source.name.lower().endswith(SUPPORTED_EXTENSIONS):
        raise ValueError("Unsupported input format")
    if not 0 < source.stat().st_size <= settings.max_upload_bytes:
        raise ValueError("Input is empty or exceeds the configured upload size limit")
    # Never overwrite a prior bundle, including an empty directory or symlink.
    if os.path.lexists(destination):
        raise ValueError("Output already exists; choose a new directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".geomap-ingest-", dir=destination.parent
    ) as directory:
        root = Path(directory)
        work, bundle = root / "work", root / "bundle"
        bundle.mkdir()
        files = []
        source_info = {"name": source.name, "size": source.stat().st_size}
        for index, layer in enumerate(process(source, work)):
            file_id = f"layer-{index}"
            target = bundle / file_id
            target.mkdir()
            entries = []
            for role, path, media_type in artifacts(layer):
                # Move generated files on the same filesystem; copy original assets for durability.
                output = target / (
                    "data" + path.suffix if role == "data" else "preview.png"
                )
                if path.resolve().is_relative_to(work.resolve()):
                    path.rename(output)
                else:
                    shutil.copyfile(path, output)
                entries.append(
                    Artifact(
                        role=role,
                        key=output.relative_to(bundle).as_posix(),
                        media_type=media_type,
                        size=output.stat().st_size,
                    )
                )
            details = target / "metadata.json"
            size = write_json(details, metadata(layer, source_info))
            entries.append(
                Artifact(
                    role="metadata",
                    key=details.relative_to(bundle).as_posix(),
                    media_type="application/json",
                    size=size,
                )
            )
            files.append(
                processed_file(layer, file_id, entries).model_dump(mode="json")
            )
        if not files or len(files) > 20:
            raise ValueError("Processing must produce between 1 and 20 files")
        manifest = {
            "version": 1,
            "status": "completed",
            "source": source_info,
            "processed_files": files,
        }
        write_json(bundle / "manifest.json", manifest)
        # Reserve the destination before moving files so concurrent runs cannot replace one another.
        destination.mkdir()
        try:
            for path in bundle.iterdir():
                if path.name != "manifest.json":
                    path.rename(destination / path.name)
            (bundle / "manifest.json").rename(destination / "manifest.json")
        except BaseException:
            shutil.rmtree(destination)
            raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "output", type=Path, help="New directory for normalized files and manifest.json"
    )
    args = parser.parse_args()
    try:
        result = ingest(args.input, args.output)
    except (ValueError, OSError) as error:
        print(f"Ingestion failed: {error}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "manifest": str(args.output / "manifest.json"),
                "files": len(result["processed_files"]),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
