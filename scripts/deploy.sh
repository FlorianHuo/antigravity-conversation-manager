#!/bin/bash
# Deploy the extension to Antigravity's extensions directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
EXT_NAME="florian.antigravity-conversation-manager-${VERSION}"
TARGET_DIR="$HOME/.antigravity/extensions/${EXT_NAME}"

echo "Building..."
cd "$PROJECT_DIR"
npm run compile

echo "Deploying to ${TARGET_DIR}..."
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR/out"

cp -r out/* "$TARGET_DIR/out/"
cp package.json "$TARGET_DIR/"

echo "Done! Reload Antigravity window to activate."
echo "  Cmd+Shift+P > 'Reload Window'"
