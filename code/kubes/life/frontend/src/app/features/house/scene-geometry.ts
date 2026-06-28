// Pure geometry for the house scene — no three.js, so it's testable.
// Mirrors lares' room.rs `perimeter()`: walk the wall list, turning then
// stepping, to produce the corner points and wall segments.

import { HouseScene } from '../../models';

export interface Pt {
  x: number;
  z: number;
}

export interface WallSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Corner points of the perimeter walk. Starts at the origin heading +X; each
 *  wall is `[turn_deg, length_m]` — turn the heading, then step. */
export function perimeter(walls: [number, number][]): Pt[] {
  const pts: Pt[] = [{ x: 0, z: 0 }];
  let x = 0;
  let z = 0;
  let heading = 0;
  for (const [turn, len] of walls) {
    heading += turn;
    const r = (heading * Math.PI) / 180;
    x += len * Math.cos(r);
    z += len * Math.sin(r);
    pts.push({ x, z });
  }
  return pts;
}

/** Consecutive wall segments from the perimeter points. */
export function wallSegments(scene: HouseScene): WallSeg[] {
  const pts = perimeter(scene.walls);
  const segs: WallSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z });
  }
  return segs;
}

/** Axis-aligned XZ bounds of the perimeter, for camera framing. */
export function bounds(scene: HouseScene): { cx: number; cz: number; span: number } | null {
  const pts = perimeter(scene.walls);
  if (pts.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    span: Math.max(maxX - minX, maxZ - minZ, 1),
  };
}
