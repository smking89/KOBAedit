"""Tiny JSON-lines progress channel for long headless engine jobs.

The desktop shell starts Python with ``--progress <file>`` and polls the file
while the child runs. Each line is a complete JSON object so a partially
written last line can simply be ignored.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


class ProgressWriter:
    def __init__(self, path: str | Path | None) -> None:
        self.path = Path(path).expanduser() if path else None
        self._handle = None
        self._lock = threading.Lock()
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = self.path.open("a", encoding="utf-8")

    def __call__(
        self,
        stage: str,
        current: int = 0,
        total: int = 0,
        message: str = "",
    ) -> None:
        if self._handle is None:
            return
        payload: dict[str, Any] = {
            "stage": stage,
            "current": int(current),
            "total": int(total),
            "message": message,
        }
        with self._lock:
            self._handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._handle.flush()

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None

    def __enter__(self) -> "ProgressWriter":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def read_progress(path: str | Path, limit: int = 40) -> list[dict[str, Any]]:
    """Return the most recent valid progress records."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()[-limit:]
    except OSError:
        return []
    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


__all__ = ["ProgressWriter", "read_progress"]
