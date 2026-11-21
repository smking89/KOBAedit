"""CUI frame PNG validation, optimisation and logo compositing.

A shop or HUD frame is a transparent PNG drawn underneath Rust's CUI. The rules
below are the ones a server owner hits in practice:

* the client caches every ImageLibrary texture, so an oversized or heavy frame
  makes the UI stall on first open;
* the interior must be fully transparent, or the frame paints over the buttons,
  item icons and text it is supposed to surround;
* the exit button and logo anchors are reserved areas. They are reported as
  guide geometry for the canvas; the validator does not treat the frame's own
  border as an obstruction, because a full-frame border always crosses them.

Logo compositing is the second half: a logo dropped into a frame rarely matches
the border art it sits on, so :func:`composite_logo` tone-maps the mark to the
local border luminance, adds a contact shadow and a rim light, and reports the
resulting contrast instead of leaving the artist to eyeball it.

Normalised regions use Rust's CUI anchor space: ``x`` grows from the left and
``y`` grows from the BOTTOM, matching AnchorMin/AnchorMax. Pixel boxes are
derived with the y axis flipped, which is the only conversion in this module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

# Accepted frame sizes. 1920x1080 is what ships; 2560x1440 is accepted and
# downscaled on import, because nothing above 1080p survives the game's canvas.
FRAME_MIN = (1280, 720)
FRAME_RECOMMENDED = (1920, 1080)
FRAME_MAX = (2560, 1440)

# 1.5 MB in the decimal sense server owners quote, not 1.5 MiB.
FRAME_MAX_BYTES = 1_500_000

# Rectangles as (x_min, y_min, x_max, y_max), normalised, bottom-left origin.
INNER_CUTOUT = (0.12, 0.14, 0.88, 0.86)
EXIT_ZONE = (0.86, 0.84, 0.92, 0.92)
LOGO_ANCHORS: dict[str, tuple[float, float, float, float]] = {
    # Top-centre crest.
    "crest": (0.45, 0.87, 0.55, 0.96),
    # Top-left header block.
    "header": (0.13, 0.84, 0.28, 0.92),
    # Bottom-right medallion.
    "medallion": (0.82, 0.08, 0.91, 0.18),
}

# A pixel counts as transparent below this alpha value. Frames are hard-edged,
# so anything near zero is a cutout rather than a soft shadow.
_ALPHA_FLOOR = 8

# A composited logo has to stay readable against border art of any tone; WCAG
# treats 3:1 as the floor for large graphics, so aim a little under that and
# warn below 1.5:1.
LOGO_TARGET_CONTRAST = 2.2
LOGO_MIN_CONTRAST = 1.5


@dataclass
class FrameIssue:
    code: str
    severity: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "severity": self.severity, "message": self.message}


@dataclass
class FrameReport:
    path: str
    format: str
    mode: str
    width: int
    height: int
    bytes: int
    regions: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)
    interior_opaque: float = 0.0
    exit_opaque: float = 0.0
    issues: list[FrameIssue] = field(default_factory=list)
    optimized_path: str | None = None

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "format": self.format,
            "mode": self.mode,
            "width": self.width,
            "height": self.height,
            "bytes": self.bytes,
            "regions": {name: list(box) for name, box in self.regions.items()},
            "interiorOpaque": round(self.interior_opaque, 4),
            "exitOpaque": round(self.exit_opaque, 4),
            "issues": [issue.to_dict() for issue in self.issues],
            "optimizedPath": self.optimized_path,
            "ok": self.ok,
        }


@dataclass
class LogoReport:
    """What the compositor did to one logo, in the units the canvas shows."""

    frame: str
    logo: str
    anchor: str
    box: tuple[int, int, int, int]
    size: tuple[int, int]
    background_luminance: float
    exposure: float
    contrast_before: float
    contrast_after: float
    shadow_px: int
    issues: list[FrameIssue] = field(default_factory=list)
    path: str | None = None
    final_bytes: int = 0
    compressed: bool = False

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    def to_dict(self) -> dict[str, Any]:
        return {
            "frame": self.frame,
            "logo": self.logo,
            "anchor": self.anchor,
            "box": list(self.box),
            "size": list(self.size),
            "backgroundLuminance": round(self.background_luminance, 4),
            "exposure": round(self.exposure, 4),
            "contrastBefore": round(self.contrast_before, 3),
            "contrastAfter": round(self.contrast_after, 3),
            "shadowPx": self.shadow_px,
            "issues": [issue.to_dict() for issue in self.issues],
            "path": self.path,
            "finalBytes": self.final_bytes,
            "compressed": self.compressed,
            "ok": self.ok,
        }


def pixel_box(
    rect: tuple[float, float, float, float], width: int, height: int
) -> tuple[int, int, int, int]:
    """Convert a bottom-origin normalised rect into PIL's top-left pixel box."""
    x_min, y_min, x_max, y_max = rect
    left = int(round(x_min * width))
    right = int(round(x_max * width))
    top = int(round((1.0 - y_max) * height))
    bottom = int(round((1.0 - y_min) * height))
    left = max(0, min(width, left))
    right = max(left, min(width, right))
    top = max(0, min(height, top))
    bottom = max(top, min(height, bottom))
    return left, top, right, bottom


