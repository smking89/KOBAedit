"""Tests for CUI frame validation and optimisation."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from koba_engine.cui.frame_processor import (
    EXIT_ZONE,
    FRAME_MAX_BYTES,
    FRAME_RECOMMENDED,
    INNER_CUTOUT,
    LOGO_ANCHORS,
    LOGO_MIN_CONTRAST,
    composite_logo,
    frame_regions,
    inspect_frame,
    optimize_frame,
    pixel_box,
)


def make_frame(width: int, height: int, *, opaque_interior: bool = False) -> Image.Image:
    """Opaque frame around a transparent inner cutout."""
    image = Image.new("RGBA", (width, height), (120, 40, 30, 255))
    box = pixel_box(INNER_CUTOUT, width, height)
    image.paste((10, 200, 10, 255) if opaque_interior else (0, 0, 0, 0), box)
    return image


def noisy_frame(width: int, height: int) -> np.ndarray:
    """A gradient with light grain: heavy like real grunge, still compressible."""
    y = np.linspace(0.0, 1.0, height)[:, None]
    x = np.linspace(0.0, 1.0, width)[None, :]
    base = np.stack(
        [
            np.broadcast_to(x * 200 + 30, (height, width)),
            np.broadcast_to(y * 180 + 40, (height, width)),
            np.broadcast_to(x * y * 220 + 20, (height, width)),
        ],
        axis=-1,
    )
    grain = np.random.default_rng(7).integers(-8, 9, size=(height, width, 1))
    rgb = np.clip(base + grain, 0, 255).astype(np.uint8)
    alpha = np.full((height, width, 1), 255, dtype=np.uint8)
    pixels = np.concatenate([rgb, alpha], axis=2)
    box = pixel_box(INNER_CUTOUT, width, height)
    pixels[box[1] : box[3], box[0] : box[2], 3] = 0
    return pixels


def save(image: Image.Image, path: Path) -> Path:
    image.save(path, format="PNG")
    return path


def codes(report) -> set[str]:
    return {issue.code for issue in report.issues}


def test_compliant_frame_passes(tmp_path: Path) -> None:
    path = save(make_frame(1920, 1080), tmp_path / "frame.png")
    report = inspect_frame(path)

    assert report.ok
    assert report.format == "PNG"
    assert report.width == 1920
    assert report.interior_opaque == 0
    assert codes(report) == set()


def test_opaque_interior_is_an_error(tmp_path: Path) -> None:
    path = save(make_frame(1920, 1080, opaque_interior=True), tmp_path / "opaque.png")
    report = inspect_frame(path)

    assert not report.ok
    assert "opaque-cutout" in codes(report)
    assert report.interior_opaque == pytest.approx(1.0)


def test_missing_alpha_channel_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "rgb.png"
    Image.new("RGB", (1920, 1080), (40, 40, 40)).save(path)
    report = inspect_frame(path)

    assert "no-alpha" in codes(report)
    assert not report.ok


def test_too_small_frame_is_an_error(tmp_path: Path) -> None:
    path = save(make_frame(640, 360), tmp_path / "small.png")
    report = inspect_frame(path)

    assert "too-small" in codes(report)
    assert not report.ok


def test_reserved_exit_zone_is_measured_but_not_enforced(tmp_path: Path) -> None:
    path = save(make_frame(1920, 1080), tmp_path / "border.png")
    report = inspect_frame(path)

    # A full frame border crosses the reserved EXIT zone by construction, so the
    # overlap is reported as coverage and must not fail an otherwise valid frame.
    assert report.exit_opaque > 0
    assert report.ok
    assert report.regions["exit"] == pixel_box(EXIT_ZONE, 1920, 1080)


def test_regions_use_rust_bottom_origin() -> None:
    regions = frame_regions(1920, 1080)

    # Crest sits near the TOP of the canvas (y 87-96% from the bottom).
    left, top, right, bottom = regions["logo:crest"]
    assert (left, right) == (864, 1056)
    assert top < 1080 * 0.1
    assert bottom < 1080 * 0.2

    # EXIT zone is the top-right reserved area.
    left, top, right, bottom = regions["exit"]
    assert right > 1920 * 0.85
    assert top < 1080 * 0.25


def test_oversized_noisy_frame_is_downscaled_and_compressed(tmp_path: Path) -> None:
    pixels = noisy_frame(2560, 1440)
    source = tmp_path / "huge.png"
    Image.fromarray(pixels, mode="RGBA").save(source, format="PNG")

    assert source.stat().st_size > FRAME_MAX_BYTES

    output = tmp_path / "optimized.png"
    report = optimize_frame(source, output)

    assert output.exists()
    assert report.width == FRAME_RECOMMENDED[0]
    assert report.height == FRAME_RECOMMENDED[1]
    assert output.stat().st_size <= FRAME_MAX_BYTES
    # The cutout must survive quantisation exactly.
    assert report.interior_opaque == 0
    assert "opaque-cutout" not in codes(report)


def test_optimiser_reports_an_opaque_cutout_instead_of_redrawing_art(tmp_path: Path) -> None:
    path = save(make_frame(2560, 1440, opaque_interior=True), tmp_path / "bad.png")
    report = optimize_frame(path, tmp_path / "fixed.png")

    # Downscaling is mechanical; punching a hole in the artist's work is not, so
    # the refusal travels with the optimised file instead of being fixed silently.
    assert "opaque-cutout" in codes(report)
    assert not report.ok
    assert report.optimized_path is not None
    assert (report.width, report.height) == (1920, 1080)


def light_frame(width: int, height: int, tone: tuple[int, int, int] = (232, 232, 232)) -> Image.Image:
    image = Image.new("RGBA", (width, height), (*tone, 255))
    image.paste((0, 0, 0, 0), pixel_box(INNER_CUTOUT, width, height))
    return image


def test_logo_anchors_follow_the_v16_guide() -> None:
    assert LOGO_ANCHORS["crest"] == (0.45, 0.87, 0.55, 0.96)
    assert LOGO_ANCHORS["header"] == (0.13, 0.84, 0.28, 0.92)
    assert LOGO_ANCHORS["medallion"] == (0.82, 0.08, 0.91, 0.18)


def test_logo_lands_inside_its_anchor_without_touching_the_cutout(tmp_path: Path) -> None:
    frame = save(light_frame(1920, 1080), tmp_path / "frame.png")
    logo = save(Image.new("RGBA", (240, 120), (250, 250, 250, 255)), tmp_path / "logo.png")

    report = composite_logo(frame, logo, "crest", tmp_path / "composed.png")
    box = pixel_box(LOGO_ANCHORS["crest"], 1920, 1080)

    assert report.box == box
    assert report.size[0] <= box[2] - box[0] and report.size[1] <= box[3] - box[1]
    assert report.path is not None

    composed = np.array(Image.open(report.path).convert("RGBA"), dtype=np.int16)
    original = np.array(light_frame(1920, 1080), dtype=np.int16)
    inside = composed[box[1] : box[3], box[0] : box[2], :3]
    assert np.abs(inside - original[box[1] : box[3], box[0] : box[2], :3]).max() > 20

    # A corner far from the anchor is untouched, and the hole stays clear.
    assert np.array_equal(composed[10:40, 10:40], original[10:40, 10:40])
    assert inspect_frame(report.path).interior_opaque == 0


def test_light_border_darkens_the_logo_to_stay_readable(tmp_path: Path) -> None:
    frame = save(light_frame(1920, 1080), tmp_path / "light.png")
    logo = save(Image.new("RGBA", (200, 100), (150, 150, 150, 255)), tmp_path / "grey.png")

    report = composite_logo(frame, logo, "header", tmp_path / "out.png")

    assert report.exposure < 1.0
    assert report.contrast_after > report.contrast_before
    assert report.contrast_after >= LOGO_MIN_CONTRAST
    assert report.ok


def test_dark_border_keeps_the_logo_untouched(tmp_path: Path) -> None:
    frame = save(
        light_frame(1920, 1080, tone=(18, 18, 18)), tmp_path / "dark.png"
    )
    logo = save(Image.new("RGBA", (200, 100), (248, 248, 248, 255)), tmp_path / "white.png")

    report = composite_logo(frame, logo, "medallion", tmp_path / "out.png")

    assert report.exposure == pytest.approx(1.0)
    assert report.contrast_after >= LOGO_MIN_CONTRAST


def test_logo_gets_a_contact_shadow_and_rim_light(tmp_path: Path) -> None:
    frame = save(light_frame(1920, 1080, tone=(200, 200, 200)), tmp_path / "frame.png")
    logo = save(Image.new("RGBA", (200, 100), (120, 120, 120, 255)), tmp_path / "logo.png")

    report = composite_logo(frame, logo, "crest", tmp_path / "out.png")
    composed = np.array(Image.open(report.path).convert("RGBA"), dtype=np.int16)

    left = report.box[0] + ((report.box[2] - report.box[0]) - report.size[0]) // 2
    top = report.box[1] + ((report.box[3] - report.box[1]) - report.size[1]) // 2
    centre = composed[top + report.size[1] // 2, left + report.size[0] // 2, :3].mean()
    edge = composed[top, left + 1, :3].mean()

    assert report.shadow_px >= 2
    assert edge > centre + 20  # rim highlight on the up-left edge
    below = composed[min(report.box[3] - 1, top + report.size[1] + report.shadow_px // 2), left + 1]
    assert below[:3].mean() < 190  # contact shadow darkens the border art


def test_unknown_anchor_is_rejected(tmp_path: Path) -> None:
    frame = save(light_frame(1920, 1080), tmp_path / "frame.png")
    logo = save(Image.new("RGBA", (64, 64), (255, 255, 255, 255)), tmp_path / "logo.png")

    with pytest.raises(ValueError, match="unknown logo anchor"):
        composite_logo(frame, logo, "corner", tmp_path / "out.png")


def test_composited_frame_passes_the_image_library_cap(tmp_path: Path) -> None:
    """A heavy frame plus a logo must still land under the 1.5 MB cap."""
    frame = save(Image.fromarray(noisy_frame(2560, 1440), "RGBA"), tmp_path / "heavy.png")
    logo = save(Image.new("RGBA", (320, 200), (250, 250, 250, 255)), tmp_path / "logo.png")
    out = tmp_path / "heavy-crest.png"

    report = composite_logo(frame, logo, "crest", out)

    assert report.final_bytes == out.stat().st_size
    assert report.final_bytes <= FRAME_MAX_BYTES
    assert report.compressed is True
    assert report.ok, [issue.message for issue in report.issues]
    with Image.open(out) as image:
        alpha = image.convert("RGBA").getchannel("A")
        cutout = pixel_box(INNER_CUTOUT, image.width, image.height)
        assert alpha.crop(cutout).getextrema() == (0, 0), "the cutout stopped being transparent"


def test_composited_frame_reports_its_final_size(tmp_path: Path) -> None:
    """A frame that already fits is written once and the size is reported."""
    frame = save(make_frame(1920, 1080), tmp_path / "clean.png")
    logo = save(Image.new("RGBA", (200, 120), (240, 236, 228, 255)), tmp_path / "logo.png")
    out = tmp_path / "clean-crest.png"

    report = composite_logo(frame, logo, "crest", out)

    assert report.compressed is False
    assert report.final_bytes == out.stat().st_size < FRAME_MAX_BYTES
    assert report.to_dict()["finalBytes"] == report.final_bytes
