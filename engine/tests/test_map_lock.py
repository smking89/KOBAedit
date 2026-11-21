import pytest

from koba_engine.map_lock import (
    LOCK_FORMAT,
    LOCK_LAYER,
    create_map_lock,
    unlock_map_lock,
    verify_map_lock,
)


def test_map_lock_round_trip_hides_password_and_payload():
    lock = create_map_lock("hunter2-secret", {"project": "Hidden Outpost"})
    assert lock["format"] == LOCK_FORMAT
    assert LOCK_LAYER == "koba.lock"
    assert "hunter2-secret" not in str(lock)
    assert "Hidden Outpost" not in str(lock)
    assert verify_map_lock(lock, "hunter2-secret")
    assert not verify_map_lock(lock, "wrong-password")
    assert unlock_map_lock(lock, "hunter2-secret")["project"] == "Hidden Outpost"


def test_map_lock_rejects_short_password_and_tampering():
    with pytest.raises(ValueError):
        create_map_lock("short")
    lock = create_map_lock("long-enough")
    lock["ciphertext"] = "AAAA"
    with pytest.raises(ValueError):
        unlock_map_lock(lock, "long-enough")
