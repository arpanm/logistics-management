#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$repo_dir/scripts/test-fixtures/runtime"

for major in 22 24; do
  output="$(
    cd "$repo_dir"
    MST_TEST_NODE_MAJOR="$major" PATH="$fixture_dir:$PATH" \
      bash scripts/bootstrap.sh production 2>&1
  )"
  if [[ "$output" != *"Production bootstrap checks passed."* ]]; then
    echo "MST01-M-003: Node $major was not accepted by production bootstrap" >&2
    echo "$output" >&2
    exit 1
  fi
done

set +e
rejected_output="$(
  cd "$repo_dir"
  MST_TEST_NODE_MAJOR=23 PATH="$fixture_dir:$PATH" \
    bash scripts/bootstrap.sh production 2>&1
)"
rejected_status=$?
set -e
if (( rejected_status == 0 )); then
  echo "MST01-M-003: Node 23 was unexpectedly accepted" >&2
  exit 1
fi
if [[ "$rejected_output" != *"supports Node.js 22 or 24"* ]]; then
  echo "MST01-M-003: Node 23 rejection did not explain the supported majors" >&2
  echo "$rejected_output" >&2
  exit 1
fi

echo "MST01-M-003 Node 22/24 acceptance and Node 23 rejection passed"
