"""Persistent GLB extraction worker.

A fresh engine process re-parses every bundle (10 s for ``content.bundle``, 40 s
for ``assetscenes.bundle``). This daemon keeps parsed bundle environments and
their GameObject name indexes resident and serves requests over a Unix socket.

The desktop shell still starts a short-lived ``export-prefab-glb`` process for
its task/progress plumbing, but that process forwards to this daemon when given
``--daemon-socket``.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

from .prefab_glb import cache_stats, configure_env_cache, export_prefab_glb

# Resident-bundle budget. One extraction already peaks near 2.7 GB because the
# scene and content bundles are open at the same time, so the default leaves
# room for both of those plus the small bundles and reloads nothing in practice.
# Lowering it trades resident memory for minutes of re-parsing.
DEFAULT_CACHE_ENV_BYTES = 3072 * 1024 * 1024
START_TIMEOUT = 60.0
IDLE_TIMEOUT = 900.0


def socket_path() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return Path(base) / f"koba-edit-extract-{uid}.sock"


def _send(connection: socket.socket, payload: dict[str, Any]) -> None:
    connection.sendall(json.dumps(payload).encode("utf-8") + b"\n")


def _receive(connection: socket.socket, buffer: bytearray) -> dict[str, Any] | None:
    while b"\n" not in buffer:
        chunk = connection.recv(65536)
        if not chunk:
            return None
        buffer.extend(chunk)
    line, _, rest = bytes(buffer).partition(b"\n")
    buffer.clear()
    buffer.extend(rest)
    return json.loads(line) if line.strip() else {}


# --------------------------------------------------------------------- daemon
def serve(
    *,
    path: Path | None = None,
    cache_env_bytes: int = DEFAULT_CACHE_ENV_BYTES,
    idle_timeout: float = IDLE_TIMEOUT,
) -> int:
    target = path or socket_path()
    if target.exists():
        if _connect(target, 0.5) is not None:
            return 0  # another worker is already serving
        target.unlink(missing_ok=True)
    configure_env_cache(cache_env_bytes)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(target))
    server.listen(4)
    server.settimeout(idle_timeout)
    try:
        while True:
            try:
                connection, _ = server.accept()
            except socket.timeout:
                break
            with connection:
                connection.settimeout(None)
                _handle(connection)
    finally:
        server.close()
        target.unlink(missing_ok=True)
    return 0


def _handle(connection: socket.socket) -> None:
    def progress(stage: str, current: int, total: int, message: str) -> None:
        try:
            _send(
                connection,
                {"event": "progress", "stage": stage, "current": current, "total": total, "message": message},
            )
        except OSError:
            pass

    buffer = bytearray()
    while True:
        try:
            request = _receive(connection, buffer)
        except (OSError, json.JSONDecodeError):
            return
        if request is None:
            return
        if request.get("op") == "stop":
            _send(connection, {"event": "result", "ok": True})
            return
        cache_dir = str(request.get("cacheDir") or "")
        prefab = str(request.get("prefab") or "")
        started = time.monotonic()
        try:
            result = export_prefab_glb(
                prefab,
                str(request["bundleRoot"]),
                cache_dir,
                progress=progress,
                bundle=request.get("bundle") or None,
            )
            stats = cache_stats()
            _log_request(cache_dir, "ok", prefab, time.monotonic() - started, stats)
            _send(
                connection,
                {
                    "event": "result",
                    "ok": True,
                    **result,
                    "rssMb": stats["rssBytes"] // (1024 * 1024),
                    "cachedBundles": stats["entries"],
                },
            )
        except Exception as exc:  # a bad prefab must not stop the worker
            stats = cache_stats()
            _log_request(cache_dir, "failed", prefab, time.monotonic() - started, stats)
            _send(
                connection,
                {
                    "event": "result",
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "rssMb": stats["rssBytes"] // (1024 * 1024),
                    "cachedBundles": stats["entries"],
                },
            )


def _log_request(
    cache_dir: str,
    outcome: str,
    prefab: str,
    elapsed: float,
    stats: dict[str, int],
) -> None:
    """Append one line per request to ``<cache>/worker.log``.

    The shell starts the worker with stderr discarded, so the log file is the
    only place resident memory can be inspected after the fact.
    """
    if not cache_dir:
        return
    try:
        path = Path(cache_dir) / "worker.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        rss_mb = stats["rssBytes"] // (1024 * 1024)
        budget_mb = stats["budgetBytes"] // (1024 * 1024)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(
                f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {outcome} {prefab} "
                f"{elapsed:.1f}s rss={rss_mb}MB/{budget_mb}MB cached={stats['entries']}\n"
            )
    except OSError:
        pass


# --------------------------------------------------------------------- client
def _connect(path: Path, timeout: float = 5.0) -> socket.socket | None:
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(timeout)
        client.connect(str(path))
        client.settimeout(None)
        return client
    except OSError:
        return None


def request(
    prefab_path: str,
    bundle_root: str | Path,
    cache_dir: str | Path,
    *,
    bundle: str | Path | None = None,
    progress: Callable[..., None] | None = None,
    path: Path | None = None,
    cache_env_bytes: int = DEFAULT_CACHE_ENV_BYTES,
) -> dict[str, Any]:
    target = path or socket_path()
    client = _connect(target)
    if client is None:
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "rust_studio_engine",
                "extract-worker",
                "--socket",
                str(target),
                "--cache-env-mb",
                str(max(1, cache_env_bytes // (1024 * 1024))),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.monotonic() + START_TIMEOUT
        while client is None:
            client = _connect(target)
            if client is None:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"extraction worker did not start ({target})")
                time.sleep(0.2)
    try:
        _send(
            client,
            {
                "op": "extract",
                "prefab": prefab_path,
                "bundleRoot": str(bundle_root),
                "cacheDir": str(cache_dir),
                "bundle": str(bundle) if bundle else None,
            },
        )
        buffer = bytearray()
        while True:
            message = _receive(client, buffer)
            if message is None:
                raise ConnectionError("extraction worker closed the connection")
            if message.get("event") == "progress":
                if progress:
                    progress(
                        message.get("stage", "extracting"),
                        int(message.get("current", 0)),
                        int(message.get("total", 0)),
                        str(message.get("message", "")),
                    )
                continue
            if not message.get("ok"):
                raise ValueError(message.get("error", "extraction failed"))
            return message
    finally:
        client.close()
