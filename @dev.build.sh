#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
TARGET_DIRS=(
  "/Users/downey/Projects/OutSource/aily-email/child/tools"
  "/Users/downey/Projects/OutSource/aily--blockly/child/tools"
)

cd "${ROOT_DIR}"

echo "Building aily tools..."
npm run build

if [[ ! -d "${DIST_DIR}" ]]; then
  echo "Build output not found: ${DIST_DIR}" >&2
  exit 1
fi

for TARGET_DIR in "${TARGET_DIRS[@]}"; do
  if [[ ! -d "${TARGET_DIR}" ]]; then
    echo "Deploy target not found: ${TARGET_DIR}" >&2
    exit 1
  fi

  case "${TARGET_DIR}" in
    "/Users/downey/Projects/OutSource/aily-email/child/tools" | \
    "/Users/downey/Projects/OutSource/aily--blockly/child/tools")
      ;;
    *)
      echo "Refusing to deploy to unexpected target: ${TARGET_DIR}" >&2
      exit 1
      ;;
  esac

  echo "Replacing ${TARGET_DIR} with ${DIST_DIR}..."
  find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "${DIST_DIR}/." "${TARGET_DIR}/"
done

echo "Local deploy complete."
