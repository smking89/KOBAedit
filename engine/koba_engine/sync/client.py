"""Minimal HTTP client for the documented ``koba-sync/1`` contract.

The editor stays offline-first; this module is only used when the user has
configured an endpoint and token. It deliberately depends on the standard
library so the desktop app does not need another network dependency.

Contract
--------
``GET {endpoint}/v1/health``
    ``{"ok": true, "service": "koba-sync", "version": 1}``

``POST {endpoint}/v1/projects/{project_id}/push``
    Body: ``{"format": "koba-sync/1", "projectId": ..., "baseRevision": n,
    "force": bool, "payload": {...}, "payloadHash": "sha256:..."}``
    Response: ``{"format": "koba-sync/1", "projectId": ..., "revision": n,
    "etag": "...", "updatedAt": "...", "payloadHash": "..."}``
    A stale ``baseRevision`` returns HTTP 409 with
    ``{"error": "revision_conflict", "remote": {"revision": n, "etag": "...",
    "updatedAt": "...", "payload": {...}}}``.

``GET {endpoint}/v1/projects/{project_id}``
    Response: the same revision envelope plus ``payload``. HTTP 404 means the
    project has not been pushed yet.

Tokens are sent as ``Authorization: Bearer ...`` and are read from a local
file or ``KOBA_SYNC_TOKEN``; they are never written to SQLite or project JSON.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

FORMAT = "koba-sync/1"
DEFAULT_TIMEOUT = 30.0


class SyncHttpError(RuntimeError):
    """Transport or protocol failure with a user-facing message."""

    def __init__(self, message: str, *, status: int | None = None, detail: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.detail = detail


class RevisionConflict(SyncHttpError):
    """The server rejected a stale base revision."""

    def __init__(self, remote: dict[str, Any]) -> None:
        super().__init__("remote project changed since the last pull", status=409)
        self.remote = remote


def read_token(token_file: str | Path | None = None) -> str:
    if token_file:
        try:
            return Path(token_file).expanduser().read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise SyncHttpError(f"could not read sync token: {exc}") from exc
    return os.environ.get("KOBA_SYNC_TOKEN", "").strip()


def canonical_payload(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_hash(payload: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_payload(payload).encode("utf-8")).hexdigest()


def validate_endpoint(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SyncHttpError("sync endpoint must be an http(s) URL")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise SyncHttpError(
            "plain HTTP is only allowed for localhost; use HTTPS so the bearer token is not exposed"
        )
    return value


@dataclass
class SyncHttpClient:
    endpoint: str
    token: str = ""
    timeout: float = DEFAULT_TIMEOUT

    def __post_init__(self) -> None:
        self.endpoint = validate_endpoint(self.endpoint)
        self.token = self.token.strip()

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        headers = {
            "Accept": "application/json",
            "User-Agent": "koba-edit/sync-1",
        }
        body = None
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(
            f"{self.endpoint}{path}", data=body, headers=headers, method=method
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                status = int(response.status)
        except HTTPError as exc:
            raw = exc.read()
            status = int(exc.code)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                data = {}
            if status == 409 and isinstance(data.get("remote"), dict):
                raise RevisionConflict(data["remote"]) from exc
            detail = str(data.get("error") or raw.decode("utf-8", errors="replace")[:300])
            raise SyncHttpError(
                f"sync server returned HTTP {status}: {detail}", status=status, detail=detail
            ) from exc
        except URLError as exc:
            raise SyncHttpError(f"could not reach the sync server: {exc.reason}") from exc
        except TimeoutError as exc:
            raise SyncHttpError("the sync server timed out") from exc
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SyncHttpError("sync server returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise SyncHttpError("sync server returned a non-object response")
        return status, data

    def test(self) -> dict[str, Any]:
        _, data = self._request("GET", "/v1/health")
        if data.get("ok") is not True:
            raise SyncHttpError("sync server health check did not report ok")
        return data

    def push(
        self,
        project_id: str,
        payload: Any,
        *,
        base_revision: int = 0,
        force: bool = False,
    ) -> dict[str, Any]:
        project = quote(project_id.strip(), safe="")
        if not project:
            raise SyncHttpError("project id is required for sync")
        _, data = self._request(
            "POST",
            f"/v1/projects/{project}/push",
            {
                "format": FORMAT,
                "projectId": project_id,
                "baseRevision": int(base_revision),
                "force": bool(force),
                "payload": payload,
                "payloadHash": payload_hash(payload),
            },
        )
        if not isinstance(data.get("revision"), int):
            raise SyncHttpError("sync server response is missing a revision")
        return data

    def pull(self, project_id: str) -> dict[str, Any] | None:
        project = quote(project_id.strip(), safe="")
        if not project:
            raise SyncHttpError("project id is required for sync")
        try:
            _, data = self._request("GET", f"/v1/projects/{project}")
        except SyncHttpError as exc:
            if exc.status == 404:
                return None
            raise
        if not isinstance(data.get("revision"), int):
            raise SyncHttpError("sync server response is missing a revision")
        return data


__all__ = [
    "FORMAT",
    "RevisionConflict",
    "SyncHttpClient",
    "SyncHttpError",
    "canonical_payload",
    "payload_hash",
    "read_token",
    "validate_endpoint",
]
