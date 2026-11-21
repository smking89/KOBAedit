"""Local HTTP sidecar for the Tauri shell.

The shell prefers calling Rust directly for map I/O. This sidecar covers the
long-running Python work (asset ingestion, thumbnail batches, texture export and
the sync drain) so the UI stays responsive.

Bind to loopback only. If ``STUDIO_SIDECAR_TOKEN`` is set, every request must
carry it as ``X-Studio-Token``; the Tauri shell generates a random token per run
and passes it to the child process.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Header
from pydantic import BaseModel, Field

from . import __version__
from .indexer.db import connect, database_stats, default_db_path
from .indexer.indexer import AssetIndexer
from .indexer.mesh_probe import MeshProbeError
from .sync.queue import SyncError, SyncQueue
from .world.lz4_legacy import is_lz4_block_available
from .world.map_file import MapFormatError, inspect_file
from .world.terrain import HeightField, TerrainError, paint_splat, splat_planes, store_splat

class IngestRequest(BaseModel):
    root: str = Field(..., description="Absolute path to a Rust install or custom asset pack")
    packName: str | None = None
    gameVersion: str = ""
    source: Literal["local", "workshop", "synced"] = "local"
    makeThumbnails: bool = True
    force: bool = False
    manifestPath: str | None = None


class PaintSplatRequest(BaseModel):
    mapPath: str
    x: float
    z: float
    radius: float
    channel: int = Field(..., ge=0, le=7)
    strength: float = 1.0
    savePath: str | None = None


class EnqueueRequest(BaseModel):
    entityType: Literal["project", "asset_pack", "asset"]
    entityId: str
    operation: Literal["push", "pull", "delete"] = "push"
    payloadPath: str | None = None


def create_app(
    db_path: str | Path | None = None,
    thumbnail_dir: str | Path | None = None,
) -> FastAPI:
    database = Path(db_path) if db_path else default_db_path()
    thumbnails = Path(thumbnail_dir) if thumbnail_dir else database.parent / "thumbnails"
    app = FastAPI(title="Rust Studio Engine", version=__version__)

    def authorize(x_studio_token: str | None = Header(default=None)) -> None:
        expected = os.environ.get("STUDIO_SIDECAR_TOKEN")
        if expected and x_studio_token != expected:
            raise HTTPException(status_code=401, detail="invalid sidecar token")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "database": str(database),
            "nativeLz4": is_lz4_block_available(),
        }

    @app.get("/index/stats", dependencies=[Depends(authorize)])
    def index_stats() -> dict[str, Any]:
        with connect(database) as connection:
            return {"database": str(database), **database_stats(connection)}

    @app.post("/index/ingest", dependencies=[Depends(authorize)])
    async def ingest(request: IngestRequest) -> dict[str, Any]:
        if not Path(request.root).exists():
            raise HTTPException(status_code=400, detail=f"root does not exist: {request.root}")

        def run() -> dict[str, Any]:
            with AssetIndexer(database, thumbnails) as indexer:
                report = indexer.ingest(
                    request.root,
                    pack_name=request.packName,
                    game_version=request.gameVersion,
                    source=request.source,
                    make_thumbnails=request.makeThumbnails,
                    force=request.force,
                    manifest_path=request.manifestPath,
                )
                return report.to_dict()

        return await asyncio.to_thread(run)

    @app.get("/map/inspect", dependencies=[Depends(authorize)])
    def map_inspect(path: str) -> dict[str, Any]:
        try:
            return inspect_file(path)
        except MapFormatError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/terrain/paint-splat", dependencies=[Depends(authorize)])
    def paint(request: PaintSplatRequest) -> dict[str, Any]:
        from .world.map_file import read_document, write_document

        try:
            document = read_document(request.mapPath)
            planes = splat_planes(document)
            resolution = int(round(len(planes[0]) ** 0.5))
            touched = paint_splat(
                planes,
                resolution,
                float(document.size),
                request.x,
                request.z,
                request.radius,
                request.channel,
                request.strength,
            )
            store_splat(document, planes)
            target = request.savePath or request.mapPath
            write_document(target, document)
            return {"touched": touched, "savedTo": target}
        except (MapFormatError, TerrainError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/assets/search", dependencies=[Depends(authorize)])
    def search(q: str, limit: int = 50) -> dict[str, Any]:
        with connect(database) as connection:
            rows = connection.execute(
                """
                SELECT entity_type, entity_id, name, asset_path
                  FROM asset_search WHERE asset_search MATCH ?
                 ORDER BY rank LIMIT ?
                """,
                (f"{q}*", min(limit, 200)),
            ).fetchall()
            return {"query": q, "results": [dict(row) for row in rows]}

    @app.get("/sync/status", dependencies=[Depends(authorize)])
    def sync_status() -> dict[str, Any]:
        with connect(database) as connection:
            queue = SyncQueue(connection)
            profile = queue.active_profile()
            if profile is None:
                return {"active": False, "queue": {}, "pending": 0}
            return {
                "active": True,
                "profile": profile["name"],
                "pending": queue.pending_count(int(profile["id"])),
                **queue.status(int(profile["id"])),
            }

    @app.post("/sync/enqueue", dependencies=[Depends(authorize)])
    def sync_enqueue(request: EnqueueRequest) -> dict[str, Any]:
        with connect(database) as connection:
            queue = SyncQueue(connection)
            profile = queue.active_profile()
            if profile is None:
                raise HTTPException(status_code=409, detail="no active sync profile")
            try:
                queue_id = queue.enqueue(
                    int(profile["id"]),
                    request.entityType,
                    request.entityId,
                    request.operation,
                    payload_path=request.payloadPath,
                )
                return {"queued": queue_id}
            except SyncError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/textures/validate", dependencies=[Depends(authorize)])
    def validate_textures(paths: list[str]) -> dict[str, Any]:
        from .texture import inspect_png

        results = []
        for path in paths:
            try:
                results.append(inspect_png(path))
            except (OSError, ValueError) as exc:
                results.append({"path": path, "valid": False, "error": str(exc)})
        return {"textures": results}

    @app.get("/terrain/height", dependencies=[Depends(authorize)])
    def terrain_height(path: str, x: float, z: float) -> dict[str, Any]:
        from .world.map_file import read_document

        try:
            document = read_document(path)
            field = HeightField.from_document(document)
            return {"heightMetres": field.sample(x, z), "resolution": field.resolution}
        except (MapFormatError, TerrainError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app


app = create_app()

__all__ = ["app", "create_app"]
