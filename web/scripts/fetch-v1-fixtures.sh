#!/usr/bin/env bash
# Re-fetch the v1 (Swift) reference fixtures used by test/core/analyzer.test.ts.
#
# Runs v1's own harness (`swift run PipelineTest`) on the Mac mini, keeps its stdout (the
# analyser stats the TS port is compared against) and copies the synthetic source pages and
# v1's processed renders into test/fixtures/v1/. That folder is gitignored: regenerate it with
# this script rather than committing ~20 MB of PNGs.
#
#   bash scripts/fetch-v1-fixtures.sh            # host defaults to the ssh alias "macmini"
#   V1_HOST=other bash scripts/fetch-v1-fixtures.sh
set -euo pipefail
HOST="${V1_HOST:-macmini}"
REPO="${V1_REPO:-/Volumes/NVMe/ClaudeNVMe/snap}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/test/fixtures/v1"
mkdir -p "$OUT"

ssh -o BatchMode=yes "$HOST" "cd '$REPO' && export PATH=/opt/homebrew/bin:\$PATH && swift run -c release PipelineTest 2>&1" > "$OUT/swift-stats.txt"
ssh -o BatchMode=yes "$HOST" "cd /tmp/snap-test && tar -cf - source-*.png processed-*.png test-*.pdf" | tar -xmf - -C "$OUT"

# The same rendered pixels encoded by ImageIO (v1's JPEG encoder, via sips) at the three tier
# qualities, for test/core/jpeg-quality.test.ts.
mkdir -p "$OUT/imageio"
ssh -o BatchMode=yes "$HOST" 'cd /tmp/snap-test && rm -rf iio && mkdir iio && for m in color grayscale; do for q in 50 70 82; do sips -s format jpeg -s formatOptions $q processed-$m.png --out iio/$m-q$q.jpg >/dev/null 2>&1; done; done; cd iio && tar -cf - *.jpg' | tar -xmf - -C "$OUT/imageio"
printf '*\n!.gitignore\n' > "$OUT/.gitignore"
echo "fetched into $OUT:"; ls -la "$OUT"
grep -E "^(PASS|FAIL) " "$OUT/swift-stats.txt" || true
