"""Render the CUI guide constants as TypeScript for the designer.

`frame_processor.py` is the single source of the frame geometry. The designer
imports the generated module, and ``test_cui_regions_guide.py`` fails when the
committed file no longer matches this renderer, so the two cannot drift.

Regenerate with::

    cd engine && ../.venv/bin/python -m koba_engine.cui.regions_guide \
        > ../apps/studio-ui/src/cui/regions.generated.ts
"""

from __future__ import annotations

from pathlib import Path

from .frame_processor import (
    EXIT_ZONE,
    FRAME_MAX,
    FRAME_MAX_BYTES,
    FRAME_MIN,
    FRAME_RECOMMENDED,
    INNER_CUTOUT,
    LOGO_ANCHORS,
    LOGO_MIN_CONTRAST,
    LOGO_TARGET_CONTRAST,
)

OUTPUT = (
    Path(__file__).resolve().parents[3]
    / "apps/studio-ui/src/cui/regions.generated.ts"
)


def _number(value: float) -> str:
    return f"{value:g}"


def _rect(rect: tuple[float, float, float, float]) -> str:
    return "[" + ", ".join(_number(value) for value in rect) + "]"


def render_typescript() -> str:
    """The generated module, byte for byte as written to ``OUTPUT``."""
    lines = [
        "/**",
        " * CUI guide constants, generated from",
        " * engine/koba_engine/cui/frame_processor.py. Do not edit by hand:",
        " *",
        " *   cd engine && ../.venv/bin/python -m koba_engine.cui.regions_guide \\",
        " *     > ../apps/studio-ui/src/cui/regions.generated.ts",
        " *",
        " * engine/tests/test_cui_regions_guide.py fails when this file drifts.",
        " */",
        "",
        f"export const FRAME_MIN = {{ width: {FRAME_MIN[0]}, height: {FRAME_MIN[1]} }} as const;",
        "export const FRAME_RECOMMENDED = "
        f"{{ width: {FRAME_RECOMMENDED[0]}, height: {FRAME_RECOMMENDED[1]} }} as const;",
        f"export const FRAME_MAX = {{ width: {FRAME_MAX[0]}, height: {FRAME_MAX[1]} }} as const;",
        f"export const FRAME_MAX_BYTES = {FRAME_MAX_BYTES};",
        "",
        f"export const INNER_CUTOUT = {_rect(INNER_CUTOUT)} as const;",
        f"export const EXIT_ZONE = {_rect(EXIT_ZONE)} as const;",
        "",
        "export const LOGO_ANCHORS = {",
    ]
    for name, rect in LOGO_ANCHORS.items():
        lines.append(f"  {name}: {_rect(rect)},")
    lines.extend(
        [
            "} as const;",
            "",
            f"export const LOGO_TARGET_CONTRAST = {_number(LOGO_TARGET_CONTRAST)};",
            f"export const LOGO_MIN_CONTRAST = {_number(LOGO_MIN_CONTRAST)};",
            "",
        ]
    )
    return "\n".join(lines)


if __name__ == "__main__":
    print(render_typescript(), end="")
