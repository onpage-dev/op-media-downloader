#!/bin/bash

CERTIFICATE_NAME="Developer ID Application: Local Self-Signed"
KEYCHAIN_NAME="build.keychain"
PASSWORD="password"
DMG_PATH=$1

if [ -z "$DMG_PATH" ]; then
  echo "Error: No DMG file path provided."
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

# Sign the DMG
echo "Signing the DMG: $DMG_PATH"
codesign --verbose --deep --force --sign "$CERTIFICATE_NAME" --keychain "$KEYCHAIN_NAME" "$DMG_PATH"

if [ $? -eq 0 ]; then
  echo "DMG signed successfully!"
else
  echo "Error signing the DMG."
  exit 1
fi

# Verify the signature
echo "Verifying the DMG signature..."
codesign --verify --deep --strict "$DMG_PATH"

if [ $? -eq 0 ]; then
  echo "DMG signature verification passed!"
else
  echo "DMG signature verification failed!"
  exit 1
fi

# Cleanup temporary files
echo "Cleaning up temporary files..."
rm -f temp.key temp.crt temp.p12

echo "Process completed successfully!"
