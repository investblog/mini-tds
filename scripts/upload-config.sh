#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-config-json> [kv-namespace-binding]" >&2
  echo "Example: $0 config/config.example.json CONFIG" >&2
  exit 1
fi

CONFIG_PATH="$1"
BINDING_NAME="${2:-CONFIG}"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

npx wrangler kv:key put --binding "$BINDING_NAME" config.json --path "$CONFIG_PATH"
