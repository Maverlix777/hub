#!/usr/bin/env python3
"""Ensure the Pages artifact contains only the site and all referenced local assets."""
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix="hub-site-check-") as temp:
    site = Path(temp) / "public"
    subprocess.run(["python3", str(ROOT / "tools/build-site.py"), "--output", str(site)], check=True)
    forbidden = ("CLAUDE.md", "HANDOFF.md", "PROGRESS.md", "tests", "tools", ".git")
    bad = [name for name in forbidden if (site / name).exists()]
    if bad:
        raise SystemExit(f"private/source files in Pages artifact: {bad}")
    expected = {"index.html", "hub.js", "style.css", "manifest.webmanifest", "login.html", "login.js",
                "login.css", "apps/chat.html", "apps/chat.js", "apps/chat.css", "apps/downloads.html",
                "apps/downloads.js", "apps/downloads.css", "apps/board.html", "apps/board.js", "apps/board.css", "icons/icon-180.png", "icons/icon-192.png",
                "icons/icon-512.png",
                "doktor/index.html", "doktor/privacy.html", "doktor/support.html", "doktor/terms.html", "doktor/style.css",
                "doktor/blog/first-post.html", "doktor/blog/index.html", "doktor/downloads/index.html"}
    present = {path.relative_to(site).as_posix() for path in site.rglob("*") if path.is_file()}
    missing = sorted(expected - present)
    extra = sorted(present - expected)
    if missing or extra:
        raise SystemExit(f"site artifact mismatch; missing={missing}, extra={extra}")
    for html_path in site.rglob("*.html"):
        html = html_path.read_text(encoding="utf-8")
        for ref in re.findall(r'<(?:script|link)[^>]+(?:src|href)="([^"]+)"', html):
            if ref.startswith(("https://", "http://", "#")):
                continue
            clean = ref.split("?", 1)[0]
            if clean.startswith("/hub/"):
                resolved = (site / clean[len("/hub/"):]).resolve()  # /hub/ is the artifact root
            elif clean.startswith("/"):
                raise SystemExit(f"absolute path outside /hub/: {html_path.relative_to(site)} -> {ref}")
            else:
                resolved = (html_path.parent / clean).resolve()
            if site.resolve() not in resolved.parents and resolved != site.resolve():
                raise SystemExit(f"path escapes public root: {html_path.relative_to(site)} -> {ref}")
            if not resolved.is_file():
                raise SystemExit(f"missing public asset: {html_path.relative_to(site)} -> {ref}")
    print(f"public Pages artifact OK: {len(present)} files, no docs/tests/tools")
