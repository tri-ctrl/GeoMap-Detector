"""Install separate native processor/Airflow environments. Docker is not used."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python", default=sys.executable, help="Python 3.12 executable"
    )
    parser.add_argument(
        "--processor-only",
        action="store_true",
        help="Only install standalone file processing",
    )
    args = parser.parse_args()
    version = subprocess.check_output(
        [
            args.python,
            "-c",
            "import sys;print('.'.join(map(str,sys.version_info[:2])))",
        ],
        text=True,
    ).strip()
    if version != "3.12":
        parser.error(
            "Use Python 3.12; the pinned Rasterio version requires Python >= 3.12"
        )
    targets = [("processor", "services/ingestion/requirements.txt")]
    if not args.processor_only:
        targets.append(("services", "services/airflow/requirements-native.txt"))
    for name, requirement in targets:
        directory = ROOT / ".runtime/venvs" / name
        if (directory / "bin/python").is_file():
            installed = subprocess.check_output(
                [
                    str(directory / "bin/python"),
                    "-c",
                    "import sys;print('.'.join(map(str,sys.version_info[:2])))",
                ],
                text=True,
            ).strip()
            if installed != version:
                parser.error(
                    f"{directory} uses Python {installed}; move that environment aside before installing Python {version}"
                )
        subprocess.run([args.python, "-m", "venv", str(directory)], check=True)
        python = directory / "bin/python"
        if shutil.which("uv"):
            command = [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "-r",
                str(ROOT / requirement),
            ]
            install_env = {"UV_SYSTEM_CERTS": "true", **os.environ}
        else:
            command = [
                str(python),
                "-m",
                "pip",
                "install",
                "-r",
                str(ROOT / requirement),
            ]
            install_env = os.environ.copy()
        subprocess.run(command, env=install_env, check=True)
        package_roots = [ROOT / "services/common", ROOT / "services/ingestion"]
        if name == "services":
            package_roots.append(ROOT / "services/upload-api")
        site = subprocess.check_output(
            [
                str(python),
                "-c",
                "import sysconfig;print(sysconfig.get_path('purelib'))",
            ],
            text=True,
        ).strip()
        Path(site, "geomap_native.pth").write_text(
            "".join(str(path) + os.linesep for path in package_roots)
        )
        print(f"Native {name} environment ready: {python}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
