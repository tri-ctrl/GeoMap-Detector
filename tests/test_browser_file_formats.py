import json
from pathlib import Path
import runpy
import unittest


class BrowserFormatContractTests(unittest.TestCase):
    def test_pages_accepts_the_same_extensions_as_the_native_backend(self):
        root = Path(__file__).resolve().parent.parent
        server = runpy.run_path(str(root / "services/common/ingestion_common/formats.py"))
        browser = json.loads((root / "frontend/file-formats.json").read_text())
        self.assertEqual(browser["extensions"], list(server["SUPPORTED_EXTENSIONS"]),
                         "Regenerate with python scripts/export_file_formats.py")
