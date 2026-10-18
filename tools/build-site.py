#!/usr/bin/env python3
"""Copy only the public Hub website files into a clean GitHub Pages artifact."""
from pathlib import Path
import argparse
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "index.html",
    "hub.js",
    "style.css",
    "manifest.webmanifest",
    "apps/chat.html",
    "apps/chat.js",
    "apps/chat.css",
    "apps/downloads.html",
    "apps/downloads.js",
    "apps/downloads.css",
)
DIRECTORIES = ("icons",)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    output = parser.parse_args().output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise SystemExit("output must be outside the source checkout")
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"output directory must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    for rel in FILES:
        src, dst = ROOT / rel, output / rel
        if not src.is_file():
            raise SystemExit(f"required site file is missing: {rel}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    for rel in DIRECTORIES:
        src, dst = ROOT / rel, output / rel
        if not src.is_dir():
            raise SystemExit(f"required site directory is missing: {rel}")
        shutil.copytree(src, dst)
    print(f"Built public site: {len(FILES)} files + {len(DIRECTORIES)} asset directories -> {output}")


if __name__ == "__main__":
    main()
