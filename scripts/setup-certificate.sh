#!/bin/bash

CERTIFICATE_NAME="Developer ID Application: Local Self-Signed"
KEYCHAIN_NAME="build.keychain"
PASSWORD="password"

echo "Checking for existing certificate: $CERTIFICATE_NAME"

if security find-certificate -c "$CERTIFICATE_NAME" >/dev/null 2>&1; then
    echo "Certificate already exists."
else
    echo "Creating a new self-signed certificate: $CERTIFICATE_NAME"

    # Create a keychain for the certificate
    security create-keychain -p "$PASSWORD" "$KEYCHAIN_NAME"
    security unlock-keychain -p "$PASSWORD" "$KEYCHAIN_NAME"
    security set-keychain-settings -lut 3600 "$KEYCHAIN_NAME"

    # Generate a self-signed certificate
    CERT_REQUEST=$(mktemp)
    openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 \
        -subj "/CN=$CERTIFICATE_NAME" \
        -keyout "$CERT_REQUEST.key" \
        -out "$CERT_REQUEST.crt"
    openssl pkcs12 -export -out "$CERT_REQUEST.p12" -inkey "$CERT_REQUEST.key" -in "$CERT_REQUEST.crt" -password pass:"$PASSWORD"
    security import "$CERT_REQUEST.p12" -k "$KEYCHAIN_NAME" -P "$PASSWORD" -T /usr/bin/codesign

    echo "Certificate created and added to keychain: $CERTIFICATE_NAME"

    # Cleanup temporary files
    rm -f "$CERT_REQUEST" "$CERT_REQUEST.key" "$CERT_REQUEST.crt" "$CERT_REQUEST.p12"
fi
