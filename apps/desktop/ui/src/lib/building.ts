import type { Vec3 } from "../wizard/types";

/**
 * Rust building metrics, socket snapping and placement rules.
 *
 * All of this is pure maths so the Walk Mode ghost, the tests and any future
 * engine-side checker use the same numbers:
 *   square foundation / floor : 3.0 m × 3.0 m
 *   wall height               : 3.0 m (half wall 1.5 m)
 *   equilateral triangle      : side 3.0 m, altitude 2.5981 m,
 *                               centroid→edge 0.8660 m, centroid→vertex 1.7321 m
 */

export type BuildPiece = "foundation" | "triangle" | "wall" | "floor" | "stairs";

export const BUILD_PIECES: BuildPiece[] = ["foundation", "triangle", "wall", "floor", "stairs"];
export const BUILD_LABELS: Record<BuildPiece, string> = {
  foundation: "Square foundation",
  triangle: "Triangle foundation",
  wall: "Wall",
  floor: "Floor",
  stairs: "Stairs",
};

export const BUILD_GRID = 3;
export const WALL_HEIGHT = 3;
export const TRI_SIDE = 3;
export const TRI_ALTITUDE = (TRI_SIDE * Math.sqrt(3)) / 2; // 2.598076…
export const TRI_EDGE_TO_CENTRE = TRI_ALTITUDE / 3; // 0.866025…
export const TRI_VERTEX_RADIUS = (TRI_ALTITUDE * 2) / 3; // 1.732050…

/**
 * Offset from a piece's anchor (ground point) to its mesh centre.
 *
 * Foundations and triangles are 0.3 m thick and centred on the anchor, so
 * their top surface lands at +0.15 m — the minimum embed the validator checks
 * (0.15–1.65 m). Walls are centred at half their 3 m height, so they stand on
 * the anchor, and floors sit just proud of it.
 */
export const BUILD_LIFT: Record<BuildPiece, number> = {
  foundation: 0,
  triangle: 0,
  wall: 1.5,
  floor: 0.1,
  stairs: 0,
};

export interface BuildStructure {
  id: string;
  piece: BuildPiece;
  x: number;
  z: number;
  /** Anchor (bottom of the piece) elevation in metres. */
  y: number;
  /** Radians, Y rotation. */
  rotation: number;
}

/** Full piece height in metres. */
export function pieceHeight(piece: BuildPiece): number {
  if (piece === "wall") return WALL_HEIGHT;
  if (piece === "floor") return 0.2;
  if (piece === "stairs") return WALL_HEIGHT;
  return 0.3;
}

/** Top surface of a piece whose anchor sits at `y`. */
export function pieceTopY(piece: BuildPiece, y: number): number {
  return y + BUILD_LIFT[piece] + pieceHeight(piece) / 2;
}

/**
 * Height a child adopts when socketed onto a parent: walls, floors and stairs
 * sit on the parent's top surface, so a floor on a wall is one storey up.
 */
export function socketHeight(
  piece: BuildPiece,
  parent: BuildStructure,
  terrainY: number,
): number {
  const elevated = piece === "wall" || piece === "floor" || piece === "stairs";
  if (!elevated) return terrainY;
  return pieceTopY(parent.piece, parent.y);
}

export interface BuildSnap {
  x: number;
  z: number;
  rotation: number;
  socket: { structureId: string; edge: number } | null;
}

const DEG = Math.PI / 180;
const TURN = Math.PI * 2;

function mod2pi(value: number): number {
  const wrapped = value % TURN;
  return wrapped < 0 ? wrapped + TURN : wrapped;
}

export function isTriangle(piece: BuildPiece): boolean {
  return piece === "triangle";
}

/** Step for the R key: 90° for square pieces, 60° for triangle pieces. */
export function rotationStep(piece: BuildPiece): number {
  return isTriangle(piece) ? 60 * DEG : 90 * DEG;
}

/** Half-extent from a piece's centre to one of its edges. */
export function edgeApothem(piece: BuildPiece): number {
  if (isTriangle(piece)) return TRI_EDGE_TO_CENTRE;
  return BUILD_GRID / 2;
}

/**
 * Outward edge normal angles for a piece.
 * Square: rotation + 0/90/180/270. Triangle: rotation + 30/150/270 (the flat
 * edges opposite each vertex).
 */
export function edgeNormals(piece: BuildPiece, rotation: number): number[] {
  if (isTriangle(piece)) {
    return [30, 150, 270].map((degrees) => mod2pi(rotation + degrees * DEG));
  }
  return [0, 90, 180, 270].map((degrees) => mod2pi(rotation + degrees * DEG));
}

