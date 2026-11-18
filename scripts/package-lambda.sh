#!/usr/bin/env bash
# Build the Lambda .zip content into .aws-sam-package/ (template.yaml CodeUri).
# `sam deploy` zips and uploads this folder; no `sam build` step is used.
# Runs on Linux (GitHub Actions). No npm lifecycle scripts are executed.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=".aws-sam-package"
rm -rf "${OUT}"
npm ci --ignore-scripts --no-audit --no-fund
npm run build

mkdir -p "${OUT}"
cp -R dist package.json package-lock.json run.sh "${OUT}/"
find "${OUT}/dist" -name '*.map' -delete
chmod 755 "${OUT}/run.sh"
(cd "${OUT}" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# Sanity checks: LF line endings, entrypoint present, no secrets or dev files.
if grep -q $'\r' "${OUT}/run.sh"; then echo "run.sh has CRLF line endings" >&2; exit 1; fi
test -f "${OUT}/dist/aws-entry.js"
if find "${OUT}" -maxdepth 1 -name '.env*' | grep -q .; then echo ".env file in package" >&2; exit 1; fi
echo "Package ready: $(du -sh "${OUT}" | cut -f1) in ${OUT}/"
