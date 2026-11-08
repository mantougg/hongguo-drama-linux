#!/usr/bin/env bash
# Build the ByteVC2-only helper from pinned upstream source; normal media stays on FFmpeg.
# Targets:
#   linux-x64       CPU helper `librempeg`: static x264, no libva dependency at all.
#   linux-x64-vaapi optional accel helper `librempeg-vaapi`: same CPU bvc2 decode plus
#                   h264_vaapi encoding. Links the system libva/libdrm dynamically; the
#                   CPU helper keeps working when libva is absent or probing fails.
# Usage: build-librempeg-source.sh BUILD_DIRECTORY linux-x64|linux-x64-vaapi [JOBS]
set -euo pipefail
ROOT=${1:?Usage: build-librempeg-source.sh BUILD_DIRECTORY linux-x64|linux-x64-vaapi [JOBS]}
TARGET=${2:?Missing target}
JOBS=${3:-4}
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || exit 1
case "$TARGET" in
  linux-x64) [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1 ;;
  linux-x64-vaapi) [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1
    # LIBREMPEG_VAAPI_PKG_CONFIG lets a build host supply libva/libdrm metadata
    # from extracted development packages instead of a system-wide install.
    VAAPI_PC_PROBE=${LIBREMPEG_VAAPI_PKG_CONFIG:-$(pkg-config --variable=pc_path pkg-config 2>/dev/null || echo /usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig)}
    PKG_CONFIG_LIBDIR="$VAAPI_PC_PROBE" pkg-config --exists libva libva-drm libdrm \
      || { echo 'librempeg-vaapi 需要 libva-dev 与 libdrm-dev（或设置 LIBREMPEG_VAAPI_PKG_CONFIG 指向其 pkg-config 目录）' >&2; exit 1; } ;;
  *) exit 1 ;;
esac
SCRIPT=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
LIBREMPEG_COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
LIBREMPEG_SHA256=fd965e6ef9f745af96142cf118d7c2aa0dce906225c9d3cd2ef19e0221723813
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_TAR_SHA256=df62afece4eecef8ddf196f115dfec6e936a21b04ec2117a0f4e412de29b20e5
PKG_CONFIG_TOOL=$(command -v pkg-config)
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
mkdir -p "$ROOT"/{archives,sources,prefix,build-x264,logs,artifacts/bin,corresponding-source} "$ROOT/build-$TARGET"
LIBREMPEG_ARCHIVE="$ROOT/archives/librempeg-$LIBREMPEG_COMMIT.tar.gz"
X264_ARCHIVE="$ROOT/archives/x264-$X264_COMMIT.tar.gz"
[[ -f "$LIBREMPEG_ARCHIVE" ]] || curl -fsSL --retry 2 "https://codeload.github.com/librempeg/librempeg/tar.gz/$LIBREMPEG_COMMIT" -o "$LIBREMPEG_ARCHIVE"
if [[ ! -f "$X264_ARCHIVE" ]]; then
  FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
  git -C "$FETCH_DIR" init --quiet
  git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
  git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" FETCH_HEAD | gzip -n > "$X264_ARCHIVE"
fi
python3 - "$LIBREMPEG_ARCHIVE" "$LIBREMPEG_SHA256" "$X264_ARCHIVE" "$X264_TAR_SHA256" <<'PY'
import gzip, hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == sys.argv[2], 'Librempeg archive mismatch'
assert hashlib.sha256(gzip.decompress(pathlib.Path(sys.argv[3]).read_bytes())).hexdigest() == sys.argv[4], 'x264 source mismatch'
PY
[[ -d "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT" ]] || tar -xzf "$LIBREMPEG_ARCHIVE" -C "$ROOT/sources"
[[ -d "$ROOT/sources/x264-$X264_COMMIT" ]] || tar -xzf "$X264_ARCHIVE" -C "$ROOT/sources"
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$ROOT/prefix/lib/pkgconfig"
if [[ "$TARGET" == linux-x64-vaapi ]]; then
  # The accel helper may use the system libva/libdrm; the CPU helper never may.
  export PKG_CONFIG_LIBDIR="$ROOT/prefix/lib/pkgconfig:${VAAPI_PC_PROBE}"