def frame_regions(width: int, height: int) -> dict[str, tuple[int, int, int, int]]:
    """Every guide overlay the canvas draws, in pixels for this frame size."""
    regions = {
        "outer": (0, 0, width, height),
        "cutout": pixel_box(INNER_CUTOUT, width, height),
        "exit": pixel_box(EXIT_ZONE, width, height),
    }
    for name, rect in LOGO_ANCHORS.items():
        regions[f"logo:{name}"] = pixel_box(rect, width, height)
    return regions


def _opaque_fraction(alpha: Image.Image, box: tuple[int, int, int, int]) -> float:
    left, top, right, bottom = box
    if right <= left or bottom <= top:
        return 0.0
    window = alpha.crop((left, top, right, bottom))
    histogram = window.histogram()
    total = (right - left) * (bottom - top)
    if not total:
        return 0.0
    opaque = sum(histogram[_ALPHA_FLOOR:])
    return opaque / total


def inspect_frame(path: str | Path) -> FrameReport:
    """Validate one frame PNG. Raises OSError for a missing or unreadable file."""
    file = Path(path)
    with Image.open(file) as image:
        image.load()
        report = FrameReport(
            path=str(file),
            format=(image.format or "").upper(),
            mode=image.mode,
            width=image.width,
            height=image.height,
            bytes=file.stat().st_size,
        )
        has_alpha = image.mode in {"RGBA", "LA"} or (
            image.mode == "P" and "transparency" in image.info
        )
        alpha = image.convert("RGBA").getchannel("A")

    def add(code: str, severity: str, message: str) -> None:
        report.issues.append(FrameIssue(code, severity, message))

    if report.format != "PNG":
        add("not-png", "error", f"Frame must be a PNG; this file is {report.format or 'unknown'}.")
    if not has_alpha:
        add(
            "no-alpha",
            "error",
            "PNG has no alpha channel; export PNG-32 (RGBA) so the interior can be cut out.",
        )

    width_matches_ratio = abs(report.width / max(1, report.height) - 16 / 9) < 0.01
    if not width_matches_ratio:
        add("not-16:9", "warning", f"{report.width}x{report.height} is not 16:9; the canvas is 1920x1080.")

    min_w, min_h = FRAME_MIN
    if report.width < min_w or report.height < min_h:
        add("too-small", "error", f"Frame is {report.width}x{report.height}; the minimum is {min_w}x{min_h}.")
    max_w, max_h = FRAME_MAX
    if report.width > max_w or report.height > max_h:
        add(
            "too-large",
            "warning",
            f"Frame is {report.width}x{report.height}; it will be downscaled to "
            f"{FRAME_RECOMMENDED[0]}x{FRAME_RECOMMENDED[1]} on import.",
        )
    if report.bytes > FRAME_MAX_BYTES:
        add(
            "file-too-large",
            "warning",
            f"Frame is {report.bytes // 1024} KiB; it will be compressed under "
            f"{FRAME_MAX_BYTES // 1000} kB for ImageLibrary.",
        )

    report.regions = frame_regions(report.width, report.height)
    report.interior_opaque = _opaque_fraction(alpha, report.regions["cutout"])
    if report.interior_opaque > 0:
        add(
            "opaque-cutout",
            "error",
            f"{report.interior_opaque * 100:.1f}% of the inner cutout is opaque; "
            "it must be 100% transparent (alpha = 0) between x 12–88% and y 14–86%.",
        )

    # Measured, not enforced: the EXIT zone (x 86–92%, y 84–92%) sits inside the
    # frame border, so every valid full-frame PNG covers it. The canvas draws it
    # as a guide and the report exposes the coverage for the designer to judge.
    report.exit_opaque = _opaque_fraction(alpha, report.regions["exit"])

    return report


def _apply_alpha(image: Image.Image, alpha: Image.Image) -> Image.Image:
    """Re-attach the source alpha as a hard mask after colour quantisation."""
    out = image.convert("RGBA")
    out.putalpha(alpha)
    return out


