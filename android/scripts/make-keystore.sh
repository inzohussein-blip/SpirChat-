#!/usr/bin/env bash
# Creates the app's permanent signing key and prints the values to store as GitHub secrets.
# Run once, on your own computer (needs Java's keytool). Keep spirchat-release.jks and the
# password safe and private: whoever has them can publish "updates" of SpirChat.
set -euo pipefail
OUT="${1:-spirchat-release.jks}"
if [[ -e "$OUT" ]]; then echo "$OUT already exists" >&2; exit 1; fi
read -rsp "Choose a strong password (16+ characters): " PASS; echo
keytool -genkeypair -keystore "$OUT" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" \
  -alias spirchat -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=SpirChat"
echo
echo "Add these in GitHub: Settings > Secrets and variables > Actions > New repository secret"
echo "  SPIRCHAT_KEYSTORE_B64      = (the long text below)"
echo "  SPIRCHAT_KEYSTORE_PASSWORD = the password you just chose"
echo
base64 -w0 "$OUT" 2>/dev/null || base64 "$OUT" | tr -d '\n'
echo
echo
echo "Certificate fingerprint (publish it so people can check an APK is genuine):"
keytool -list -v -keystore "$OUT" -storepass "$PASS" -alias spirchat | grep -E "SHA256:"
