#!/usr/bin/env bash
# Usage: bash test/core/detect-helpers/why.sh 15 16 ...   (private real frames, prints winner vs nearest-to-truth)
cd "$(dirname "$0")/../../.."
for id in "$@"; do
  truth=$(python -P -E -c "import json,sys; print(json.dumps(json.load(open('test/fixtures/private/truth.json'))['$id']['quad']))")
  echo "== $id"
  ID=$id TRUTH="$truth" npx vitest run test/core/detect-helpers/explain.test.ts -t explain --disableConsoleIntercept 2>&1 | grep -E "^(top|near-truth)" | cut -c1-260
done
