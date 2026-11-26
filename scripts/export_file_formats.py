"""Export the server-owned extension contract for the static file browser."""
import json
from pathlib import Path
import runpy

root = Path(__file__).resolve().parent.parent
formats = runpy.run_path(str(root / "services/common/ingestion_common/formats.py"))
(root / "frontend/file-formats.json").write_text(
    json.dumps({"extensions": list(formats["SUPPORTED_EXTENSIONS"])}, indent=2) + "\n"
)
