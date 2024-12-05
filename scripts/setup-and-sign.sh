#!/bin/bash

CERTIFICATE_NAME="Developer ID Application: Local Self-Signed"
KEYCHAIN_NAME="build.keychain"
PASSWORD="password"
EXISTING_DMG_PATH=$1
APP_PATH="$(echo -n dist/mac-*/*.app)"
NEW_DMG_NAME="$(basename "$EXISTING_DMG_PATH")"
NEW_DMG_PATH="dist/$NEW_DMG_NAME"

if [ -z "$EXISTING_DMG_PATH" ]; then
  echo "Error: No DMG file path provided."
  exit 1
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Error: .app file not found in $APP_PATH. Ensure the build process completed successfully."
  exit 1
fi

# Remove existing certificates
echo "Removing existing certificates with the same name..."
security delete-certificate -c "$CERTIFICATE_NAME" "$KEYCHAIN_NAME" >/dev/null 2>&1

# Create or access keychain
echo "Creating or accessing keychain: $KEYCHAIN_NAME"
security create-keychain -p "$PASSWORD" "$KEYCHAIN_NAME"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN_NAME"
security list-keychains -d user -s "$KEYCHAIN_NAME" $(security list-keychains -d user | tr -d '"')
security set-key-partition-list -S apple-tool:,apple: -s -k "$PASSWORD" "$KEYCHAIN_NAME"

# Generate certificate
echo "Generating self-signed certificate: $CERTIFICATE_NAME"
openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 \
    -subj "/CN=$CERTIFICATE_NAME" \
    -keyout temp.key -out temp.crt \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=codeSigning"

openssl pkcs12 -export -out temp.p12 -inkey temp.key -in temp.crt -password pass:"$PASSWORD"
security import temp.p12 -k "$KEYCHAIN_NAME" -P "$PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$PASSWORD" "$KEYCHAIN_NAME"

# Verify signing identity
echo "Verifying signing identity..."
security find-identity -v -p codesigning "$KEYCHAIN_NAME"

# Sign the .app file
echo "Signing the .app file: $APP_PATH"
codesign --verbose --deep --force --sign "$CERTIFICATE_NAME" --keychain "$KEYCHAIN_NAME" "$APP_PATH"

if [ $? -eq 0 ]; then
  echo ".app file signed successfully!"
else
  echo "Error signing the .app file."
  exit 1
fi

# Remove the existing .dmg
if [ -f "$EXISTING_DMG_PATH" ]; then
  echo "Removing the existing .dmg file: $EXISTING_DMG_PATH"
  rm -f "$EXISTING_DMG_PATH"
fi

# Create a new .dmg file with the signed .app
echo "Creating a new .dmg file: $NEW_DMG_PATH"
hdiutil create -volname "$(basename "$APP_PATH" .app)" -srcfolder "$APP_PATH" -ov -format UDZO "$NEW_DMG_PATH"

# Sign the new .dmg file
echo "Signing the new .dmg file: $NEW_DMG_PATH"
codesign --verbose --deep --force --sign "$CERTIFICATE_NAME" --keychain "$KEYCHAIN_NAME" "$NEW_DMG_PATH"

if [ $? -eq 0 ]; then
  echo ".dmg file signed successfully!"
else
  echo "Error signing the .dmg file."
  exit 1
fi

# Verify the signature of the .dmg file
echo "Verifying the .dmg signature..."
codesign --verify --deep --strict "$NEW_DMG_PATH"

if [ $? -eq 0 ]; then
  echo ".dmg signature verification passed!"
else
  echo ".dmg signature verification failed!"
  exit 1
fi

# Cleanup temporary files
echo "Cleaning up temporary files..."
rm -f temp.key temp.crt temp.p12

echo "Process completed successfully!"
