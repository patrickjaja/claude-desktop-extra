#!/bin/bash
# Source this file from the local build scripts (build-local.sh).
#
# Computer Use bridges are bundled into the package. A bridge built on a rolling
# host (Arch) can require a newer glibc than the floor CI enforces, so a package
# built locally would not start that bridge on e.g. Fedora 43 (glibc 2.42) and
# the app silently falls back to another screenshot path. This helper:
#   1. checks every bundled bridge against its floor (objdump -T, sort -V, as CI)
#   2. rebuilds an over-floor dynamic bridge in ubuntu:24.04 (docker), like CI
#   3. warns (or fails with CDB_STRICT_BRIDGES=1) when that is not possible
#
# Floors (single source: .claude/skills/linux/SKILL.md "Native binaries & glibc
# floors"; CI asserts the same in .github/workflows/build-and-release.yml):
#   x11-bridge, wlroots-bridge          static musl, no glibc
#   gnome-portal-bridge, kwin-portal-bridge   GLIBC_2.39 (Ubuntu Noble)
#
# x86_64 only: the local scripts build for the host arch and the container build
# is x86_64 (CI builds aarch64 separately).
#
# Environment:
#   CDB_STRICT_BRIDGES=1   turn the "cannot guarantee the floor" warning into an error
#   CDB_BRIDGE_IMAGE       container image (default ubuntu:24.04)

CDB_BRIDGE_IMAGE="${CDB_BRIDGE_IMAGE:-ubuntu:24.04}"

_cdb_say() {
    # $1 = info|warn|error, rest = message
    local lvl="$1"
    shift
    if declare -F "log_$lvl" >/dev/null; then
        "log_$lvl" "$*"
    else
        echo "[$lvl] $*" >&2
    fi
}

# Prints the floor ("2.39") for a bridge, or "static" for the musl bridges.
cdb_bridge_floor() {
    case "$1" in
        x11-bridge | wlroots-bridge) echo static ;;
        gnome-portal-bridge | kwin-portal-bridge) echo 2.39 ;;
        *) return 1 ;;
    esac
}

# Prints the highest GLIBC_ version a binary needs (e.g. 2.44), empty when it
# needs none (static). Returns 1 when objdump cannot read the file.
cdb_glibc_max() {
    local out
    out="$(objdump -T "$1" 2>/dev/null)" || {
        # static-pie has no dynamic symbol table: objdump exits non-zero there
        # but the file is still a valid ELF.
        if command -v file >/dev/null 2>&1 && file -b "$1" 2>/dev/null | grep -qE 'ELF.*(statically linked|static-pie)'; then
            return 0
        fi
        return 1
    }
    printf '%s\n' "$out" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 | sed 's/^GLIBC_//' || true
}

# cdb_bridge_check BIN FLOOR  -> 0 when within the floor. Sets CDB_CHECK_MAX.
# FLOOR is "static" (no GLIBC_ symbol allowed) or a version.
cdb_bridge_check() {
    local bin="$1" floor="$2" max
    CDB_CHECK_MAX=""
    if ! max="$(cdb_glibc_max "$bin")"; then
        CDB_CHECK_MAX="unreadable"
        return 1
    fi
    CDB_CHECK_MAX="$max"
    if [ -z "$max" ]; then
        return 0
    fi
    if [ "$floor" = static ]; then
        return 1
    fi
    [ "$(printf '%s\n%s\n' "GLIBC_$max" "GLIBC_$floor" | sort -V | tail -1)" = "GLIBC_$floor" ]
}

# Hash of the checkout state: HEAD + tracked diff + untracked file contents.
_cdb_src_key() {
    local dir="$1"
    {
        git -C "$dir" rev-parse HEAD 2>/dev/null || echo no-git
        git -C "$dir" diff HEAD 2>/dev/null || true
        git -C "$dir" ls-files -o --exclude-standard -z -- . ':!target' 2>/dev/null |
            (cd "$dir" && xargs -0 -r sha256sum 2>/dev/null) || true
    } | sha256sum | cut -d' ' -f1
}

_cdb_docker_usable() {
    command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# apt packages per bridge, same as the CI jobs (x86_64 part only).
_cdb_bridge_pkgs() {
    case "$1" in
        kwin-portal-bridge) echo "build-essential pkg-config clang cmake curl ca-certificates git libxkbcommon-dev libpipewire-0.3-dev" ;;
        gnome-portal-bridge) echo "build-essential pkg-config clang cmake curl ca-certificates git libpipewire-0.3-dev" ;;
        *) return 1 ;;
    esac
}

