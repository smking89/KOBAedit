"""Offline, password-protected map lock envelopes.

The vanilla Rust ``.map`` format has no password field. KOBA stores a lock
record in a private metadata layer and a sidecar so the editor can refuse to
open or re-export a protected project without the creator's password. The
server-facing terrain and prefab data remains a normal map.

Only Python's standard library is used: PBKDF2-HMAC-SHA256 derives a key, an
HMAC-SHA256 counter stream encrypts the JSON payload, and an encrypt-then-MAC
tag authenticates it. No password or plaintext project data is written.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

LOCK_FORMAT = "koba-map-lock/1"
LOCK_LAYER = "koba.lock"
ITERATIONS = 120_000
SALT_BYTES = 16
NONCE_BYTES = 16


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"))


def _derive(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < length:
        block = hashlib.sha256(key + nonce + counter.to_bytes(8, "little")).digest()
        output.extend(block)
        counter += 1
    return bytes(output[:length])


def _xor(data: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, stream))


def create_map_lock(password: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a lock record. The password must never be stored in the result."""
    if len(password) < 6:
        raise ValueError("map lock password must be at least 6 characters")
    salt = os.urandom(SALT_BYTES)
    nonce = os.urandom(NONCE_BYTES)
    key = _derive(password, salt, ITERATIONS)
    body = json.dumps(
        payload
        or {
            "project": "KOBA Studios protected map",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    ciphertext = _xor(body, _keystream(key, nonce, len(body)))
    tag = hmac.new(key, nonce + ciphertext, hashlib.sha256).digest()
    verifier = hmac.new(key, b"koba-map-lock-verify", hashlib.sha256).hexdigest()
    return {
        "format": LOCK_FORMAT,
        "iterations": ITERATIONS,
        "salt": _b64(salt),
        "nonce": _b64(nonce),
        "ciphertext": _b64(ciphertext),
        "tag": _b64(tag),
        "verifier": verifier,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _key_from_lock(lock: dict[str, Any], password: str) -> bytes:
    if lock.get("format") != LOCK_FORMAT:
        raise ValueError("not a KOBA map lock record")
    iterations = int(lock.get("iterations") or ITERATIONS)
    if iterations < 10_000 or iterations > 2_000_000:
        raise ValueError("map lock iteration count is out of range")
    salt = _unb64(str(lock.get("salt") or ""))
    if len(salt) < 8:
        raise ValueError("map lock salt is invalid")
    return _derive(password, salt, iterations)


def verify_map_lock(lock: dict[str, Any], password: str) -> bool:
    try:
        key = _key_from_lock(lock, password)
    except (ValueError, TypeError):
        return False
    expected = hmac.new(key, b"koba-map-lock-verify", hashlib.sha256).hexdigest()
    supplied = str(lock.get("verifier") or "")
    return hmac.compare_digest(expected, supplied)


def unlock_map_lock(lock: dict[str, Any], password: str) -> dict[str, Any]:
    """Verify and decrypt a lock record, raising ValueError on any mismatch."""
    if not verify_map_lock(lock, password):
        raise ValueError("map password is incorrect")
    key = _key_from_lock(lock, password)
    nonce = _unb64(str(lock.get("nonce") or ""))
    ciphertext = _unb64(str(lock.get("ciphertext") or ""))
    tag = _unb64(str(lock.get("tag") or ""))
    expected = hmac.new(key, nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise ValueError("map lock payload failed authentication")
    body = _xor(ciphertext, _keystream(key, nonce, len(ciphertext)))
    return json.loads(body.decode("utf-8"))


__all__ = [
    "LOCK_FORMAT",
    "LOCK_LAYER",
    "create_map_lock",
    "unlock_map_lock",
    "verify_map_lock",
]
