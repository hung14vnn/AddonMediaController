#!/bin/sh
set -e

# A bind mount over /app shadows the image's application code with the user's
# data directory; fail fast here instead of emitting confusing writability or
# runtime errors against the shadowing mount later. /app is always present in
# the image, so a missing /app means we are outside the container (e.g. tests
# or a hand-run shell) and the check is skipped.
if [ -d /app ] && { [ ! -f /app/main.py ] || [ ! -f /app/.droppedneedle-source-revision ] || [ ! -f /app/maintenance/automatic_upgrade.py ]; }; then
    echo "[init] FATAL: /app does not contain the DroppedNeedle application code."
    echo "[init]   A bind mount over /app hides the application with your data."
    echo "[init]   Mount data subdirectories only: /app/config, /app/cache, /app/plugins, /app/imports."
    echo "[init]   Remove the /app bind mount and restart."
    exit 1
fi

REQUESTED_UMASK=${UMASK:-027}
case "$REQUESTED_UMASK" in
    [0-7][0-7][0-7]|0[0-7][0-7][0-7]) ;;
    *) echo "[init] FATAL: UMASK='$REQUESTED_UMASK' must be three or four octal digits."; exit 1;;
esac
umask "$REQUESTED_UMASK"

PUID=${PUID:-1000}
PGID=${PGID:-1000}

case "$PUID" in ''|*[!0-9]*) echo "[init] FATAL: PUID='$PUID' is not a valid numeric UID."; exit 1;; esac
case "$PGID" in ''|*[!0-9]*) echo "[init] FATAL: PGID='$PGID' is not a valid numeric GID."; exit 1;; esac

check_writable() {
    _dir="$1"
    _identity="$2"
    _probe="$_dir/.droppedneedle_write_test_$$"
    if [ -n "$_identity" ]; then
        gosu "$_identity" touch "$_probe" 2>/dev/null; _rc=$?
        gosu "$_identity" rm -f "$_probe" 2>/dev/null
    else
        touch "$_probe" 2>/dev/null; _rc=$?
        rm -f "$_probe" 2>/dev/null
    fi
    return "$_rc"
}

# Run a command under the runtime identity: directly when this process is
# already non-root, gosu'd down when starting as root. Keeps all startup work
# owned by the account uvicorn eventually runs as.
run_as_runtime() {
    if [ "$(id -u)" -ne 0 ]; then
        "$@"
    else
        gosu droppedneedle:droppedneedle "$@"
    fi
}

configure_static_base_path() {
    echo "[init] Configuring frontend static bundle."
    if ! run_as_runtime python -m maintenance.configure_frontend_base; then
        echo "[init] FATAL: Failed to stamp BASE_PATH into the frontend static bundle."
        echo "[init]   Fix the BASE_PATH value reported above, or make DROPPEDNEEDLE_STATIC_DIR"
        echo "[init]   writable by this UID (the image default lives under /app/cache), then restart."
        exit 1
    fi
}

# The public registry omits utilities.sflx even though the tidal/qobuz/deezer/
# amazon providers import modules from it. MORNYE_EXT_LINKS points at the
# bundled links file so both this bootstrap and Mornye's lazy loader can
# install it; a missing file is fine because the registry alone may suffice.
bootstrap_mornye_extensions() {
    if [ -z "${MORNYE_REGISTRIES:-}" ] && [ -z "${MORNYE_EXT_LINKS:-}" ]; then
        return 0
    fi
    echo "[init] Bootstrapping Mornye extensions."
    if ! run_as_runtime python -c '
from mornye.extensions.manager import ExtensionManager
manager = ExtensionManager(auto_install_downloads=True)
if manager.get_installed("utilities") is None:
    try:
        manager.install_from_links_file()
    except FileNotFoundError:
        pass
' >/dev/null 2>&1; then
        echo "[init] WARNING: Mornye extension bootstrap failed; downloads may be unavailable."
    fi
}


