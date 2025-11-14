#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-config-json> [kv-namespace-binding]" >&2
  echo "Examples:" >&2
  echo "  $0 config/routes.json" >&2
  echo "  $0 export.json CONFIG" >&2
  exit 1
fi

CONFIG_PATH="$1"
BINDING_NAME="${2:-CONFIG}"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

node <<'NODE' "$CONFIG_PATH" "$TMP_DIR"
const fs = require('fs');
const path = require('path');

const [,, inputPath, outDir] = process.argv;
const rawText = fs.readFileSync(inputPath, 'utf8');
let parsed;
try {
  parsed = JSON.parse(rawText);
} catch (error) {
  console.error('Failed to parse JSON from', inputPath);
  throw error;
}

const DEFAULT_FLAGS = {
  cacheTtlMs: 60000,
  strictBots: true,
  yandexBots: ["YandexBot", "YandexMobileBot"],
  googleBots: ["Googlebot", "AdsBot-Google-Mobile"],
  allowedAdminIps: [],
  uiTitle: "mini-tds admin",
  uiReadonly: false,
  uiReadOnlyBanner: "",
};

const nowIso = () => new Date().toISOString();

let routes;
let flags;
let metadata;

if (Array.isArray(parsed)) {
  routes = parsed;
  flags = DEFAULT_FLAGS;
  metadata = undefined;
} else if (parsed && typeof parsed === 'object') {
  routes = parsed.routes;
  flags = parsed.flags || DEFAULT_FLAGS;
  metadata = parsed.metadata;
} else {
  throw new Error('Unsupported config structure');
}

if (!Array.isArray(routes)) {
  throw new Error('`routes` must be an array in the config');
}

if (!flags || typeof flags !== 'object') {
  throw new Error('`flags` must be an object in the config');
}

if (!metadata || typeof metadata !== 'object') {
  metadata = {
    version: parsed.version ? String(parsed.version) : '1',
    updatedAt: nowIso(),
    updatedBy: 'cli-upload',
  };
} else {
  metadata = {
    version: metadata.version || '1',
    updatedAt: metadata.updatedAt || nowIso(),
    updatedBy: metadata.updatedBy || 'cli-upload',
  };
}

fs.writeFileSync(path.join(outDir, 'routes.json'), JSON.stringify(routes, null, 2));
fs.writeFileSync(path.join(outDir, 'flags.json'), JSON.stringify(flags, null, 2));
fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
NODE

npx wrangler kv key put --binding "$BINDING_NAME" CONFIG/routes --path "$TMP_DIR/routes.json"
npx wrangler kv key put --binding "$BINDING_NAME" CONFIG/flags --path "$TMP_DIR/flags.json"
npx wrangler kv key put --binding "$BINDING_NAME" CONFIG/metadata --path "$TMP_DIR/metadata.json"
