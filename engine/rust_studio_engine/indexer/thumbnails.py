"""Thumbnail generation for prefabs, base meshes and maps.

Nothing here needs a GPU: mesh thumbnails are an orthographic isometric painter's
algorithm over the parsed positions, map thumbnails are a top-down splat/height
render. Output is a 512 px PNG on a dark background that matches the app's
asset browser tiles.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw

from ..world.models import WorldDocument, height_raw_to_metres
from ..world.terrain import HeightField, decode_u16, square_resolution
from .mesh_probe import MeshInfo, probe

BACKGROUND = (16, 18, 21, 255)
GRID = (30, 34, 39, 255)
ACCENT = (94, 168, 255, 255)

SPLAT_COLORS = (
    (130, 108, 75),
    (215, 225, 228),
    (200, 178, 105),
    (115, 105, 98),
    (95, 135, 65),
    (55, 90, 45),
    (150, 140, 130),
    (125, 118, 108),
)


def render_mesh_thumbnail(
    mesh_path: str | Path,
    output_path: str | Path,
    *,
    size: int = 512,
    max_triangles: int = 40_000,
) -> Path:
    """Isometric flat-shaded render of a GLB/OBJ mesh."""
    info = probe(mesh_path, with_geometry=True)
    image = _render_geometry(info, size=size, max_triangles=max_triangles)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "PNG", optimize=True)
    return target


def render_prefab_thumbnail(
    name: str,
    bounds_min: Sequence[float],
    bounds_max: Sequence[float],
    output_path: str | Path,
    *,
    size: int = 512,
) -> Path:
    """Schematic card for a prefab without mesh geometry (bounds only)."""
    image = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)
    _iso_grid(draw, size)
    info = MeshInfo(
        bounds_min=tuple(bounds_min),  # type: ignore[arg-type]
        bounds_max=tuple(bounds_max),  # type: ignore[arg-type]
    )
    _draw_iso_box(draw, info, size, accent=ACCENT)
    draw.text((16, size - 28), name[:48], fill=(180, 190, 200, 255))
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "PNG", optimize=True)
    return target


def render_map_thumbnail(
    document: WorldDocument,
    output_path: str | Path,
    *,
    size: int = 512,
) -> Path:
    """Top-down terrain preview with hillshading, paths and monument markers."""
    image = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)

    height_blob = document.layer("terrain")
    if height_blob:
        values = decode_u16(height_blob)
        resolution = square_resolution(height_blob, 2)
        stride = max(1, resolution // size)
        splat = document.layer("splat")
        splat_planes: list[bytes] = []
        if splat:
            splat_res = square_resolution(splat, 8)
            plane_size = splat_res * splat_res
            splat_planes = [splat[i * plane_size : (i + 1) * plane_size] for i in range(8)]
        else:
            splat_res = 0

        water = document.layer("water")
        water_values = decode_u16(water) if water else None

        for py in range(size):
            sample_y = min(resolution - 1, py * stride)
            for px in range(size):
                sample_x = min(resolution - 1, px * stride)
                index = sample_y * resolution + sample_x
                height = height_raw_to_metres(values[index])

                if splat_planes:
                    sx = min(splat_res - 1, int(px / size * splat_res))
                    sy = min(splat_res - 1, int(py / size * splat_res))
                    sindex = sy * splat_res + sx
                    weights = [plane[sindex] for plane in splat_planes]
                else:
                    weights = [0, 0, 0, 0, 255, 0, 0, 0]

                total = sum(weights) or 1
                r = sum(SPLAT_COLORS[i][0] * weights[i] for i in range(8)) / total
                g = sum(SPLAT_COLORS[i][1] * weights[i] for i in range(8)) / total
                b = sum(SPLAT_COLORS[i][2] * weights[i] for i in range(8)) / total

                # Cheap hillshade from the height gradient.
                right = values[min(resolution - 1, index + stride)]
                down = values[min(len(values) - 1, index + stride * resolution)]
                shade = 1.0 + (values[index] - (right + down) * 0.5) / 9000.0
                shade = max(0.55, min(1.35, shade))

                if water_values and water_values[index] > 0 and height < 0.5:
                    r, g, b = (18, 62, 92)

                draw.point((px, py), fill=(int(r * shade), int(g * shade), int(b * shade), 255))

    for path in document.paths:
        points = [
            _world_to_pixel(node.point.x, node.point.z, document.size, size)
            for node in path.nodes
        ]
        if len(points) > 1:
            name = path.name.lower()
            color = (24, 92, 140) if name.startswith("river") else (48, 44, 38)
            draw.line(points, fill=(*color, 255), width=max(1, int(path.width / document.size * size)))

    for prefab in document.prefabs:
        if "monument" not in prefab.category.lower() and "dungeon" not in prefab.category.lower():
            continue
        px, py = _world_to_pixel(prefab.position.x, prefab.position.z, document.size, size)
        draw.rectangle((px - 3, py - 3, px + 3, py + 3), fill=(196, 146, 70, 255))

    draw.rectangle((0, 0, size - 1, size - 1), outline=(40, 46, 54, 255))
    draw.text((12, 12), f"{document.size} m", fill=(170, 180, 190, 255))
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "PNG", optimize=True)
    return target


def render_heightmap_thumbnail(
    height_field: HeightField, output_path: str | Path, *, size: int = 512
) -> Path:
    """Grayscale preview of a height field (used for terrain step thumbnails)."""
    image = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)
    values = height_field.values
    resolution = height_field.resolution
    stride = max(1, resolution / size)
    for py in range(size):
        for px in range(size):
            index = min(len(values) - 1, int(py * stride) * resolution + int(px * stride))
            normalized = values[index] / 65535.0
            shade = int(normalized * 220) + 20
            draw.point((px, py), fill=(shade, shade, shade, 255))
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "PNG", optimize=True)
    return target


# ---------------------------------------------------------------------------
# Isometric renderer
# ---------------------------------------------------------------------------


def _render_geometry(info: MeshInfo, *, size: int, max_triangles: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), BACKGROUND)
    draw = ImageDraw.Draw(image)
    _iso_grid(draw, size)

    positions = info.positions
    if not positions:
        _draw_iso_box(draw, info, size, accent=ACCENT)
        return image

    minimum = [min(p[i] for p in positions) for i in range(3)]
    maximum = [max(p[i] for p in positions) for i in range(3)]
    centre = [(minimum[i] + maximum[i]) * 0.5 for i in range(3)]
    extent = max(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2], 0.001)
    scale = size * 0.62 / extent

    cos_a, sin_a = math.cos(math.radians(30)), math.sin(math.radians(30))

    def project(point: Sequence[float]) -> tuple[float, float]:
        x = point[0] - centre[0]
        y = point[1] - centre[1]
        z = point[2] - centre[2]
        screen_x = (x - z) * cos_a
        screen_y = (x + z) * sin_a - y
        return (size * 0.5 + screen_x * scale, size * 0.52 + screen_y * scale)

    light = (0.35, 0.72, 0.55)
    triangles = info.triangles
    if not triangles:
        triangles = [(i, i + 1, i + 2) for i in range(0, len(positions) - 2, 3)]
    triangles = triangles[:max_triangles]

    depth_sorted = []
    for tri in triangles:
        try:
            a, b, c = positions[tri[0]], positions[tri[1]], positions[tri[2]]
        except IndexError:
            continue
        depth = (a[0] + b[0] + c[0]) + (a[2] + b[2] + c[2]) + (a[1] + b[1] + c[1]) * 0.5
        depth_sorted.append((depth, a, b, c))
    depth_sorted.sort(key=lambda item: item[0])

    for _depth, a, b, c in depth_sorted:
        normal = _face_normal(a, b, c)
        lambert = max(0.0, normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2])
        shade = 0.25 + 0.75 * lambert
        color = (
            int(96 * shade + 24),
            int(150 * shade + 30),
            int(196 * shade + 36),
            255,
        )
        draw.polygon([project(a), project(b), project(c)], fill=color)

    draw.text((14, size - 26), f"{info.triangle_count:,} tris", fill=(150, 160, 170, 255))
    return image


def _face_normal(
    a: Sequence[float], b: Sequence[float], c: Sequence[float]
) -> tuple[float, float, float]:
    ab = [b[i] - a[i] for i in range(3)]
    ac = [c[i] - a[i] for i in range(3)]
    nx = ab[1] * ac[2] - ab[2] * ac[1]
    ny = ab[2] * ac[0] - ab[0] * ac[2]
    nz = ab[0] * ac[1] - ab[1] * ac[0]
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return (abs(nx / length), abs(ny / length), abs(nz / length))


def _iso_grid(draw: ImageDraw.ImageDraw, size: int) -> None:
    step = size // 8
    for index in range(1, 8):
        draw.line((0, index * step, size, index * step), fill=GRID)
        draw.line((index * step, 0, index * step, size), fill=GRID)


def _draw_iso_box(
    draw: ImageDraw.ImageDraw, info: MeshInfo, size: int, *, accent: tuple[int, int, int, int]
) -> None:
    minimum, maximum = info.bounds_min, info.bounds_max
    if maximum == minimum:
        maximum = tuple(value + 1.0 for value in maximum)  # type: ignore[assignment]
    extent = max(maximum[i] - minimum[i] for i in range(3)) or 1.0
    scale = size * 0.55 / extent
    cos_a, sin_a = math.cos(math.radians(30)), math.sin(math.radians(30))
    centre = [(minimum[i] + maximum[i]) * 0.5 for i in range(3)]

    def project(point: Sequence[float]) -> tuple[float, float]:
        x, y, z = (point[i] - centre[i] for i in range(3))
        return (size / 2 + (x - z) * cos_a * scale, size / 2 + ((x + z) * sin_a - y) * scale)

    corners = [
        (x, y, z)
        for x in (minimum[0], maximum[0])
        for y in (minimum[1], maximum[1])
        for z in (minimum[2], maximum[2])
    ]
    projected = [project(corner) for corner in corners]
    edges = [
        (0, 1), (2, 3), (4, 5), (6, 7),
        (0, 2), (1, 3), (4, 6), (5, 7),
        (0, 4), (1, 5), (2, 6), (3, 7),
    ]
    for start, end in edges:
        draw.line((*projected[start], *projected[end]), fill=accent, width=2)


def _world_to_pixel(x: float, z: float, size_metres: int, pixels: int) -> tuple[float, float]:
    px = (x + size_metres / 2) / max(1, size_metres) * pixels
    py = pixels - 1 - (z + size_metres / 2) / max(1, size_metres) * pixels
    return (px, py)


__all__ = [
    "render_heightmap_thumbnail",
    "render_map_thumbnail",
    "render_mesh_thumbnail",
    "render_prefab_thumbnail",
]
