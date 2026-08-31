#!/usr/bin/env bash
# ============================================================================
# RapidRAW 本地 AI 资产下载脚本
# ----------------------------------------------------------------------------
# 把 ONNX Runtime native 库 + 所有 9 个 ONNX 模型下载到 src-tauri/resources/
# 路径布局与 tauri.conf.json 的 bundle resources 配置完全对齐，运行时
# 直接通过 tauri::path::BaseDirectory::Resource 读取，零网络请求。
#
# 用法:
#   bash scripts/prepare-ai-assets.sh            # 下载当前平台的资产
#   TARGET_OS=android  bash scripts/prepare-ai-assets.sh   # 指定平台
#   TARGET_OS=linux    TARGET_ARCH=aarch64 bash scripts/... # 指定 OS + arch
#
# 端点链（自动降级）:
#   1. https://hf-mirror.com/CyberTimon/RapidRAW-Models
#   2. https://huggingface.co/CyberTimon/RapidRAW-Models
# ============================================================================
set -uo pipefail
FAILED=0   # 汇总下载失败个数（单个失败不中断，便于一次跑完再重试缺失项）

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES="$ROOT/src-tauri/resources"
AI_MODELS="$RESOURCES/ai_models"
MANIFEST="$RESOURCES/ai_models_manifest.json"  # 可选: 记录下载时间 + 版本信息

ORT_REPO="CyberTimon/RapidRAW-Models"
ORT_VERSION="onnxruntimes-v1.22.0"

# ── 端点链（国内优先 hf-mirror，降级官方） ──────────────────────────────
ENDPOINTS=(
    "https://hf-mirror.com"
    "https://huggingface.co"
)

# ── 平台探测 ────────────────────────────────────────────────────────────
detect_platform() {
    local os arch
    os="${TARGET_OS:-$(uname -s)}"
    arch="${TARGET_ARCH:-$(uname -m)}"
    case "$os" in
        Linux*)  os="linux" ;;
        Darwin*) os="macos" ;;
        MINGW*|MSYS*|CYGWIN*|Windows*) os="windows" ;;
        *) echo "FAIL: unsupported os $os" >&2; exit 1 ;;
    esac
    case "$arch" in
        x86_64|amd64)         arch="x86_64" ;;
        aarch64|arm64|armv8)  arch="aarch64" ;;
        *) echo "FAIL: unsupported arch $arch" >&2; exit 1 ;;
    esac
    echo "$os $arch"
}

read -r PLATFORM_OS PLATFORM_ARCH <<< "$(detect_platform)"

# 允许手动强制 Android 构建
if [ "${FORCE_ANDROID:-0}" = "1" ]; then
    PLATFORM_OS="android"
    PLATFORM_ARCH="aarch64"
fi

echo "▶ Target platform: ${PLATFORM_OS}-${PLATFORM_ARCH}"
echo "▶ Resources dir: $RESOURCES"

mkdir -p "$AI_MODELS"
mkdir -p "$ROOT/src-tauri/libs/arm64-v8a"   # Android ORT .so 额外拷贝目标

# ── 下载器（自动端点降级 + 重试 + SHA256 校验） ────────────────────────
_download() {
    local remote_path="$1" dest="$2" sha256="${3:-}"
    local basename
    basename="$(basename "$dest")"

    if [ -f "$dest" ] && [ -n "$sha256" ]; then
        local actual
        actual="$(sha256sum "$dest" 2>/dev/null | awk '{print $1}')"
        if [ "$actual" = "$sha256" ]; then
            echo "  ✓ $basename  (already valid, skip)"
            return 0
        else
            echo "  ⚠ $basename  exists but hash mismatch, re-downloading..."
            rm -f "$dest"
        fi
    elif [ -f "$dest" ] && [ -z "$sha256" ]; then
        echo "  ✓ $basename  (no hash, assume valid)"
        return 0
    fi

    local tmp="${dest}.part"
    local ok=0
    for ep in "${ENDPOINTS[@]}"; do
        local url="$ep/$ORT_REPO/resolve/main/$remote_path?download=true"
        echo "  → $basename  from ${ep#https://}..."
        if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 \
                 -o "$tmp" "$url" 2>/dev/null; then
            if [ -n "$sha256" ]; then
                local actual
                actual="$(sha256sum "$tmp" | awk '{print $1}')"
                if [ "$actual" = "$sha256" ]; then
                    mv "$tmp" "$dest"
                    echo "  ✓ $basename"
                    ok=1; break
                else
                    echo "    ✗ hash mismatch (got $actual, expected $sha256)"
                    rm -f "$tmp"
                fi
            else
                mv "$tmp" "$dest"
                echo "  ✓ $basename"
                ok=1; break
            fi
        else
            echo "    ✗ download failed on ${ep#https://}"
            rm -f "$tmp"
        fi
    done

    if [ "$ok" -eq 0 ]; then
        echo "✗ FAIL: could not fetch $basename from any endpoint" >&2
        return 1
    fi
    return 0
}

# 容错包装：单个资产失败只计数（FAILED +1），不中断整批下载
download() {
    if ! _download "$@"; then
        FAILED=$((FAILED + 1))
    fi
}

# ── ONNX Runtime native 库（每个平台 1 个） ────────────────────────────
echo ""
echo "── ONNX Runtime native library ──"

