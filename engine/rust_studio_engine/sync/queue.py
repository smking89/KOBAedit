"""Offline-first sync outbox.

Every project save runs offline. When a sync profile is active, the Tauri shell
(or the Python sidecar) calls :meth:`SyncQueue.mark_local_change`, which bumps the
local revision and enqueues a ``push``. The worker drains the queue when
connectivity is available and reports failures back with exponential backoff.

Remote pulls compare revisions before overwriting:

* remote revision > local and local is clean  -> fast-forward
* remote revision > local but local changed   -> ``conflict`` (UI decides)
* remote revision <= local                     -> local wins, queued push

Tokens never live in the database: ``sync_profiles.token_ref`` points at the OS
keyring entry the Rust shell reads.
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ENTITY_TYPES = ("project", "asset_pack", "asset")
OPERATIONS = ("push", "pull", "delete")


class SyncError(RuntimeError):
    """Raised for invalid sync state transitions."""


def utc_now(offset_seconds: float = 0.0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def file_hash(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class SyncQueue:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection
        self.connection.row_factory = sqlite3.Row

    # --------------------------------------------------------------- profiles
    def ensure_profile(
        self,
        name: str,
        endpoint: str,
        *,
        account_ref: str = "",
        activate: bool = True,
        token_ref: str = "keyring:rust-studio/sync",
    ) -> int:
        self.connection.execute(
            """
            INSERT INTO sync_profiles (name, endpoint, account_ref, token_ref, is_active)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (name) DO UPDATE SET
                endpoint = excluded.endpoint,
                account_ref = excluded.account_ref,
                token_ref = excluded.token_ref
            """,
            (name, endpoint, account_ref, token_ref),
        )
        row = self.connection.execute(
            "SELECT id FROM sync_profiles WHERE name = ?", (name,)
        ).fetchone()
        profile_id = int(row["id"])
        if activate:
            self.activate_profile(profile_id)
        return profile_id

    def activate_profile(self, profile_id: int) -> None:
        self.connection.execute("UPDATE sync_profiles SET is_active = 0")
        self.connection.execute(
            "UPDATE sync_profiles SET is_active = 1 WHERE id = ?", (profile_id,)
        )

    def active_profile(self) -> sqlite3.Row | None:
        return self.connection.execute(
            "SELECT * FROM sync_profiles WHERE is_active = 1 LIMIT 1"
        ).fetchone()

    # -------------------------------------------------------------- enqueueing
    def enqueue(
        self,
        profile_id: int,
        entity_type: str,
        entity_id: str,
        operation: str = "push",
        *,
        payload_path: str | Path | None = None,
        payload_hash: str = "",
        delay_seconds: float = 0.0,
    ) -> int:
        if entity_type not in ENTITY_TYPES:
            raise SyncError(f"unknown entity type '{entity_type}'")
        if operation not in OPERATIONS:
            raise SyncError(f"unknown operation '{operation}'")

        existing = self.connection.execute(
            """
            SELECT id FROM sync_queue
             WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
               AND operation = ? AND state IN ('queued', 'inflight')
             LIMIT 1
            """,
            (profile_id, entity_type, entity_id, operation),
        ).fetchone()
        if existing:
            self.connection.execute(
                """
                UPDATE sync_queue
                   SET payload_path = COALESCE(?, payload_path),
                       payload_hash = COALESCE(NULLIF(?, ''), payload_hash),
                       state = 'queued',
                       next_attempt_at = ?
                 WHERE id = ?
                """,
                (str(payload_path) if payload_path else None, payload_hash, utc_now(delay_seconds), existing["id"]),
            )
            return int(existing["id"])

        cursor = self.connection.execute(
            """
            INSERT INTO sync_queue (
                profile_id, entity_type, entity_id, operation, payload_path,
                payload_hash, state, next_attempt_at
            ) VALUES (?,?,?,?,?,?, 'queued', ?)
            """,
            (
                profile_id,
                entity_type,
                entity_id,
                operation,
                str(payload_path) if payload_path else None,
                payload_hash or (file_hash(payload_path) if payload_path else ""),
                utc_now(delay_seconds),
            ),
        )
        return int(cursor.lastrowid)

    def mark_local_change(
        self,
        profile_id: int,
        entity_type: str,
        entity_id: str,
        *,
        payload_path: str | Path | None = None,
    ) -> int:
        """Bump the local revision and queue a push."""
        self.connection.execute(
            """
            INSERT INTO sync_metadata (profile_id, entity_type, entity_id, local_revision, state)
            VALUES (?, ?, ?, 1, 'pending')
            ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                local_revision = sync_metadata.local_revision + 1,
                state = 'pending', error_message = NULL
            """,
            (profile_id, entity_type, entity_id),
        )
        return self.enqueue(profile_id, entity_type, entity_id, "push", payload_path=payload_path)

    # ------------------------------------------------------------------ drain
    def claim(self, limit: int = 4) -> list[sqlite3.Row]:
        """Atomically move due rows to ``inflight`` and return them."""
        now = utc_now()
        rows = self.connection.execute(
            """
            SELECT * FROM sync_queue
             WHERE state = 'queued' AND next_attempt_at <= ?
             ORDER BY next_attempt_at, id LIMIT ?
            """,
            (now, limit),
        ).fetchall()
        claimed: list[sqlite3.Row] = []
        for row in rows:
            cursor = self.connection.execute(
                "UPDATE sync_queue SET state = 'inflight', updated_at = ? WHERE id = ? AND state = 'queued'",
                (now, row["id"]),
            )
            if cursor.rowcount:
                claimed.append(
                    self.connection.execute(
                        "SELECT * FROM sync_queue WHERE id = ?", (row["id"],)
                    ).fetchone()
                )
        return claimed

    def complete(
        self,
        queue_id: int,
        *,
        remote_etag: str | None = None,
        remote_revision: int | None = None,
        remote_id: str | None = None,
    ) -> None:
        row = self._require(queue_id)
        self.connection.execute(
            "UPDATE sync_queue SET state = 'done', last_error = NULL, next_attempt_at = ? WHERE id = ?",
            (utc_now(), queue_id),
        )
        self.connection.execute(
            """
            INSERT INTO sync_metadata (
                profile_id, entity_type, entity_id, remote_id, remote_etag,
                remote_revision, last_synced_at, state
            ) VALUES (?,?,?,?,?,?,?, 'synced')
            ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                remote_id = COALESCE(excluded.remote_id, sync_metadata.remote_id),
                remote_etag = COALESCE(excluded.remote_etag, sync_metadata.remote_etag),
                remote_revision = COALESCE(excluded.remote_revision, sync_metadata.remote_revision),
                last_synced_at = excluded.last_synced_at,
                state = 'synced', error_message = NULL
            """,
            (
                row["profile_id"],
                row["entity_type"],
                row["entity_id"],
                remote_id,
                remote_etag,
                remote_revision,
                utc_now(),
            ),
        )
        self.connection.execute(
            "UPDATE sync_profiles SET last_sync_at = ? WHERE id = ?",
            (utc_now(), row["profile_id"]),
        )

    def fail(
        self,
        queue_id: int,
        error: str,
        *,
        base_delay: float = 5.0,
        max_delay: float = 3600.0,
        max_attempts: int = 8,
    ) -> dict[str, Any]:
        row = self._require(queue_id)
        attempts = int(row["attempts"]) + 1
        delay = min(max_delay, base_delay * (2 ** (attempts - 1)))
        state = "failed" if attempts >= max_attempts else "queued"
        self.connection.execute(
            """
            UPDATE sync_queue
               SET attempts = ?, last_error = ?, state = ?, next_attempt_at = ?
             WHERE id = ?
            """,
            (attempts, error[:2000], state, utc_now(delay), queue_id),
        )
        self.connection.execute(
            """
            UPDATE sync_metadata SET state = 'error', error_message = ?
             WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
            """,
            (error[:2000], row["profile_id"], row["entity_type"], row["entity_id"]),
        )
        return {"attempts": attempts, "delaySeconds": delay, "state": state}

    def retry(self, queue_id: int) -> None:
        self.connection.execute(
            "UPDATE sync_queue SET state = 'queued', next_attempt_at = ? WHERE id = ?",
            (utc_now(), queue_id),
        )

    # -------------------------------------------------------------- resolution
    def record_remote_revision(
        self,
        profile_id: int,
        entity_type: str,
        entity_id: str,
        *,
        remote_revision: int,
        remote_etag: str = "",
        remote_updated_at: str | None = None,
    ) -> str:
        """Compare a remote revision with local state and return the decision."""
        row = self.connection.execute(
            """
            SELECT local_revision, remote_revision, state FROM sync_metadata
             WHERE profile_id = ? AND entity_type = ? AND entity_id = ?
            """,
            (profile_id, entity_type, entity_id),
        ).fetchone()
        local_revision = int(row["local_revision"]) if row else 0
        previous_remote = int(row["remote_revision"] or 0) if row else 0
        local_dirty = row is not None and row["state"] in ("pending", "error")

        if remote_revision > previous_remote and local_dirty:
            decision = "conflict"
        elif remote_revision > previous_remote:
            decision = "fast_forward"
        else:
            decision = "local_wins"

        state = {"conflict": "conflict", "fast_forward": "synced", "local_wins": "pending"}[decision]
        self.connection.execute(
            """
            INSERT INTO sync_metadata (
                profile_id, entity_type, entity_id, remote_revision, remote_etag,
                remote_updated_at, state, last_synced_at
            ) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT (profile_id, entity_type, entity_id) DO UPDATE SET
                remote_revision = excluded.remote_revision,
                remote_etag = excluded.remote_etag,
                remote_updated_at = excluded.remote_updated_at,
                state = excluded.state,
                last_synced_at = excluded.last_synced_at
            """,
            (
                profile_id,
                entity_type,
                entity_id,
                remote_revision,
                remote_etag,
                remote_updated_at,
                state,
                utc_now() if state == "synced" else None,
            ),
        )
        if decision == "local_wins":
            self.enqueue(profile_id, entity_type, entity_id, "push")
        return decision

    def tombstone(self, profile_id: int, entity_type: str, entity_id: str) -> None:
        self.connection.execute(
            """
            INSERT INTO sync_tombstones (profile_id, entity_type, entity_id) VALUES (?,?,?)
            ON CONFLICT (profile_id, entity_type, entity_id) DO NOTHING
            """,
            (profile_id, entity_type, entity_id),
        )

    def is_tombstoned(self, profile_id: int, entity_type: str, entity_id: str) -> bool:
        return (
            self.connection.execute(
                "SELECT 1 FROM sync_tombstones WHERE profile_id = ? AND entity_type = ? AND entity_id = ?",
                (profile_id, entity_type, entity_id),
            ).fetchone()
            is not None
        )

    # ------------------------------------------------------------------ status
    def pending_count(self, profile_id: int | None = None) -> int:
        if profile_id is None:
            row = self.connection.execute(
                "SELECT COUNT(*) FROM sync_queue WHERE state IN ('queued','inflight')"
            ).fetchone()
        else:
            row = self.connection.execute(
                "SELECT COUNT(*) FROM sync_queue WHERE profile_id = ? AND state IN ('queued','inflight')",
                (profile_id,),
            ).fetchone()
        return int(row[0])

    def status(self, profile_id: int) -> dict[str, Any]:
        rows = self.connection.execute(
            "SELECT state, COUNT(*) AS count FROM sync_queue WHERE profile_id = ? GROUP BY state",
            (profile_id,),
        ).fetchall()
        conflicts = self.connection.execute(
            "SELECT COUNT(*) FROM sync_metadata WHERE profile_id = ? AND state = 'conflict'",
            (profile_id,),
        ).fetchone()[0]
        return {
            "queue": {row["state"]: int(row["count"]) for row in rows},
            "conflicts": int(conflicts),
            "lastSyncAt": (
                self.connection.execute(
                    "SELECT last_sync_at FROM sync_profiles WHERE id = ?", (profile_id,)
                ).fetchone()[0]
            ),
        }

    def _require(self, queue_id: int) -> sqlite3.Row:
        row = self.connection.execute(
            "SELECT * FROM sync_queue WHERE id = ?", (queue_id,)
        ).fetchone()
        if row is None:
            raise SyncError(f"queue item {queue_id} not found")
        return row


__all__ = ["ENTITY_TYPES", "OPERATIONS", "SyncError", "SyncQueue", "file_hash", "utc_now"]
