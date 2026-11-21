"""CUI shop and HUD tooling: frame validation, optimisation and logo compositing."""

from .frame_processor import (
    EXIT_ZONE,
    FRAME_MAX,
    FRAME_MAX_BYTES,
    FRAME_MIN,
    FRAME_RECOMMENDED,
    INNER_CUTOUT,
    LOGO_ANCHORS,
    FrameIssue,
    FrameReport,
    LogoReport,
    composite_logo,
    frame_regions,
    inspect_frame,
    optimize_frame,
    pixel_box,
)

__all__ = [
    "EXIT_ZONE",
    "FRAME_MAX",
    "FRAME_MAX_BYTES",
    "FRAME_MIN",
    "FRAME_RECOMMENDED",
    "FrameIssue",
    "FrameReport",
    "INNER_CUTOUT",
    "LOGO_ANCHORS",
    "LogoReport",
    "composite_logo",
    "frame_regions",
    "inspect_frame",
    "optimize_frame",
    "pixel_box",
]
