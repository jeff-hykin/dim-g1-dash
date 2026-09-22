#!/usr/bin/env bash
# Build the shipped prebuilt g1_helper for linux-aarch64 (the G1's Jetson).
#
# Why not `nix build`: nixpkgs-unstable's glibc is far newer than the Jetson's
# (Ubuntu 20.04, glibc 2.31), so a nix-built binary only runs through the nix
# store. We build inside an Ubuntu 20.04 arm64 container instead — same distro
# and glibc as the robot, and native speed on an Apple Silicon Mac (no
# cross-compilation, no Linux builder VM). The SDK revisions below are the ones
# pinned in flake.lock; keep them in sync when the lock moves.
#
#   ./build_prebuilt.sh          # writes ./bin/g1_helper-linux-aarch64
#
# Needs Docker with linux/arm64 support (Apple Silicon, or any aarch64 Linux).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/bin"
mkdir -p "$OUT"

docker run --rm --platform linux/arm64 \
    -v "$HERE:/src:ro" -v "$OUT:/out" \
    ubuntu:20.04 bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive
LIVOX_REV=f5d9375f84efe2b15bc0a052d3e18482ed13adf4     # flake.lock: livox-sdk2
UNITREE_REV=21d0a3b2c46ee48c8fdf2783becb6be3beb0a59b   # flake.lock: unitree-sdk2

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential cmake git ca-certificates pkg-config \
    nlohmann-json3-dev libturbojpeg0-dev libeigen3-dev binutils patchelf file >/dev/null

mkdir -p /work && cd /work
for repo_rev in "livox https://github.com/Livox-SDK/Livox-SDK2.git $LIVOX_REV" \
                "unitree https://github.com/unitreerobotics/unitree_sdk2.git $UNITREE_REV"; do
    set -- $repo_rev
    git init -q "$1" && git -C "$1" remote add origin "$2"
    git -C "$1" fetch -q --depth 1 origin "$3" && git -C "$1" checkout -q FETCH_HEAD
done

# Livox: its headers use uint64_t without <cstdint>, same as the flake does.
cmake -S livox -B livox-build -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/livox -DCMAKE_CXX_FLAGS="-include cstdint" >/dev/null
cmake --build livox-build -j"$(nproc)" >/dev/null && cmake --install livox-build >/dev/null

# Livox and unitree_sdk2 each vendor a different rapidjson as weak (COMDAT)
# symbols; linked into one binary the linker dedups the mismatched layouts and
# Livox segfaults. Rename Livox'"'"'s copy outright (same fix as the flake'"'"'s postFixup).
ARCHIVE=/opt/livox/lib/liblivox_lidar_sdk_static.a
nm --defined-only "$ARCHIVE" \
  | awk '"'"'$3 ~ /rapidjson/ { print $3 " livox_" $3 }'"'"' | sort -u > /work/rj.map
objcopy --redefine-syms=/work/rj.map "$ARCHIVE"

# unitree_sdk2: the bundled examples need unvendored deps and do not build.
cmake -S unitree -B unitree-build -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/unitree -DBUILD_EXAMPLES=OFF >/dev/null
cmake --build unitree-build -j"$(nproc)" >/dev/null && cmake --install unitree-build >/dev/null

# Static-link everything we can; CycloneDDS is shipped by unitree as .so only,
# so it rides along in bin/lib-linux-aarch64 and is found via the $ORIGIN rpath.
cmake -S /src -B /work/build -DCMAKE_BUILD_TYPE=Release \
      -DLIVOX_SDK_ROOT=/opt/livox -DCMAKE_PREFIX_PATH=/opt/unitree \
      -DLIVOX_LIB=/opt/livox/lib/liblivox_lidar_sdk_static.a \
      -DTURBOJPEG_LIB="$(ls /usr/lib/*/libturbojpeg.a | head -1)" \
      -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc -Wl,-rpath,\$ORIGIN/lib-linux-aarch64 -Wl,--disable-new-dtags" >/dev/null
cmake --build /work/build -j"$(nproc)"

install -m 755 /work/build/g1_helper /out/g1_helper-linux-aarch64
strip /out/g1_helper-linux-aarch64
# CMake also bakes the build-tree /opt/unitree/lib into the rpath; drop it so the
# only search path that ships is the relative one.
patchelf --set-rpath "\$ORIGIN/lib-linux-aarch64" /out/g1_helper-linux-aarch64
# The installed libddsc.so.0 / libddscxx.so.0 are symlinks to the real .so files,
# so dereference (cp -L) — a preserved symlink would ship as a dangling link.
mkdir -p /out/lib-linux-aarch64
cp -L /opt/unitree/lib/libddsc.so /out/lib-linux-aarch64/libddsc.so.0
cp -L /opt/unitree/lib/libddscxx.so /out/lib-linux-aarch64/libddscxx.so.0
chmod 755 /out/lib-linux-aarch64/*.so.0
strip --strip-unneeded /out/lib-linux-aarch64/*.so.0

file /out/g1_helper-linux-aarch64
readelf -d /out/g1_helper-linux-aarch64 | grep -E "NEEDED|RPATH"
objdump -T /out/g1_helper-linux-aarch64 | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1
'
echo "wrote $OUT/g1_helper-linux-aarch64"
