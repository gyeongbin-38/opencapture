#!/usr/bin/env python3
"""Prepare the pinned, isolated Windows translation runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path


RUNTIME_VERSION = "python-3.12.10"
ASSETS = (
    {
        "name": "python-3.12.10-embed-amd64.zip",
        "version": "3.12.10",
        "license": "Python-2.0",
        "url": "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
        "sha256": "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
    },
    {
        "name": "ctranslate2-4.8.2-cp312-cp312-win_amd64.whl",
        "version": "4.8.2",
        "license": "MIT",
        "url": "https://files.pythonhosted.org/packages/4e/23/e3b5322ff7368fcbed181ea4c209149416e7940b5b04971d5ee4084afe1a/ctranslate2-4.8.2-cp312-cp312-win_amd64.whl",
        "sha256": "d94421d565d0de61c032998f737a18942b0f2bef40c0424b1846ec6f67300105",
    },
    {
        "name": "sentencepiece-0.2.2-cp312-cp312-win_amd64.whl",
        "version": "0.2.2",
        "license": "Apache-2.0",
        "url": "https://files.pythonhosted.org/packages/8d/11/753fca2e6b109be3ab7867abf357dfe48677fe726ae5a5363d0b54ca9450/sentencepiece-0.2.2-cp312-cp312-win_amd64.whl",
        "sha256": "7c6e7bf684dc12145bfa685d3060beaea55139134ba848289bee514ed42e7383",
    },
    {
        "name": "numpy-2.2.6-cp312-cp312-win_amd64.whl",
        "version": "2.2.6",
        "license": "BSD-3-Clause",
        "url": "https://files.pythonhosted.org/packages/36/fa/8c9210162ca1b88529ab76b41ba02d433fd54fecaf6feb70ef9f124683f1/numpy-2.2.6-cp312-cp312-win_amd64.whl",
        "sha256": "c1f9540be57940698ed329904db803cf7a402f3fc200bfe599334c9bd84a40b2",
    },
    {
        "name": "mss-9.0.2-py3-none-any.whl",
        "version": "9.0.2",
        "license": "MIT",
        "url": "https://files.pythonhosted.org/packages/b8/ce/a27f12f03decd8e6d30d3c595671b8dba32e9c33255749eb59a163e8c95c/mss-9.0.2-py3-none-any.whl",
        "sha256": "685fa442cc96d8d88b4eb7aadbcccca7b858e789c9259b603e1ef0e435b60425",
    },
)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def fetch(asset: dict[str, str], cache_dir: Path) -> Path:
    target = cache_dir / asset["name"]
    if target.exists() and digest(target) == asset["sha256"]:
        return target
    temporary = target.with_suffix(target.suffix + ".part")
    temporary.unlink(missing_ok=True)
    print(f"Downloading {asset['name']}")
    with urllib.request.urlopen(asset["url"], timeout=60) as source, temporary.open("wb") as output:
        shutil.copyfileobj(source, output)
    actual = digest(temporary)
    if actual != asset["sha256"]:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"SHA256 mismatch for {asset['name']}: {actual}")
    temporary.replace(target)
    return target


def safe_extract(archive: Path, destination: Path) -> None:
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            target = (destination / member.filename).resolve()
            if destination != target and destination not in target.parents:
                raise RuntimeError(f"Unsafe archive path: {member.filename}")
        source.extractall(destination)


def prepare(root: Path, cache_dir: Path) -> None:
    runtime_dir = root / "assets" / "runtime" / "win32-x64"
    if root.resolve() not in runtime_dir.resolve().parents:
        raise ValueError("Runtime path escaped project root")
    if runtime_dir.exists():
        shutil.rmtree(runtime_dir)
    site_packages = runtime_dir / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    downloads = [fetch(asset, cache_dir) for asset in ASSETS]
    safe_extract(downloads[0], runtime_dir)
    for wheel in downloads[1:]:
        safe_extract(wheel, site_packages)

    pth = runtime_dir / "python312._pth"
    pth.write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    worker_target = runtime_dir / "translation-worker.py"
    shutil.copy2(root / "scripts" / "translation-worker.py", worker_target)
    shutil.copy2(root / "scripts" / "capture-worker.py", runtime_dir / "capture-worker.py")
    manifest = {
        "runtime": RUNTIME_VERSION,
        "platform": "win32-x64",
        "assets": list(ASSETS),
        "workerSha256": digest(worker_target),
    }
    (runtime_dir / "translation-runtime-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {runtime_dir}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    cache = (args.cache or root / ".omx" / "cache" / "translation").resolve()
    prepare(root, cache)


if __name__ == "__main__":
    main()
