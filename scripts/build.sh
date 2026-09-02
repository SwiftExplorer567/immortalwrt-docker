#!/usr/bin/env bash
set -eo pipefail

# ==============================================================================
# ImmortalWrt Custom Docker Image Builder Script
# Builds rootfs for specified target with OpenClash, Argon, WireGuard & TR/EN support
# ==============================================================================

TARGET="${1:-armsr/armv8}"
VERSION="${2:-25.12.1}"
OUTPUT_DIR="${3:-./build_output}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR="$(cd "${OUTPUT_DIR}" && pwd)"

echo "==> Building ImmortalWrt Docker RootFS"
echo "    Target:     ${TARGET}"
echo "    Version:    ${VERSION}"
echo "    Output Dir: ${OUTPUT_DIR}"

BUILD_WORK_DIR="${OUTPUT_DIR}/work_${TARGET//\//_}"
mkdir -p "${BUILD_WORK_DIR}"
cd "${BUILD_WORK_DIR}"

# Map target to architecture names
case "${TARGET}" in
    "armsr/armv8" | "armsr-armv8" | "arm64" | "aarch64")
        TARGET_PATH="armsr/armv8"
        TARGET_NAME="armsr-armv8"
        CORE_ARCH="arm64"
        PROFILE="generic"
        ;;
    "x86/64" | "x86-64" | "amd64" | "x86_64")
        TARGET_PATH="x86/64"
        TARGET_NAME="x86-64"
        CORE_ARCH="amd64"
        PROFILE="generic"
        ;;
    *)
        echo "Error: Unsupported target ${TARGET}. Supported: armsr/armv8, x86/64"
        exit 1
        ;;
esac

IB_NAME="immortalwrt-imagebuilder-${VERSION}-${TARGET_NAME}.Linux-x86_64"
IB_ZST="${IB_NAME}.tar.zst"
IB_XZ="${IB_NAME}.tar.xz"

# Setup optional authorization header if GITHUB_TOKEN is available
AUTH_HEADER=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# 1. Download & Extract ImageBuilder
if [ ! -d "${BUILD_WORK_DIR}/${IB_NAME}" ]; then
    echo "==> Downloading ImmortalWrt ImageBuilder for ${TARGET_NAME}..."
    BASE_URL="https://downloads.immortalwrt.org/releases/${VERSION}/targets/${TARGET_PATH}"
    
    if curl --head --silent --fail "${BASE_URL}/${IB_ZST}" >/dev/null; then
        echo "    Found zstd archive: ${IB_ZST}"
        curl -fSL "${BASE_URL}/${IB_ZST}" -o "${IB_ZST}"
        tar --zstd -xf "${IB_ZST}" -C "${BUILD_WORK_DIR}"
    elif curl --head --silent --fail "${BASE_URL}/${IB_XZ}" >/dev/null; then
        echo "    Found xz archive: ${IB_XZ}"
        curl -fSL "${BASE_URL}/${IB_XZ}" -o "${IB_XZ}"
        tar -xf "${IB_XZ}" -C "${BUILD_WORK_DIR}"
    else
        echo "Error: Could not find ImageBuilder archive at ${BASE_URL}"
        exit 1
    fi
fi

IB_DIR=$(find "${BUILD_WORK_DIR}" -maxdepth 1 -mindepth 1 -type d -name "immortalwrt-imagebuilder-*" | head -n 1)

if [ -z "${IB_DIR}" ] || [ ! -f "${IB_DIR}/Makefile" ]; then
    echo "Error: Could not locate extracted ImageBuilder directory in ${BUILD_WORK_DIR}"
    ls -la "${BUILD_WORK_DIR}"
    exit 1
fi

echo "==> Using ImageBuilder directory: ${IB_DIR}"
mkdir -p "${IB_DIR}/packages"
mkdir -p "${IB_DIR}/files"

# 2. Copy files overlay
echo "==> Preparing files overlay..."
cp -r "${REPO_ROOT}/files/"* "${IB_DIR}/files/" 2>/dev/null || true
chmod +x "${IB_DIR}/files/etc/uci-defaults/"* 2>/dev/null || true

