"""The designer's frame guide is generated from the validator's own constants."""

from __future__ import annotations

import re

from koba_engine.cui.frame_processor import (
    EXIT_ZONE,
    FRAME_MAX,
    FRAME_MAX_BYTES,
    FRAME_MIN,
    INNER_CUTOUT,
    LOGO_ANCHORS,
)
from koba_engine.cui.regions_guide import OUTPUT, render_typescript


def test_generated_module_is_committed_and_current() -> None:
    assert OUTPUT.exists(), f"{OUTPUT} is missing; run python -m koba_engine.cui.regions_guide"
    assert OUTPUT.read_text(encoding="utf-8") == render_typescript(), (
        "regions.generated.ts drifted from frame_processor.py; regenerate it with "
        "cd engine && ../.venv/bin/python -m koba_engine.cui.regions_guide "
        "> ../apps/studio-ui/src/cui/regions.generated.ts"
    )


def test_generated_values_are_the_validator_constants() -> None:
    text = render_typescript()
    assert f"{{ width: {FRAME_MIN[0]}, height: {FRAME_MIN[1]} }}" in text
    assert f"{{ width: {FRAME_MAX[0]}, height: {FRAME_MAX[1]} }}" in text
    assert f"FRAME_MAX_BYTES = {FRAME_MAX_BYTES}" in text
    assert str(list(INNER_CUTOUT)) in text
    assert str(list(EXIT_ZONE)) in text
    for name, rect in LOGO_ANCHORS.items():
        assert re.search(rf"  {name}: \[[^\]]+\],", text)
        assert str(list(rect)) in text