case "${PLATFORM_OS}-${PLATFORM_ARCH}" in
    windows-x86_64)
        download "$ORT_VERSION/onnxruntime-windows-x86_64.dll" \
                 "$RESOURCES/onnxruntime.dll" \
                 "579b636403983254346a5c1d80bd28f1519cd1e284cd204f8d4ff41f8d711559"
        ;;
    windows-aarch64)
        download "$ORT_VERSION/onnxruntime-windows-aarch64.dll" \
                 "$RESOURCES/onnxruntime.dll" \
                 "79281671a386ed1baab9dbdbb09fe55f99577011472e9526cf9d0b468bb6bcc7"
        ;;
    linux-x86_64)
        download "$ORT_VERSION/libonnxruntime-linux-x86_64.so" \
                 "$RESOURCES/libonnxruntime.so" \
                 "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673"
        ;;
    linux-aarch64)
        download "$ORT_VERSION/libonnxruntime-linux-aarch64.so" \
                 "$RESOURCES/libonnxruntime.so" \
                 "0afd69a0ae38c5099fd0e8604dda398ac43dee67cd9c6394b5142b19e82528de"
        ;;
    macos-x86_64)
        download "$ORT_VERSION/libonnxruntime-macos-x86_64.dylib" \
                 "$RESOURCES/libonnxruntime.dylib" \
                 "283e595e61cf65df7a6b1d59a1616cbd35c8b6399dd90d799d99b71a3ff83160"
        ;;
    macos-aarch64)
        download "$ORT_VERSION/libonnxruntime-macos-aarch64.dylib" \
                 "$RESOURCES/libonnxruntime.dylib" \
                 "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a"
        ;;
    android-aarch64)
        # Android: 同一份 .so 放到两个位置
        download "$ORT_VERSION/libonnxruntime-android-arm64-v8a.so" \
                 "$RESOURCES/libonnxruntime.so" \
                 "999ecfdb5b5a13e4097487773b6d71ce8a075408a237daab072e8f5e817bd78e"
        # build.rs 会额外拷贝到 jniLibs，这里先放 resources/
        cp -f "$RESOURCES/libonnxruntime.so" \
              "$ROOT/src-tauri/libs/arm64-v8a/libonnxruntime.so"
        echo "  → copied to src-tauri/libs/arm64-v8a/libonnxruntime.so for jniLibs"
        ;;
    *)
        echo "✗ unsupported platform ${PLATFORM_OS}-${PLATFORM_ARCH}" >&2
        exit 1
        ;;
esac

# ── 9 个 AI 模型 ───────────────────────────────────────────────────────
echo ""
echo "── 9 AI models (ONNX + tokenizer) ──"

download "sam_vit_b_01ec64_encoder.onnx" \
         "$AI_MODELS/sam_vit_b_01ec64_encoder.onnx" \
         "16ab73d9c824886f0de2938c19df22fb9ec3deebfd0de58e65177e479213d7d1"

download "sam_vit_b_01ec64_decoder.onnx" \
         "$AI_MODELS/sam_vit_b_01ec64_decoder.onnx" \
         "85d0d672cf5b7fe763edcde429e5533e62f674af4b15c7d688b7673b0ef00bf7"

download "u2net.onnx" \
         "$AI_MODELS/u2net.onnx" \
         "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491"

download "skyseg-u2net.onnx" \
         "$AI_MODELS/skyseg-u2net.onnx" \
         "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39"

download "depth_anything_v2_vits.onnx" \
         "$AI_MODELS/depth_anything_v2_vits.onnx" \
         "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be"

download "nind_denoise_utnet_684.onnx" \
         "$AI_MODELS/nind_denoise_utnet_684.onnx" \
         "ee3586279d514df557ff3f7dec6df37fafc51ba5d3a3435b2cc9ac2d9017e7fe"

download "clip_model.onnx" \
         "$AI_MODELS/clip_model.onnx" \
         "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00"

download "clip_tokenizer.json" \
         "$AI_MODELS/clip_tokenizer.json" \
         ""   # tokenizer 是 JSON，上游仓库没给 hash，跳过校验

download "lama_fp16.onnx" \
         "$AI_MODELS/lama_fp16.onnx" \
         "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c"

# ── 输出汇总 ───────────────────────────────────────────────────────────
echo ""
if [ "$FAILED" -gt 0 ]; then
    echo "══════════════════════════════════════════════════════════════════"
    echo "  ⚠  $FAILED asset(s) failed to download this run."
    echo "     网络（尤其 HuggingFace 系端点）不通时属正常，请重新执行本脚本重试缺失项。"
    echo "     可用: TARGET_OS=linux TARGET_ARCH=x86_64 bash scripts/prepare-ai-assets.sh"
    echo "══════════════════════════════════════════════════════════════════"
    echo ""
    ls -lh --time-style=short "$AI_MODELS/" 2>/dev/null | sed 's/^/    /'
    exit 1
fi
echo "══════════════════════════════════════════════════════════════════"
echo "  ALL AI ASSETS READY"
echo "══════════════════════════════════════════════════════════════════"
echo ""
echo "  Platform   : ${PLATFORM_OS}-${PLATFORM_ARCH}"
echo "  ORT lib    : $RESOURCES/libonnxruntime.* (or onnxruntime.dll)"
echo "  AI models  : $AI_MODELS/"
ls -lh --time-style=short "$AI_MODELS/" 2>/dev/null | sed 's/^/    /'
echo ""
echo "Next steps:"
echo "  1. run 'cargo build --release' (build.rs will verify assets)"
echo "  2. run app, disconnect network, verify all AI features work"
echo "══════════════════════════════════════════════════════════════════"
