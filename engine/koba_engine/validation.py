"""Authoritative map check, run before export and from the validation step.

The wizard validates its draft in TypeScript, but what ships is the exported
document. This module samples the same procedural terrain the exporter writes,
so floated or buried prefabs, overlapping footprints, orphaned splines and an
unwired IO graph are caught against the real numbers rather than an estimate.

Findings mirror ``ValidationIssue`` in
``apps/studio-ui/src/wizard/types.ts``: ``id``/``code``, ``severity``,
``message``, optional ``detail`` and a world ``position``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .procedural import TerrainSettings, sample_heightfield
from .world.map_file import validate_layout
from .world.models import WorldDocument, height_raw_to_metres
from .world.terrain import decode_u16, square_resolution

# A prefab sink deeper than this below the terrain surface is buried.
BURIED_METRES = 1.5
# Standing this far above the surface means the pad never took.
FLOATING_METRES = 4.0
# Share of the smaller footprint that must overlap before it is reported.
OVERLAP_SHARE = 0.35
# Prefab count beyond which client frame time usually starts to suffer.
PREFAB_BUDGET = 2600

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass(slots=True)
class Finding:
    code: str
    severity: str
    message: str
    detail: str = ""
    placement_id: str = ""
    position: tuple[float, float, float] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.code,
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
        }
        if self.detail:
            payload["detail"] = self.detail
        if self.placement_id:
            payload["placementId"] = self.placement_id
        if self.position is not None:
            payload["position"] = [round(value, 2) for value in self.position]
        return payload


class TerrainSampler:
    """Metre-space height lookup over the square terrain.

    Placement coordinates are centred on the origin while the height grid starts
    at its north-west corner, so a world point maps to ``x + size / 2``.

    The sampler never regenerates the map. Given a document it reads the exported
    height layer; otherwise it asks the procedural generator for the coarse
    lattice the exported surface is interpolated from (257² instead of 4501²).
    """

    LATTICE = 257

    def __init__(
        self,
        settings: TerrainSettings,
        document: WorldDocument | None = None,
    ) -> None:
        self.size = float(settings.size_metres)
        self.water_level = float(settings.water_level)
        exported = document.layers.get("terrain") if document is not None else None
        if exported:
            resolution = square_resolution(exported, 2)
            self.resolution = max(2, resolution)
            self._heights = [
                height_raw_to_metres(value) for value in decode_u16(exported)
            ]
        else:
            self.resolution = self.LATTICE
            self._heights = sample_heightfield(settings, self.LATTICE)
        self._step = self.size / max(1, self.resolution - 1)

    def height_at(self, x: float, z: float) -> float:
        gx = (x + self.size / 2.0) / self._step
        gz = (z + self.size / 2.0) / self._step
        gx = min(max(gx, 0.0), self.resolution - 1.0)
        gz = min(max(gz, 0.0), self.resolution - 1.0)
        x0, z0 = int(gx), int(gz)
        x1 = min(x0 + 1, self.resolution - 1)
        z1 = min(z0 + 1, self.resolution - 1)
        tx, tz = gx - x0, gz - z0
        h00 = self._heights[z0 * self.resolution + x0]
        h10 = self._heights[z0 * self.resolution + x1]
        h01 = self._heights[z1 * self.resolution + x0]
        h11 = self._heights[z1 * self.resolution + x1]
        top = h00 + (h10 - h00) * tx
        bottom = h01 + (h11 - h01) * tx
        return top + (bottom - top) * tz


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _vec(value: Any) -> tuple[float, float, float]:
    if not isinstance(value, dict):
        return (0.0, 0.0, 0.0)
    return (
        _number(value.get("x")),
        _number(value.get("y")),
        _number(value.get("z")),
    )


def _footprint(placement: dict[str, Any]) -> tuple[float, float]:
    scale = _vec(placement.get("scale") or {"x": 1, "y": 1, "z": 1})
    radius = max(0.5, _number(placement.get("collisionRadius"), 2.0))
    height = max(0.5, _number(placement.get("collisionHeight"), radius))
    return (radius * abs(scale[0] or 1.0), height * abs(scale[1] or 1.0))


def _overlaps(
    placements: Iterable[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any], float]]:
    """Spatial-hash footprint overlaps, so a 2600-prefab map stays linear."""

    entries: list[tuple[float, float, float, float, dict[str, Any]]] = []
    for placement in placements:
        x, y, z = _vec(placement.get("position"))
        radius, height = _footprint(placement)
        entries.append((x, z, radius, height, placement))

    largest = max((entry[2] for entry in entries), default=1.0)
    cell = max(8.0, largest * 2.0)
    buckets: dict[tuple[int, int], list[int]] = {}
    for index, (x, z, _radius, _height, _placement) in enumerate(entries):
        buckets.setdefault((int(x // cell), int(z // cell)), []).append(index)

    found: list[tuple[dict[str, Any], dict[str, Any], float]] = []
    for index, (x, z, radius, _height, placement) in enumerate(entries):
        cx, cz = int(x // cell), int(z // cell)
        for ox in (-1, 0, 1):
            for oz in (-1, 0, 1):
                for other in buckets.get((cx + ox, cz + oz), ()):
                    if other <= index:
                        continue
                    ax, az, aradius, _h, aplacement = entries[other]
                    dx, dz = ax - x, az - z
                    gap = (radius + aradius) - (dx * dx + dz * dz) ** 0.5
                    if gap <= 0:
                        continue
                    smaller = min(radius, aradius) or 1.0
                    share = min(1.0, gap / (2 * smaller))
                    if share >= OVERLAP_SHARE:
                        found.append((placement, aplacement, share))
    return found


def map_check(
    draft: dict[str, Any],
    *,
    document: WorldDocument | None = None,
) -> dict[str, Any]:
    """Run every engine map check and return findings plus severity counts."""

    if not isinstance(draft, dict):
        raise TypeError("draft must be an object")

    terrain = draft.get("terrain") or {}
    placements = [item for item in (draft.get("placements") or []) if isinstance(item, dict)]
    splines = [item for item in (draft.get("splines") or []) if isinstance(item, dict)]
    loot = draft.get("loot") or {}
    io_graph = draft.get("io") or {}
    findings: list[Finding] = []

    sampler: TerrainSampler | None = None
    if terrain:
        try:
            sampler = TerrainSampler(TerrainSettings.from_dict(terrain), document)
        except (ValueError, KeyError, TypeError):
            sampler = None

    half = sampler.size / 2.0 if sampler else 0.0

    for placement in placements:
        label = str(placement.get("name") or placement.get("assetId") or "prefab")
        placement_id = str(placement.get("id") or "")
        x, y, z = _vec(placement.get("position"))
        radius, height = _footprint(placement)

        if half and (abs(x) > half or abs(z) > half):
            findings.append(
                Finding(
                    "prefab-outside-map",
                    "error",
                    f"{label} sits outside the square world",
                    "Placements must stay within the exported map bounds.",
                    placement_id,
                    (x, y, z),
                )
            )
            continue

        if not sampler:
            continue

        ground = sampler.height_at(x, z)
        base, top = y, y + height
        if top < ground - BURIED_METRES:
            findings.append(
                Finding(
                    "prefab-buried",
                    "error",
                    f"{label} is buried {ground - top:.1f} m under the terrain",
                    "Raise it or flatten the pad before exporting.",
                    placement_id,
                    (x, ground, z),
                )
            )
        elif base > ground + FLOATING_METRES:
            findings.append(
                Finding(
                    "prefab-floating",
                    "warning",
                    f"{label} floats {base - ground:.1f} m above the terrain",
                    "Enable auto-flatten or lower the placement.",
                    placement_id,
                    (x, ground, z),
                )
            )
        if ground < sampler.water_level - 1.0 and base < sampler.water_level:
            findings.append(
                Finding(
                    "prefab-underwater",
                    "info",
                    f"{label} stands below sea level",
                    "Expected for docks and offshore monuments; otherwise move it inland.",
                    placement_id,
                    (x, base, z),
                )
            )

    for first, second, share in _overlaps(placements):
        first_label = str(first.get("name") or "prefab")
        second_label = str(second.get("name") or "prefab")
        x, y, z = _vec(first.get("position"))
        findings.append(
            Finding(
                "prefab-overlap",
                "warning",
                f"{first_label} overlaps {second_label} by {share * 100:.0f}%",
                "Overlapping colliders block players and duplicate draw calls.",
                str(first.get("id") or ""),
                (x, y, z),
            )
        )

    for spline in splines:
        nodes = [node for node in (spline.get("nodes") or []) if isinstance(node, dict)]
        label = str(spline.get("name") or spline.get("kind") or "spline")
        if len(nodes) < 2:
            findings.append(
                Finding(
                    "spline-insufficient-nodes",
                    "warning",
                    f"{label} needs at least two nodes",
                    "A one-node spline exports no geometry.",
                    str(spline.get("id") or ""),
                )
            )
            continue
        if _number(spline.get("width"), 0.0) <= 0:
            findings.append(
                Finding(
                    "spline-zero-width",
                    "error",
                    f"{label} has no width",
                    "Roads, rails and rivers need a positive corridor width.",
                    str(spline.get("id") or ""),
                )
            )
        if half:
            for node in nodes:
                x, y, z = _vec(node)
                if abs(x) > half or abs(z) > half:
                    findings.append(
                        Finding(
                            "spline-outside-map",
                            "warning",
                            f"{label} leaves the square world",
                            "The clipped segment will not reach the terrain edge.",
                            str(spline.get("id") or ""),
                            (x, y, z),
                        )
                    )
                    break

    vending = int(_number(loot.get("vendingMachines"), 0))
    links = io_graph.get("links") or []
    if vending > 0 and not links:
        findings.append(
            Finding(
                "io-not-wired",
                "info",
                f"{vending} vending machines are not wired to a power circuit",
                "Wire the IO graph so card readers and switches reach them.",
            )
        )

    if placements and int(_number(loot.get("crateCount"), 0)) == 0:
        findings.append(
            Finding(
                "loot-empty",
                "info",
                "No loot crates are configured",
                "Monuments without crates give players nothing to find.",
            )
        )

    if len(placements) > PREFAB_BUDGET:
        findings.append(
            Finding(
                "prefab-budget",
                "warning",
                f"{len(placements)} prefabs exceeds the {PREFAB_BUDGET} budget",
                "Client frame time and memory grow with placed prefabs.",
            )
        )

    if document is not None:
        for issue in validate_layout(document):
            findings.append(
                Finding(
                    "layer-layout",
                    str(issue.get("severity") or "warning"),
                    str(issue.get("message") or "terrain layer mismatch"),
                    f"layer: {issue.get('layer', 'unknown')}",
                )
            )

    if not placements and str(draft.get("projectKind") or "map") != "skin":
        findings.append(
            Finding(
                "empty-map",
                "warning",
                "The map has no placed prefabs",
                "Add monuments or spawns before exporting a playable map.",
            )
        )

    findings.sort(key=lambda item: (SEVERITY_ORDER.get(item.severity, 9), item.code))
    counts = {"error": 0, "warning": 0, "info": 0}
    for finding in findings:
        counts[finding.severity] = counts.get(finding.severity, 0) + 1
    return {
        "ok": counts["error"] == 0,
        "projectKind": str(draft.get("projectKind") or "map"),
        "counts": counts,
        "findings": [finding.to_dict() for finding in findings],
    }


def format_report(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    lines = [
        f"map check: {counts.get('error', 0)} error(s), "
        f"{counts.get('warning', 0)} warning(s), {counts.get('info', 0)} note(s)"
    ]
    for finding in report.get("findings") or []:
        lines.append(f"  [{finding.get('severity')}] {finding.get('message')}")
    if not report.get("findings"):
        lines.append("  no issues found")
    return "\n".join(lines)
