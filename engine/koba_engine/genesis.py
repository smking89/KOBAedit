"""GENESIS 72-hour wipe economy simulation.

Before a wipe goes live the studio can predict how fast players earn scrap, which
monument becomes a choke point, and where progression stalls. The model is
deliberately deterministic and transparent rather than clever:

* each monument earns at a rate set by its loot tier and the current progression
  phase (tier 1 first, tier 2 at hour 6, tier 3 at hour 18);
* players choose monuments by attractiveness, discounted by travel distance, and
  crowd each other down with a diminishing-returns curve;
* every hour is simulated, so a bottleneck shows up as a flat stretch of the
  scrap-per-player curve rather than as a guess.

The output is JSON: hourly totals, per-monument steady state, findings, and
concrete loot adjustments the wizard can apply with one click.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import exp
from random import Random
from typing import Any

# Scrap a single player earns per hour at a monument of that tier.
TIER_RATE = {1: 60.0, 2: 120.0, 3: 220.0}
# Concurrent players a monument serves without contention. Past twice that many
# the site is contested and income per visitor drops.
TIER_CAPACITY = {1: 14.0, 2: 9.0, 3: 5.0}
CONTESTED_SHARE = 0.45
EARLY_STARVED_PER_HOUR = 45.0
PHASE_SWITCH = ((6, 2), (18, 3))
MIN_PLAYERS, MAX_PLAYERS = 50, 300
DEFAULT_HOURS = 72


@dataclass(slots=True)
class MonumentModel:
    name: str
    tier: int
    distance: float
    attractiveness: float = 0.0
    visits: list[float] = field(default_factory=list)
    income: list[float] = field(default_factory=list)


def _number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _vec(value: Any) -> tuple[float, float]:
    if not isinstance(value, dict):
        return (0.0, 0.0)
    return (_number(value.get("x"), 0.0), _number(value.get("z"), 0.0))


def _phase_weights(hour: int) -> dict[int, float]:
    unlocked = 1
    for switch_hour, tier in PHASE_SWITCH:
        if hour >= switch_hour:
            unlocked = tier
    weights = {1: 1.0, 2: 0.0, 3: 0.0}
    for tier in range(2, unlocked + 1):
        weights[tier] = 1.0
        # Intermediate tiers still earn while the next one has just opened.
        weights[tier - 1] = max(weights[tier - 1], 0.45)
    return weights


def _online_players(hour: int, players: int) -> float:
    if hour < 3:
        return players * (0.35 + 0.65 * hour / 3.0)
    # Mild daily rhythm so the curve is not a straight line.
    return players * (0.78 + 0.22 * (0.5 + 0.5 * (hour % 24) / 24.0))


def simulate(
    draft: dict[str, Any],
    *,
    players: int = 120,
    hours: int = DEFAULT_HOURS,
    seed: int = 1337,
) -> dict[str, Any]:
    """Run the wipe simulation for ``draft`` and return the report."""

    if not isinstance(draft, dict):
        raise TypeError("draft must be an object")
    players = int(max(MIN_PLAYERS, min(MAX_PLAYERS, players)))
    hours = int(max(24, min(168, hours)))

    terrain = draft.get("terrain") or {}
    loot = draft.get("loot") or {}
    placements = [item for item in (draft.get("placements") or []) if isinstance(item, dict)]

    size = max(500.0, _number(terrain.get("sizeMetres", terrain.get("size_metres")), 4000.0))
    half_diagonal = size * 0.7071

    monuments: list[MonumentModel] = []
    for placement in placements:
        x, z = _vec(placement.get("position"))
        distance = min(1.0, ((x * x + z * z) ** 0.5) / max(1.0, half_diagonal))
        tier = int(_number(placement.get("lootTier"), 1))
        tier = max(1, min(3, tier))
        monuments.append(
            MonumentModel(
                name=str(placement.get("name") or placement.get("assetId") or "prefab"),
                tier=tier,
                distance=distance,
                visits=[0.0] * hours,
                income=[0.0] * hours,
            )
        )

    if not monuments:
        return {
            "ok": False,
            "players": players,
            "hours": hours,
            "hourlyScrap": [],
            "perMonument": [],
            "findings": [
                {
                    "code": "no-monuments",
                    "severity": "error",
                    "message": "No monuments are placed, so GENESIS has nothing to simulate",
                }
            ],
            "suggestions": [],
            "summary": {"totalScrap": 0.0, "peakHour": 0, "scrapPerPlayerPerHour": 0.0},
        }

    density = max(0.25, _number(loot.get("lootDensity"), 1.0))
    rng = Random(seed)
    hourly_total: list[float] = []
    hourly_per_player: list[float] = []

    for hour in range(hours):
        weights = _phase_weights(hour)
        online = _online_players(hour, players)
        for monument in monuments:
            phase = weights.get(monument.tier, 0.0)
            # Jitter keeps every monument from being identical, deterministically.
            jitter = 0.9 + 0.2 * rng.random()
            monument.attractiveness = (
                TIER_RATE[monument.tier]
                * phase
                * (1.0 - 0.55 * monument.distance)
                * jitter
            )
        pool = sum(item.attractiveness for item in monuments) or 1.0
        total = 0.0
        for monument in monuments:
            visits = online * monument.attractiveness / pool
            supported = TIER_CAPACITY[monument.tier] * 2.0
            effective = min(visits, supported) + CONTESTED_SHARE * max(0.0, visits - supported)
            income = effective * TIER_RATE[monument.tier] * density
            monument.visits[hour] = visits
            monument.income[hour] = income
            total += income
        hourly_total.append(total)
        hourly_per_player.append(total / online if online else 0.0)

    steady_from = max(0, hours - 24)
    per_monument = []
    for monument in monuments:
        window = monument.income[steady_from:]
        per_monument.append(
            {
                "name": monument.name,
                "tier": monument.tier,
                "distanceShare": round(monument.distance, 3),
                "scrapPerHour": round(sum(window) / max(1, len(window)), 1),
                "visitsPerHour": round(sum(monument.visits[steady_from:]) / max(1, len(window)), 1),
            }
        )
    total_scrap = sum(hourly_total)
    share_per_monument = {
        item["name"]: item["scrapPerHour"]
        for item in sorted(per_monument, key=lambda item: item["scrapPerHour"], reverse=True)
    }
    top_name = next(iter(share_per_monument), "")
    top_share = (
        share_per_monument[top_name] / total_scrap * hours
        if total_scrap and top_name
        else 0.0
    )

    findings: list[dict[str, Any]] = []
    suggestions: list[dict[str, Any]] = []

    early = sum(hourly_per_player[:6]) / 6.0
    if early < EARLY_STARVED_PER_HOUR:
        findings.append(
            {
                "code": "early-game-starved",
                "severity": "warning",
                "message": f"Players average {early:.0f} scrap/hour in the first six hours",
                "detail": "Fresh spawns cannot reach a first workbench tier without grinding barrels.",
            }
        )
        suggestions.append(
            {
                "field": "loot.crateCount",
                "from": int(_number(loot.get("crateCount"), 0)),
                "to": int(_number(loot.get("crateCount"), 0)) + 24,
                "reason": "More tier 1 crates lift the opening hours without touching late-game loot.",
            }
        )

    if top_share > 0.55:
        findings.append(
            {
                "code": "monument-hog",
                "severity": "warning",
                "message": f"{top_name} produces {top_share * 100:.0f}% of all scrap",
                "detail": "One monument being the only worthwhile stop flattens the map into a single chokepoint.",
            }
        )
        suggestions.append(
            {
                "field": "loot.lootDensity",
                "from": round(density, 2),
                "to": round(max(0.25, density - 0.15), 2),
                "reason": f"Lower density spreads income away from {top_name}.",
            }
        )

    tier3_hour = next(
        (index for index, total in enumerate(hourly_total) if total >= hourly_total[-1] * 0.9),
        hours,
    )
    if tier3_hour >= hours - 6:
        findings.append(
            {
                "code": "slow-progression",
                "severity": "info",
                "message": "Scrap output only nears its ceiling in the final hours",
                "detail": "Wipes on this map will feel slow; consider opening tier 3 earlier.",
            }
        )

    if len(monuments) < 6 and players > 100:
        findings.append(
            {
                "code": "low-monument-count",
                "severity": "warning",
                "message": f"{len(monuments)} monuments for {players} players is thin",
                "detail": "Under six monuments the crowd penalty dominates every raid route.",
            }
        )

    if int(_number(loot.get("crateCount"), 0)) == 0 and placements:
        findings.append(
            {
                "code": "no-crates",
                "severity": "error",
                "message": "The loot table has no crates configured",
            }
        )

    peak_hour = max(range(len(hourly_total)), key=lambda index: hourly_total[index]) if hourly_total else 0
    return {
        "ok": not any(item["severity"] == "error" for item in findings),
        "players": players,
        "hours": hours,
        "hourlyScrap": [round(value, 1) for value in hourly_total],
        "hourlyPerPlayer": [round(value, 1) for value in hourly_per_player],
        "perMonument": per_monument,
        "findings": findings,
        "suggestions": suggestions,
        "summary": {
            "totalScrap": round(total_scrap, 1),
            "peakHour": peak_hour,
            "peakScrapPerHour": round(hourly_total[peak_hour], 1) if hourly_total else 0.0,
            "scrapPerPlayerPerHour": round(
                total_scrap / max(1, players) / max(1, hours), 1
            ),
            "topMonument": top_name,
            "topMonumentShare": round(min(1.0, top_share), 3),
            "tier3SaturationHour": tier3_hour,
        },
    }


def format_report(report: dict[str, Any]) -> str:
    summary = report.get("summary") or {}
    lines = [
        f"GENESIS: {report.get('players')} players x {report.get('hours')} h -> "
        f"{summary.get('totalScrap', 0):,.0f} scrap, "
        f"{summary.get('scrapPerPlayerPerHour', 0):,.0f} scrap/player/hour"
    ]
    top = summary.get("topMonument")
    if top:
        lines.append(
            f"  top monument: {top} ({summary.get('topMonumentShare', 0) * 100:.0f}% of income)"
        )
    for finding in report.get("findings") or []:
        lines.append(f"  [{finding.get('severity')}] {finding.get('message')}")
    for suggestion in report.get("suggestions") or []:
        lines.append(
            f"  tune {suggestion.get('field')}: {suggestion.get('from')} -> {suggestion.get('to')}"
        )
    if not report.get("findings"):
        lines.append("  no bottlenecks found")
    return "\n".join(lines)
