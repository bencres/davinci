#!/usr/bin/env bash
set -euo pipefail

# Verify Node meets the >=22 requirement from package.json
node_major=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [ "$node_major" -lt 22 ]; then
  echo "ERROR: Node >=22 required (found $(node --version))" >&2
  exit 1
fi

npm ci
