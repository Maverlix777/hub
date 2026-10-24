#!/bin/bash
# Cloud sessions only: install Worker deps so npm test / npm run check / tests/*.cjs work right away.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$PROJECT_DIR"
# npm install (not ci) keeps node_modules from the cached container; package-lock.json pins versions.
npm install --no-audit --no-fund

# Browser tests (check-subpath, e2e, site4) use the preinstalled Playwright and read public/.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo 'export NODE_PATH=/opt/node-tools/node_modules'
    echo "export HUB_SITE_ROOT=$PROJECT_DIR/public"
  } >> "$CLAUDE_ENV_FILE"
fi
