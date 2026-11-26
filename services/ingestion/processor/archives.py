"""Bounded archive extraction shared by GIS and application packages."""

import shutil
import stat
import tarfile
import zipfile

MAX_FILES = 200
MAX_BYTES = 2 * 1024**3


def extract(path, destination):
    destination.mkdir(parents=True, exist_ok=True)

    def target(name):
        out = (destination / name).resolve()
        if not out.is_relative_to(destination.resolve()) or "\\" in name:
            raise ValueError("Unsafe archive member")
        return out

    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if (
                len(entries) > MAX_FILES
                or sum(e.file_size for e in entries) > MAX_BYTES
            ):
                raise ValueError("Archive exceeds extraction limits")
            for entry in entries:
                target(entry.filename)
                if (
                    stat.S_ISLNK(entry.external_attr >> 16)
                    or entry.flag_bits & 1
                    or entry.file_size > max(1, entry.compress_size) * 200
                ):
                    raise ValueError("Unsafe archive member or compression ratio")
            archive.extractall(destination)
    elif tarfile.is_tarfile(path):
        with tarfile.open(path) as archive:
            entries = archive.getmembers()
            if len(entries) > MAX_FILES or sum(e.size for e in entries) > MAX_BYTES:
                raise ValueError("Archive exceeds extraction limits")
            for entry in entries:
                out = target(entry.name)
                if entry.isdir():
                    out.mkdir(parents=True, exist_ok=True)
                elif entry.isfile():
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(entry) as source, out.open("wb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                else:
                    raise ValueError(
                        "Archive links and special files are not supported"
                    )
    else:
        raise ValueError("File is not a readable ZIP or TAR archive")
    return sorted(
        p
        for p in destination.rglob("*")
        if p.is_file() and not p.name.startswith("._") and "__MACOSX" not in p.parts
    )