# 3. Download latest OpenClash IPK
echo "==> Fetching latest OpenClash package..."
OPENCLASH_URL=$(curl -sSL "${AUTH_HEADER[@]}" https://api.github.com/repos/vernesong/OpenClash/releases/latest | \
    grep -o 'https://[^"]*luci-app-openclash[^"]*\.ipk' | head -n 1)

if [ -n "${OPENCLASH_URL}" ]; then
    echo "    Downloading: ${OPENCLASH_URL}"
    curl -sSL "${OPENCLASH_URL}" -o "${IB_DIR}/packages/luci-app-openclash.ipk"
else
    echo "Warning: Could not fetch OpenClash latest release URL directly via API, trying master branch fallback..."
    curl -sSL "https://raw.githubusercontent.com/vernesong/OpenClash/package/luci-app-openclash.ipk" -o "${IB_DIR}/packages/luci-app-openclash.ipk" || true
fi

# 4. Download latest Mihomo (Clash Meta) Core binary
echo "==> Fetching latest Mihomo core for ${CORE_ARCH}..."
mkdir -p "${IB_DIR}/files/etc/openclash/core"
MIHOMO_URL=$(curl -sSL "${AUTH_HEADER[@]}" https://api.github.com/repos/MetaCubeX/mihomo/releases/latest | \
    grep -o "https://[^\"]*mihomo-linux-${CORE_ARCH}[^\"]*\.gz" | head -n 1)

if [ -n "${MIHOMO_URL}" ]; then
    echo "    Downloading Mihomo core: ${MIHOMO_URL}"
    curl -sSL "${MIHOMO_URL}" -o "${BUILD_WORK_DIR}/mihomo.gz"
    gzip -dc "${BUILD_WORK_DIR}/mihomo.gz" > "${IB_DIR}/files/etc/openclash/core/clash_meta"
    chmod +x "${IB_DIR}/files/etc/openclash/core/clash_meta"
    # Create symlink/copy for standard clash name
    cp "${IB_DIR}/files/etc/openclash/core/clash_meta" "${IB_DIR}/files/etc/openclash/core/clash" || true
fi

# 5. Prepare Package List
echo "==> Generating package list..."
PACKAGES_LIST=$(grep -v '^#' "${REPO_ROOT}/config/packages.txt" | grep -v '^[[:space:]]*$' | tr '\n' ' ')
PACKAGES="${PACKAGES_LIST} luci-app-openclash"

echo "    Packages: ${PACKAGES}"

# 6. Build RootFS using ImageBuilder
echo "==> Building Image with ImageBuilder..."
make -C "${IB_DIR}" image \
    PROFILE="${PROFILE}" \
    PACKAGES="${PACKAGES}" \
    FILES="files"

# 7. Locate and package the rootfs for Docker
echo "==> Packaging Docker RootFS..."
ROOTFS_FILE=$(find "${IB_DIR}/bin/targets/${TARGET_PATH}" -type f \( -name "*rootfs.tar.gz" -o -name "*rootfs.tar.zst" -o -name "*rootfs.tar.xz" \) | head -n 1)

if [ -z "${ROOTFS_FILE}" ]; then
    echo "Error: Could not locate built rootfs archive in ${IB_DIR}/bin/targets/${TARGET_PATH}"
    exit 1
fi

DEST_ROOTFS="${OUTPUT_DIR}/rootfs-${TARGET_NAME}.tar.gz"

if [[ "${ROOTFS_FILE}" == *.tar.gz ]]; then
    cp "${ROOTFS_FILE}" "${DEST_ROOTFS}"
elif [[ "${ROOTFS_FILE}" == *.tar.zst ]]; then
    echo "    Decompressing zstd rootfs and converting to .tar.gz..."
    zstd -d "${ROOTFS_FILE}" -o "${BUILD_WORK_DIR}/rootfs.tar"
    gzip -9 -c "${BUILD_WORK_DIR}/rootfs.tar" > "${DEST_ROOTFS}"
elif [[ "${ROOTFS_FILE}" == *.tar.xz ]]; then
    echo "    Decompressing xz rootfs and converting to .tar.gz..."
    xz -d -c "${ROOTFS_FILE}" | gzip -9 -c > "${DEST_ROOTFS}"
fi

echo "================================================================"
echo " SUCCESS! RootFS successfully generated:"
echo " ${DEST_ROOTFS} ($(du -h "${DEST_ROOTFS}" | cut -f1))"
echo "================================================================"