# cdb_container_build NAME SRC_DIR -> sets CDB_BUILT_PATH to a floor-checked binary
# and CDB_BUILD_CACHED to 1 (cache hit) or 0. Called without a subshell on purpose.
# Cache: SRC_DIR/target/glibc-<floor>/NAME (+ NAME.key); target/ is gitignored
# in the bridge repos. Never touches target/release or the checkout itself.
cdb_container_build() {
    local name="$1" src="$2" floor out key have pkgs
    floor="$(cdb_bridge_floor "$name")"
    out="$src/target/glibc-$floor"
    key="$(_cdb_src_key "$src")-$CDB_BRIDGE_IMAGE"
    if [ -f "$out/$name" ] && [ -f "$out/$name.key" ] && [ "$(cat "$out/$name.key")" = "$key" ] &&
        cdb_bridge_check "$out/$name" "$floor"; then
        CDB_BUILT_PATH="$out/$name"
        CDB_BUILD_CACHED=1
        return 0
    fi
    CDB_BUILD_CACHED=0
    CDB_BUILT_PATH=""
    _cdb_docker_usable || return 1
    pkgs="$(_cdb_bridge_pkgs "$name")" || return 1
    mkdir -p "$out"
    rm -f "$out/$name" "$out/$name.key"
    _cdb_say info "$name: building in $CDB_BRIDGE_IMAGE (glibc <= $floor), a few minutes on the first run..." >&2
    docker run --rm \
        -v "$src:/src:ro" -v "$out:/out" \
        -e DEBIAN_FRONTEND=noninteractive -e "PKGS=$pkgs" -e "NAME=$name" \
        -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
        "$CDB_BRIDGE_IMAGE" bash -euo pipefail -c '
            apt-get update -qq
            # shellcheck disable=SC2086
            apt-get install -y -qq --no-install-recommends $PKGS >/dev/null
            curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs |
                sh -s -- -y -q --profile minimal --default-toolchain stable \
                    --target x86_64-unknown-linux-gnu
            export PATH=/root/.cargo/bin:$PATH
            mkdir /work
            tar -C /src --exclude=./target --exclude=./.git -cf - . | tar -C /work -xf -
            cd /work
            cargo build --release --locked --target x86_64-unknown-linux-gnu
            cp "target/x86_64-unknown-linux-gnu/release/$NAME" "/out/$NAME"
            chown "$HOST_UID:$HOST_GID" "/out/$NAME"
        ' >&2 || return 1
    [ -f "$out/$name" ] || return 1
    # The floor is asserted on the result, never assumed.
    cdb_bridge_check "$out/$name" "$floor" || return 1
    printf '%s' "$key" >"$out/$name.key"
    CDB_BUILT_PATH="$out/$name"
}

_cdb_floor_problem() {
    # $1 = message; warn, or die under strict mode. Returns 0 when only warned.
    if [ "${CDB_STRICT_BRIDGES:-0}" = 1 ]; then
        _cdb_say error "$1 (--strict-bridges)"
        return 1
    fi
    _cdb_say warn "$1"
}

# cdb_resolve_bridge NAME SRC_DIR PREBUILT VARNAME
# Exports VARNAME (e.g. KWIN_PORTAL_BRIDGE_BIN) with the binary to bundle and
# logs one "NAME: <source> (<glibc>)" line. Honors a VARNAME set by the caller
# (only checked, never replaced). Returns 1 only under CDB_STRICT_BRIDGES.
# When SRC_DIR is missing and nothing is pre-built, the variable stays unset.
cdb_resolve_bridge() {
    local name="$1" src="$2" prebuilt="$3" var="$4" floor cur label
    floor="$(cdb_bridge_floor "$name")" || return 1
    label="glibc <= $floor"
    [ "$floor" = static ] && label="static"

    cur="${!var:-}"
    if [ -n "$cur" ]; then
        if cdb_bridge_check "$cur" "$floor"; then
            _cdb_say info "$name: $var override $cur ($label)"
            return 0
        fi
        _cdb_floor_problem "$name: $var override $cur needs glibc ${CDB_CHECK_MAX:-?}, above the floor $floor" || return 1
        return 0
    fi

    if [ -f "$prebuilt" ] && cdb_bridge_check "$prebuilt" "$floor"; then
        export "$var=$prebuilt"
        if [ "$floor" = static ]; then
            _cdb_say info "$name: pre-built static"
        else
            _cdb_say info "$name: pre-built (glibc ${CDB_CHECK_MAX:-none} <= $floor)"
        fi
        return 0
    fi

    if [ "$floor" = static ]; then
        if [ -f "$prebuilt" ]; then
            _cdb_floor_problem "$name: $prebuilt is expected to be static but needs glibc ${CDB_CHECK_MAX:-?}" || return 1
            export "$var=$prebuilt"
        fi
        return 0
    fi

    # Dynamic bridge: pre-built above the floor (or missing) with a checkout present.
    if [ ! -d "$src" ]; then
        return 0
    fi
    local found="" why="no pre-built binary"
    if [ -f "$prebuilt" ]; then
        found="$CDB_CHECK_MAX"
        why="the pre-built $prebuilt needs glibc $found"
    fi
    if cdb_container_build "$name" "$src"; then
        export "$var=$CDB_BUILT_PATH"
        if [ "${CDB_BUILD_CACHED:-0}" = 1 ]; then
            _cdb_say info "$name: container build, cached (glibc <= $floor)"
        else
            _cdb_say info "$name: container build (glibc <= $floor)"
        fi
        return 0
    fi

    local reason="docker is not usable"
    _cdb_docker_usable && reason="the container build failed"
    _cdb_floor_problem "$name: $why, above/without the floor $floor, and $reason. The package will run this bridge only on systems with glibc >= ${found:-that of the build host}: fine for installing on this machine, not for copying elsewhere" || return 1
    if [ -f "$prebuilt" ]; then
        export "$var=$prebuilt"
        _cdb_say info "$name: pre-built, host glibc $found (floor $floor NOT met)"
    fi
    return 0
}
