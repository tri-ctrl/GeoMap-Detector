"""Export YOLO OBB models to ONNX for the in-browser detector and write
frontend/models/models.json. Used by the GitHub Pages workflow; also run it
locally before serving frontend/ with any static server.

  python scripts/export_onnx.py                      # yolo11n-obb + yolo11s-obb
  python scripts/export_onnx.py --models my_best.pt  # your own fine-tuned weights
  python scripts/export_onnx.py --check              # validate generated/cached assets without ML dependencies
"""
import argparse
import json
import shutil
from pathlib import Path

LABELS = {"yolo11n-obb.pt": "YOLO11 nano OBB · fast", "yolo11s-obb.pt": "YOLO11 small OBB · more accurate",
          "yolo11m-obb.pt": "YOLO11 medium OBB · best, slow in browser"}


def check_models(out):
    """Check the manifest and referenced binaries using only the standard library."""
    out = Path(out)
    manifest = out / "models.json"
    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise FileNotFoundError(f"Missing model manifest: {manifest}. Run python scripts/export_onnx.py first.") from e
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in model manifest {manifest}: {e.msg}") from e
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{manifest} must list at least one exported model")
    for i, entry in enumerate(entries, 1):
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str) or not entry["file"].strip():
            raise ValueError(f"Invalid model entry {i} in {manifest}: expected a non-empty 'file' name")
        model = out / entry["file"]
        if not model.is_file() or model.stat().st_size == 0:
            raise FileNotFoundError(f"Missing or empty ONNX model: {model}. Run python scripts/export_onnx.py first.")
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["yolo11n-obb.pt", "yolo11s-obb.pt"])
    ap.add_argument("--imgsz", type=int, default=1024)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "frontend" / "models"))
    ap.add_argument("--check", action="store_true", help="Validate the manifest and model files without exporting or importing ML packages")
    a = ap.parse_args()
    out = Path(a.out)
    if a.check:
        try:
            entries = check_models(out)
        except (OSError, ValueError) as e:
            ap.exit(1, f"Model asset check failed: {e}\n")
        print(f"Verified {len(entries)} ONNX model(s) in {out}")
        return

    from ultralytics import YOLO

    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for w in a.models:
        m = YOLO(w)
        onnx = Path(m.export(format="onnx", imgsz=a.imgsz, opset=17, simplify=True, dynamic=False))
        dst = out / onnx.name
        shutil.move(str(onnx), dst)
        entries.append({"file": dst.name, "label": LABELS.get(Path(w).name, Path(w).stem), "imgsz": a.imgsz,
                        "names": [m.names[i] for i in sorted(m.names)], "task": m.task,
                        "size_mb": round(dst.stat().st_size / 1e6, 1)})
        print("exported", dst, entries[-1]["size_mb"], "MB")
    (out / "models.json").write_text(json.dumps(entries, indent=1))
    check_models(out)


if __name__ == "__main__":
    main()