def _save_within_cap(image: Image.Image, alpha: Image.Image, target: Path) -> tuple[Image.Image, bool]:
    """Write a PNG under ``FRAME_MAX_BYTES``, returning the image and whether it shrank.

    Palette-quantise first, then step the resolution down (never below the
    documented minimum), restoring the cutout after every resample so the hole
    stays exactly transparent. Shared by :func:`optimize_frame` and
    :func:`composite_logo`, because ImageLibrary caches both the same way.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    reduced = False

    def write(picture: Image.Image) -> None:
        picture.save(target, format="PNG", optimize=True, compress_level=9)

    write(_apply_alpha(image, alpha))
    if target.stat().st_size > FRAME_MAX_BYTES:
        # Photographic grunge at 1080p does not fit under the cap losslessly.
        write(_apply_alpha(image.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT), alpha))
        reduced = True
    while (
        target.stat().st_size > FRAME_MAX_BYTES
        and image.width > FRAME_MIN[0]
        and image.height > FRAME_MIN[1]
    ):
        size = (
            max(FRAME_MIN[0], round(image.width * 0.9)),
            max(FRAME_MIN[1], round(image.height * 0.9)),
        )
        image = image.convert("RGBA").resize(size, Image.LANCZOS)
        alpha = alpha.resize(size, Image.LANCZOS).point(
            lambda value: 0 if value < _ALPHA_FLOOR else 255
        )
        alpha.paste(0, pixel_box(INNER_CUTOUT, size[0], size[1]))
        write(_apply_alpha(image, alpha))
        reduced = True
    return image, reduced


def optimize_frame(source: str | Path, destination: str | Path | None = None) -> FrameReport:
    """Write an ImageLibrary-ready copy of ``source`` and report on it.

    Downscales anything above 1920x1080, quantises colours when the file is over
    1.5 MB, and keeps the transparent cutout pixel-exact. The returned report
    describes the written file, with the source's own findings kept in front of
    the output findings so a caller sees what was wrong and what was fixed.
    """
    file = Path(source)
    original = inspect_frame(file)
    target = Path(destination) if destination else file.with_name(f"{file.stem}-optimized.png")

    with Image.open(file) as opened:
        opened.load()
        image = opened.convert("RGBA")

    alpha = image.getchannel("A").point(lambda value: 0 if value < _ALPHA_FLOOR else 255)

    # 1920x1080 is the canvas the frame is drawn on, so anything larger loses
    # detail the client never shows.
    if image.width > FRAME_RECOMMENDED[0] or image.height > FRAME_RECOMMENDED[1]:
        scale = min(
            FRAME_RECOMMENDED[0] / image.width,
            FRAME_RECOMMENDED[1] / image.height,
        )
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.LANCZOS)
        alpha = alpha.resize(size, Image.LANCZOS).point(
            lambda value: 0 if value < _ALPHA_FLOOR else 255
        )

    if original.interior_opaque == 0:
        # Resampling blends the hole's edge with the opaque border, which makes a
        # few boundary pixels opaque. The source cutout was clear, so keep the
        # same normalised rect clear at the new size instead of letting the
        # optimiser introduce the very defect it is meant to catch.
        alpha.paste(0, pixel_box(INNER_CUTOUT, alpha.width, alpha.height))

    _save_within_cap(image, alpha, target)

    output = inspect_frame(target)
    output.optimized_path = str(target)
    merged: list[FrameIssue] = list(original.issues)
    seen = {issue.code for issue in merged}
    merged.extend(issue for issue in output.issues if issue.code not in seen)
    output.issues = merged
    return output


def _luminance(rgb: np.ndarray) -> float:
    """Mean sRGB luminance of an (h, w, 3+) float array, in 0..1."""
    if not rgb.size:
        return 0.0
    channels = rgb[..., :3].astype(np.float64)
    return float(
        (channels[..., 0] * 0.2126 + channels[..., 1] * 0.7152 + channels[..., 2] * 0.0722).mean()
        / 255.0
    )


def _contrast(first: float, second: float) -> float:
    high, low = max(first, second), min(first, second)
    return (high + 0.05) / (low + 0.05)


def _target_luminance(background: float, target: float) -> float:
    """The logo luminance that hits ``target`` contrast against ``background``.

    A light frame pushes the logo darker and a dark frame pushes it lighter, so
    the mark never has to fight the border art at the same tone.
    """
    if background >= 0.5:
        return max(0.0, (background + 0.05) / target - 0.05)
    return min(1.0, target * (background + 0.05) - 0.05)


def composite_logo(
    frame: str | Path,
    logo: str | Path,
    anchor: str = "crest",
    destination: str | Path | None = None,
    *,
    target_contrast: float = LOGO_TARGET_CONTRAST,
) -> LogoReport:
    """Drop ``logo`` into a frame anchor with the frame's own lighting.

    The mark is fitted inside the anchor, tone-mapped against the luminance of
    the border art underneath it, given a contact shadow and a top-left rim
    light, then composited with its own alpha so the frame's cutout is never
    touched. The written frame goes through the same 1.5 MB ImageLibrary cap as
    :func:`optimize_frame`; the report carries the exposure applied, the
    contrast achieved and the final file size.
    """
    if anchor not in LOGO_ANCHORS:
        raise ValueError(f"unknown logo anchor {anchor!r}; use one of {', '.join(LOGO_ANCHORS)}")
    frame_file = Path(frame)
    logo_file = Path(logo)

    with Image.open(frame_file) as opened:
        opened.load()
        base = opened.convert("RGBA")
    with Image.open(logo_file) as opened:
        opened.load()
        mark = opened.convert("RGBA")

    box = pixel_box(LOGO_ANCHORS[anchor], base.width, base.height)
    border = np.array(base.crop(box), dtype=np.float32)
    visible = border[..., 3] >= _ALPHA_FLOOR
    background = _luminance(border[..., :3][visible] if visible.any() else border[..., :3])

    box_width, box_height = box[2] - box[0], box[3] - box[1]
    scale = min(box_width / mark.width, box_height / mark.height)
    size = (max(1, round(mark.width * scale)), max(1, round(mark.height * scale)))
    mark = mark.resize(size, Image.LANCZOS)

    pixels = np.array(mark, dtype=np.float32)
    core = pixels[..., 3] >= _ALPHA_FLOOR
    logo_luminance = _luminance(pixels[..., :3][core] if core.any() else pixels[..., :3])
    before = _contrast(background, logo_luminance)

    exposure = 1.0
    if logo_luminance > 0.0 and before < target_contrast:
        wanted = _target_luminance(background, target_contrast)
        exposure = min(2.5, max(0.25, wanted / logo_luminance))
        pixels[..., :3] = np.clip(pixels[..., :3] * exposure, 0.0, 255.0)
        logo_luminance = _luminance(pixels[..., :3][core] if core.any() else pixels[..., :3])

    # Rim light: the edge that faces up-left catches a highlight, which reads as
    # the frame's key light falling across the mark rather than a pasted stamp.
    alpha = pixels[..., 3] / 255.0
    padded = np.pad(alpha, ((1, 0), (1, 0)))
    shifted = padded[:-1, :-1]
    edge = np.clip(alpha - shifted, 0.0, 1.0) * (alpha > 0)
    rim = (0.35 * edge)[..., None]
    pixels[..., :3] = pixels[..., :3] * (1.0 - rim) + 255.0 * rim
    mark = Image.fromarray(np.clip(pixels, 0.0, 255.0).astype(np.uint8), mode="RGBA")

    # Contact shadow: offset down-right so the light source and the shadow agree.
    shadow_px = max(2, round(min(box_width, box_height) * 0.02))
    shadow_alpha = mark.getchannel("A").filter(ImageFilter.GaussianBlur(shadow_px * 0.6))
    shadow_alpha = shadow_alpha.point(lambda value: int(value * 0.45))
    shadow = Image.new("RGBA", size, (8, 10, 14, 0))
    shadow.putalpha(shadow_alpha)

    left = box[0] + (box_width - size[0]) // 2
    top = box[1] + (box_height - size[1]) // 2
    base.alpha_composite(shadow, (left, top + shadow_px))
    base.alpha_composite(mark, (left, top))

    after = _contrast(background, logo_luminance)
    issues: list[FrameIssue] = []
    if after < LOGO_MIN_CONTRAST:
        issues.append(
            FrameIssue(
                "low-contrast",
                "warning",
                f"Logo reads at {after:.1f}:1 against the border art; the mark needs more "
                "tone separation to stay legible in game.",
            )
        )

    target = (
        Path(destination)
        if destination
        else frame_file.with_name(f"{frame_file.stem}-{anchor}.png")
    )
    _, reduced = _save_within_cap(base, base.getchannel("A"), target)
    final_bytes = target.stat().st_size
    if final_bytes > FRAME_MAX_BYTES:
        issues.append(
            FrameIssue(
                "over-image-library-cap",
                "warning",
                f"Composited frame is {final_bytes // 1024} KiB even at the minimum size; "
                "ImageLibrary caches it compressed, so reduce border detail.",
            )
        )

    return LogoReport(
        frame=str(frame_file),
        logo=str(logo_file),
        anchor=anchor,
        box=box,
        size=size,
        background_luminance=background,
        exposure=exposure,
        contrast_before=before,
        contrast_after=after,
        shadow_px=shadow_px,
        issues=issues,
        path=str(target),
        final_bytes=final_bytes,
        compressed=reduced,
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
    "LOGO_MIN_CONTRAST",
    "LOGO_TARGET_CONTRAST",
    "LogoReport",
    "composite_logo",
    "frame_regions",
    "inspect_frame",
    "optimize_frame",
    "pixel_box",
]
