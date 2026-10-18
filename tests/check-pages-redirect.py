#!/usr/bin/env python3
"""Verify the opt-in GitHub Pages migration artifact has only safe route redirects."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = "https://kolobovdjp.org/hub/"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="hub-pages-redirect-") as temp:
        output = Path(temp) / "site"
        subprocess.run(
            [
                "python3",
                str(ROOT / "tools/build-site.py"),
                "--output",
                str(output),
                "--redirect-to",
                TARGET,
            ],
            check=True,
        )
        expected = {
            Path("index.html"): TARGET,
            Path("apps/chat.html"): f"{TARGET}apps/chat.html",
            Path("apps/downloads.html"): f"{TARGET}apps/downloads.html",
        }
        static = {Path("games/krenkballs/privacy.html")}
        present = {path.relative_to(output) for path in output.rglob("*") if path.is_file()}
        if present != set(expected) | static:
            raise SystemExit(f"redirect artifact contains unexpected files: {sorted(map(str, present))}")
        for rel, destination in expected.items():
            html = (output / rel).read_text(encoding="utf-8")
            if f'<meta http-equiv="refresh" content="0;url={destination}">' not in html:
                raise SystemExit(f"missing automatic redirect for {rel}")
            if f'<a href="{destination}">Открыть новую страницу</a>' not in html:
                raise SystemExit(f"missing manual redirect link for {rel}")
        for rel in static:
            if (output / rel).read_bytes() != (ROOT / "static" / rel).read_bytes():
                raise SystemExit(f"static page differs from source: {rel}")
            html = (output / rel).read_text(encoding="utf-8")
            if "<script" in html.lower():
                raise SystemExit(f"static page must not contain scripts: {rel}")
        print("Pages migration redirects OK: root, chat, downloads, plus static Krenkballs privacy page")


if __name__ == "__main__":
    main()
