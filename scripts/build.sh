#!/usr/bin/env bash
#
# DejaVu — production packager.
#
# Thin wrapper around scripts/release.py so local builds and GitHub Actions
# use the same staging, validation, checksum, and archive layout.
#
# Output:
#   build/DejaVu-<version>.zip   (always)
#   build/DejaVu-<version>.zxp   (signed CEP package, only if a cert is set)
#
# To sign a CEP .zxp, install Adobe's ZXPSignCmd and export:
#   ZXP_CERT=/path/to/cert.p12  ZXP_PASS=yourpassword  ./scripts/build.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

python3 scripts/release.py --build-only --bump none "$@"