fi
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH DYLD_LIBRARY_PATH LDFLAGS CFLAGS CPPFLAGS || true
THREAD_ARGS=(--enable-pthreads)
X264_ARGS=(--host=x86_64-linux-gnu)
MEDIA_ARGS=(--arch=x86_64 --target-os=linux --extra-cflags=-I../prefix/include --extra-ldflags=-L../prefix/lib)
VAAPI_ARGS=()
TOOL_NAME=librempeg
if [[ "$TARGET" == linux-x64-vaapi ]]; then
  # lavfi 输入设备、color 源与 wrapped_avframe 仅用于实际编码探测（试编一帧）。
  VAAPI_ARGS=(--enable-vaapi --enable-encoder=h264_vaapi --enable-filter=hwupload,hwdownload,scale_vaapi
    --enable-indev=lavfi --enable-filter=color --enable-decoder=wrapped_avframe)
  TOOL_NAME=librempeg-vaapi
  # FFmpeg 的 vaapi 头文件探测不走 pkg-config；开发包解包使用时需显式传入包含与链接目录。
  [[ -n "${LIBREMPEG_VAAPI_CFLAGS:-}" ]] && MEDIA_ARGS+=("--extra-cflags=$LIBREMPEG_VAAPI_CFLAGS")
  [[ -n "${LIBREMPEG_VAAPI_LDFLAGS:-}" ]] && MEDIA_ARGS+=("--extra-ldflags=$LIBREMPEG_VAAPI_LDFLAGS")
fi
cd "$ROOT/build-x264"
"../sources/x264-$X264_COMMIT/configure" --prefix=../prefix "${X264_ARGS[@]}" \
  --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale \
  --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --disable-bashcompletion > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-$TARGET"
"../sources/librempeg-$LIBREMPEG_COMMIT/configure" --prefix=../prefix "${MEDIA_ARGS[@]}" \
  --disable-everything --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug \
  --disable-ffplay --disable-network --enable-ffmpeg --enable-ffprobe "${THREAD_ARGS[@]}" \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-muxer=mp4,null \
  --enable-decoder=bvc2,vvc,aac --enable-parser=aac --enable-encoder=libx264,aac \
  --enable-filter=scale,format,aformat,null,anull "${VAAPI_ARGS[@]}" \
  --enable-agpl --enable-gpl --enable-version3 --enable-libx264 --pkg-config="$PKG_CONFIG_TOOL" --pkg-config-flags=--static \
  > "$ROOT/logs/librempeg-configure.log" 2>&1
make -j "$JOBS" ffmpeg > "$ROOT/logs/librempeg-build.log" 2>&1
install -m 755 ffmpeg "$ROOT/artifacts/bin/$TOOL_NAME"
TOOL="$ROOT/artifacts/bin/$TOOL_NAME"
ldd "$TOOL" > "$ROOT/logs/imports-$TARGET.txt"
! grep -q 'not found' "$ROOT/logs/imports-$TARGET.txt"
"$TOOL" -hide_banner -decoders 2>/dev/null | awk '$2 == "bvc2" { found=1 } END { exit !found }'
if [[ "$TARGET" == linux-x64-vaapi ]]; then
  "$TOOL" -hide_banner -encoders 2>/dev/null | awk '$2 == "h264_vaapi" { found=1 } END { exit !found }'
else
  # The CPU helper must stay usable on hosts without any graphics stack.
  ! ldd "$TOOL" | grep -Eq 'libva|libdrm'
fi
cp "$LIBREMPEG_ARCHIVE" "$X264_ARCHIVE" "$SCRIPT" "$ROOT/corresponding-source/"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/COPYING.GPLv3" "$ROOT/artifacts/bin/LIBREMPEG-COPYING.GPLv3"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/COPYING.AGPLv3" "$ROOT/artifacts/bin/LIBREMPEG-COPYING.AGPLv3"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/LICENSE.md" "$ROOT/artifacts/bin/LIBREMPEG-LICENSE.md"
cp "$ROOT/sources/x264-$X264_COMMIT/COPYING" "$ROOT/artifacts/bin/LIBREMPEG-X264-LICENSE.txt"
python3 - "$ROOT" "$TARGET" <<'PY'
import gzip, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
target = root / 'artifacts' / ('librempeg-cb1f8f3-x264-b35605a-' + sys.argv[2] + '-corresponding-source.tar.gz')
def public_metadata(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    return info
with target.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w') as archive:
        archive.add(root / 'corresponding-source', arcname='corresponding-source', filter=public_metadata)
PY
echo "PASS pinned ByteVC2 helper built for $TARGET: $TOOL"