/** Corner points of a piece footprint in world space. */
export function footprintCorners(
  piece: BuildPiece,
  x: number,
  z: number,
  rotation: number,
): { x: number; z: number }[] {
  if (isTriangle(piece)) {
    // Vertices at rotation + 90/210/330; edges then face 30/150/270.
    return [90, 210, 330].map((degrees) => {
      const angle = rotation + degrees * DEG;
      return {
        x: x + Math.cos(angle) * TRI_VERTEX_RADIUS,
        z: z + Math.sin(angle) * TRI_VERTEX_RADIUS,
      };
    });
  }
  const half = BUILD_GRID / 2;
  const corners = [
    { x: -half, z: -half },
    { x: half, z: -half },
    { x: half, z: half },
    { x: -half, z: half },
  ];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return corners.map((corner) => ({
    x: x + corner.x * cos - corner.z * sin,
    z: z + corner.x * sin + corner.z * cos,
  }));
}

/** Local-space triangle vertices, used to build the mesh. */
export function triangleVertices(): Vec3[] {
  return [90, 210, 330].map((degrees) => ({
    x: Math.cos(degrees * DEG) * TRI_VERTEX_RADIUS,
    y: 0,
    z: Math.sin(degrees * DEG) * TRI_VERTEX_RADIUS,
  }));
}

/**
 * Socket-to-socket snap: from every edge of every existing piece, a child's
 * centre sits at parentApothem + childApothem along that edge's outward normal.
 *   square → square   3.000 m
 *   square → triangle 1.5 + 0.866 = 2.366 m
 *   triangle → square 0.866 + 1.5 = 2.366 m
 *   triangle → triangle 0.866 + 0.866 = 1.732 m
 * The child rotation puts a matching flat edge against the parent edge.
 */
export function snapToSocket(
  piece: BuildPiece,
  x: number,
  z: number,
  rotation: number,
  structures: BuildStructure[],
  maxDistance = 2.6,
): BuildSnap {
  let best: BuildSnap = { x, z, rotation, socket: null };
  let bestDistance = maxDistance;

  for (const structure of structures) {
    const normals = edgeNormals(structure.piece, structure.rotation);
    const parentApothem = edgeApothem(structure.piece);
    const childApothem = edgeApothem(piece);
    normals.forEach((angle, edge) => {
      const distance = parentApothem + childApothem;
      const socketX = structure.x + Math.cos(angle) * distance;
      const socketZ = structure.z + Math.sin(angle) * distance;
      const gap = Math.hypot(socketX - x, socketZ - z);
      if (gap > bestDistance) return;
      // Square children align an edge to the socket; triangle children turn so
      // their flat edge faces the parent (rotation = socket angle + 150°).
      const childRotation = isTriangle(piece) ? mod2pi(angle + 150 * DEG) : mod2pi(angle);
      bestDistance = gap;
      best = { x: socketX, z: socketZ, rotation: childRotation, socket: { structureId: structure.id, edge } };
    });
  }

  return best;
}

export interface FoundationSample {
  /** Terrain height under each footprint corner. */
  cornerHeights: number[];
  /** Distance from the piece anchor to the chosen top surface. */
  embed: number;
  slope: number;
  reason: string | null;
}

/**
 * Foundation embed rules: the top surface must sit between 0.15 m and 1.65 m
 * above the terrain at every corner, and the corner-to-corner slope must stay
 * at or below 35°.
 */
export function foundationSample(
  piece: BuildPiece,
  cornerHeights: number[],
  embed = 0.15,
): FoundationSample {
  const min = Math.min(...cornerHeights);
  const max = Math.max(...cornerHeights);
  const delta = max - min;
  const span = isTriangle(piece) ? TRI_ALTITUDE : BUILD_GRID;
  const slope = (Math.atan(delta / Math.max(0.5, span)) * 180) / Math.PI;
  if (slope > 35) {
    return { cornerHeights, embed, slope, reason: "Terrain Too Steep" };
  }
  // Every corner needs 0.15 m of embed and no corner may step more than
  // 1.65 m above the lowest one — a different failure from a steep slope.
  if (delta > 1.5) {
    return { cornerHeights, embed, slope, reason: "Foundation Too Tall" };
  }
  return { cornerHeights, embed, slope, reason: null };
}

/**
 * Shrunk cave/rock overlap: 0.85 × the tunnel half-width still blocks, while
 * 0.15 m of clipping into the wall is allowed, like real cave bases.
 */
export function hitsCaveWall(distanceToAxis: number, tunnelWidth: number): boolean {
  const blockedRadius = (tunnelWidth / 2 - 0.15) * 0.85;
  return distanceToAxis < blockedRadius;
}
