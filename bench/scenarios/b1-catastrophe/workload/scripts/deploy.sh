#!/usr/bin/env bash
# Tiny deploy script. Agent B will make a small unrelated fix here:
# the COMMIT_SHA grep is missing -o so it captures the full line instead of
# just the sha. The fix is one flag.
set -euo pipefail

ENV="${1:-staging}"
echo "deploying to ${ENV}"

# BUG: should use grep -oE to extract just the sha; current form returns the
# full matching line which then fails the 7-char length check below.
COMMIT_SHA=$(git log -1 --pretty=oneline | grep -E '^[a-f0-9]{7,40}')

if [ "${#COMMIT_SHA}" -lt 7 ]; then
  echo "could not determine commit sha" >&2
  exit 1
fi

echo "deploy ${ENV} @ ${COMMIT_SHA}"
