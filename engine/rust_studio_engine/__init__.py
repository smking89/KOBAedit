"""Rust Studio engine.

Pure-Python, offline-first implementation of the pieces that cannot live in the
browser: WorldSerialization (``.map`` / ``.prefab``) I/O, terrain and brush math,
spline extrusion, texture channel packing, the SQLite asset index and the
background sync outbox.

The Tauri shell talks to this package through :mod:`rust_studio_engine.app`
(local HTTP/IPC sidecar) or directly through the ``rust-studio-engine`` CLI.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
