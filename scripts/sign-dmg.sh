#!/bin/bash

DMG_PATH=$1 # Pass the DMG path as an argument
CERTIFICATE_NAME="Developer ID Application: Local Self-Signed"

if [ -z "$DMG_PATH" ]; then
  echo "Error: DMG path not provided."
  exit 1
fi

echo "Signing the DMG at: $DMG_PATH"
codesign --deep --force --sign "$CERTIFICATE_NAME" "$DMG_PATH"

echo "Verifying the DMG signature..."
codesign --verify --deep --strict "$DMG_PATH"

echo "DMG signed successfully!"
