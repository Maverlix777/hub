#!/usr/bin/env python3
"""Build either the public Hub site or a small legacy-route redirect artifact."""
from pathlib import Path
import argparse
from html import escape
import shutil
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"  # the frontend actually served by the Cloudflare Worker
# Static pages of other projects served from the Pages artifact next to the redirects.
STATIC_PAGES = ("games/krenkballs/privacy.html",)
# Public Doktor pages (byte-for-byte copy of site/doktor in the doktor repo), served at /doktor/.
DOKTOR_DIR = "public/doktor"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--redirect-to",
        help="emit only redirects to this canonical Hub URL (used for Pages migration)",
    )
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise SystemExit("output must be outside the source checkout")
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"output directory must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    if args.redirect_to:
        build_redirects(output, args.redirect_to)
        print(f"Built legacy route redirects -> {output}")
        return
    if not (PUBLIC / "index.html").is_file():
        raise SystemExit("required site file is missing: public/index.html")
    count = 0
    for src in sorted(PUBLIC.rglob("*")):
        if not src.is_file():
            continue
        dst = output / src.relative_to(PUBLIC)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        count += 1
    print(f"Built public site: {count} files from public/ -> {output}")


def build_redirects(output: Path, target: str) -> None:
    parsed = urlsplit(target)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith("/")
    ):
        raise SystemExit("redirect target must be an HTTPS base URL ending in /")

    routes = {
        "index.html": target,
        "apps/chat.html": f"{target}apps/chat.html",
        "apps/downloads.html": f"{target}apps/downloads.html",
    }
    for rel, destination in routes.items():
        page = output / rel
        page.parent.mkdir(parents=True, exist_ok=True)
        escaped = escape(destination, quote=True)
        page.write_text(
            "<!doctype html>\n"
            '<html lang="ru"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<meta http-equiv="refresh" content="0;url={escaped}">'
            f'<link rel="canonical" href="{escaped}">'
            '<title>Hub переехал</title></head><body>'
            f'<p>Hub переехал. <a href="{escaped}">Открыть новую страницу</a>.</p>'
            '</body></html>\n',
            encoding="utf-8",
        )
    for rel in STATIC_PAGES:
        src, dst = ROOT / "static" / rel, output / rel
        if not src.is_file():
            raise SystemExit(f"required static page is missing: {rel}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    copy_doktor(output)


def copy_doktor(output: Path) -> None:
    src = ROOT / DOKTOR_DIR
    if not src.is_dir():
        raise SystemExit(f"required site directory is missing: {DOKTOR_DIR}")
    shutil.copytree(src, output / "doktor")


if __name__ == "__main__":
    main()
