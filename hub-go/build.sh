#!/usr/bin/env bash
# Builds the Go hub for common router and single-board-computer CPUs into hub-go/dist/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
build() { echo "  $1"; env GOOS=linux CGO_ENABLED=0 "${@:2}" go build -trimpath -ldflags="-s -w" -o "dist/spirchat-hub-$1" .; }
build linux-mipsle GOARCH=mipsle GOMIPS=softfloat   # most cheap OpenWrt routers (MT7621, MT7628...)
build linux-mips   GOARCH=mips GOMIPS=softfloat     # older Atheros/QCA routers
build linux-armv7  GOARCH=arm GOARM=7               # Raspberry Pi 2/3 (32-bit), many ARM routers
build linux-arm64  GOARCH=arm64                     # Raspberry Pi 3/4/5 (64-bit), newer routers
build linux-amd64  GOARCH=amd64                     # PCs and servers
ls -la dist
