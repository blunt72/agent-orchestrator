#!/usr/bin/env bash
# Offline test runner: Python stdlib unittest + Node built-in test runner.
# No network, no model/provider calls, no Orca runtime required.
set -euo pipefail
cd "$(dirname "$0")"
NODE="${NODE:-node}"
status=0
for t in tests/test_*.py; do
  echo "== $t"
  python3 -m unittest "$t" || status=1
done
echo "== tests/orca-receipt-observer.test.mjs"
"$NODE" --test tests/orca-receipt-observer.test.mjs || status=1
exit $status
