#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export PACKWIZ_SETUP_GO_MODULE="github.com/packwiz/packwiz@latest"
export PACKWIZ_SETUP_BIN_NAME="packwiz-upstream"
export PACKWIZ_SETUP_SKIP_PATH=1

source "$SCRIPT_DIR/setup-packwiz.sh"

node "$SCRIPT_DIR/generate-curseforge-packs.js" "$@"