if [ "$(id -u)" -ne 0 ]; then
    echo "[init] Running as uid=$(id -u) gid=$(id -g) (non-root); skipping user/group setup."
    for dir in /app/cache /app/cache/mornye /app/config /app/imports; do
        mkdir -p "$dir" 2>/dev/null || true
        if ! check_writable "$dir"; then
            echo "[init] FATAL: $dir is not writable by uid=$(id -u)."
            echo "[init]   Ensure the host directory is owned by this UID/GID."
            echo "[init]   Run: chown $(id -u):$(id -g) <host-path>"
            exit 1
        fi
    done
    # Mornye output is normally a host bind mount. Warn instead of aborting so
    # the rest of the app still starts when Mornye is disabled.
    if [ -d /mornye-downloads ] && ! check_writable /mornye-downloads; then
        echo "[init] WARNING: /mornye-downloads is not writable by uid=$(id -u); Mornye downloads will fail."
        echo "[init]   Fix: chown $(id -u):$(id -g) the host folder mounted at /mornye-downloads."
    fi
    configure_static_base_path
    bootstrap_mornye_extensions
    exec "$@"
fi

# Only remap when the baked identity differs from the requested PUID/PGID.
# usermod/groupmod can stall for minutes on some storage backends, and they
# block startup before uvicorn execs, so skip them entirely when not needed.
if [ "$(id -g droppedneedle)" != "$PGID" ]; then
    if ! groupmod -o -g "$PGID" droppedneedle 2>/dev/null; then
        echo "[init] WARNING: Could not set droppedneedle group to GID=$PGID."
    fi
fi
if [ "$(id -u droppedneedle)" != "$PUID" ]; then
    if ! usermod -o -u "$PUID" droppedneedle 2>/dev/null; then
        echo "[init] WARNING: Could not set droppedneedle user to UID=$PUID."
    fi
fi

TARGET_UID=$(id -u droppedneedle)
TARGET_GID=$(id -g droppedneedle)
echo "[init] Runtime user: droppedneedle (uid=$TARGET_UID gid=$TARGET_GID)"

if [ "$TARGET_UID" != "$PUID" ]; then
    echo "[init] WARNING: Requested PUID=$PUID but running as uid=$TARGET_UID (usermod may have failed)."
fi
if [ "$TARGET_GID" != "$PGID" ]; then
    echo "[init] WARNING: Requested PGID=$PGID but running as gid=$TARGET_GID (groupmod may have failed)."
fi

for dir in /app/cache /app/cache/mornye /app/config /app/imports; do
    mkdir -p "$dir" 2>/dev/null || true

    if check_writable "$dir" "$TARGET_UID:$TARGET_GID"; then
        continue
    fi

    if chown droppedneedle:droppedneedle "$dir" 2>/dev/null; then
        echo "[init] Adjusted ownership of $dir - verifying write access."
    else
        echo "[init] WARNING: Could not chown $dir (mount may not support ownership changes)."
    fi

    if ! check_writable "$dir" "$TARGET_UID:$TARGET_GID"; then
        echo "[init] FATAL: $dir is not writable by uid=$TARGET_UID gid=$TARGET_GID."
        echo "[init]   Common causes: FUSE/shfs (Unraid), NFS root_squash, CIFS/SMB, dropped CAP_CHOWN."
        echo "[init]   Fix: ensure the host directory is writable by uid=$TARGET_UID gid=$TARGET_GID."
        exit 1
    fi
done

# Docker creates a missing bind source as root:root, which leaves the runtime
# user unable to create Mornye's staging directory. Repair it like the data
# dirs above, but only warn on failure: Mornye may be disabled and other
# download clients cannot run when the whole startup aborts.
if [ -d /mornye-downloads ] && ! check_writable /mornye-downloads "$TARGET_UID:$TARGET_GID"; then
    if chown droppedneedle:droppedneedle /mornye-downloads 2>/dev/null; then
        echo "[init] Adjusted ownership of /mornye-downloads - verifying write access."
    else
        echo "[init] WARNING: Could not chown /mornye-downloads (mount may not support ownership changes)."
    fi
    if ! check_writable /mornye-downloads "$TARGET_UID:$TARGET_GID"; then
        echo "[init] WARNING: /mornye-downloads is not writable by uid=$TARGET_UID gid=$TARGET_GID."
        echo "[init]   Mornye downloads will fail; chown the host folder to $TARGET_UID:$TARGET_GID."
    fi
fi
configure_static_base_path

bootstrap_mornye_extensions

exec gosu droppedneedle:droppedneedle "$@"
