/**
 * Pedestrian trajectory smoother — a physically-precise walk estimate.
 *
 * The walking arm of `docs/proposals/2026-06-pedestrian-trajectory-smoother.md`
 * (sibling of the driving map-constrained positioning work). A slow walk is the
 * hardest leg to draw: per-fix GPS velocity is buried in noise, so the raw fixes
 * zigzag (measured tortuosity 2.7×) and a few 150–230 m accuracy fixes cause big
 * jumps. Snapping to footways — driving's fix — is wrong, because a walker is
 * free in a park and dynamic on a street (either side, sometimes off it).
 *
 * So this is a MAP (maximum-a-posteriori) trajectory smoother over a factor
 * graph. It finds the single most probable path given everything measured, by
 * minimising the sum of physically-meaningful costs:
 *
 *   - **robust GPS** — each fix pulls with weight 1/accuracy² through a
 *     heavy-tailed (Huber) loss, so a 230 m outlier contributes ≈0;
 *   - **step-distance (PDR)** — arc length over an interval ≈ steps×stride; the
 *     pedometer measures distance far better than slow-walk GPS, pinning length;
 *   - **endpoint anchors** — strong priors at the car stop and the dwell place;
 *   - **smoothness** — bounded acceleration / turn-rate (no impossible zigzags);
 *   - **soft, openness-modulated map** — a *gentle* pull onto walkable surface,
 *     weighted by how constraining the surroundings are: ≈0 in a park/forest,
 *     higher in a lone corridor, always small vs GPS+PDR so it can bias but never
 *     override where the evidence says you were.
 *
 * Solved offline as a batch smoother (all fixes, past+future — strictly better
 * than the forward-only Kalman that caused the original 80 m swing) by
 * gradient-based optimisation with iteratively-reweighted robust GPS terms.
 * Each output vertex carries a posterior σ (honest uncertainty) so a
 * low-confidence walk can be drawn as low-confidence.
 *
 * Pure: no DB, no network, deterministic given its inputs.
 */

import type { RoadGeometry } from "./road-match.js";

export interface PedFix {
	ts: number;
	lat: number;
	lon: number;
	accuracy: number | null;
}

/** Per-minute step count (Fitbit `steps_intraday` shape). */
export interface PedStep {
	ts: number;
	steps: number;
}

export interface LatLon {
	lat: number;
	lon: number;
}

/** A walkable surface for the soft map factor: the line network (footways,
 *  paths, pavements …) plus open zones (parks, pedestrian areas) inside which
 *  movement is unconstrained, so the map exerts no pull. */
export interface WalkableGeo {
	ways: RoadGeometry["ways"];
	/** Polygons (lat/lon rings) of open walkable area — park, plaza, forest. */
	openZones?: ReadonlyArray<ReadonlyArray<LatLon>>;
	/** Impassable polygons (lat/lon rings) — building footprints. A vertex
	 *  inside one is firmly pushed onto the nearest walkable way: you cannot be
	 *  inside a building, regardless of the openness gate. */
	buildings?: ReadonlyArray<ReadonlyArray<LatLon>>;
}

export interface SmoothOpts {
	/** Strong prior on the first vertex — where the previous leg ended. */
	anchorStart?: LatLon | null;
	/** Strong prior on the last vertex — the place that was entered. */
	anchorEnd?: LatLon | null;
	/** Per-minute steps overlapping the leg; enables the PDR distance factor. */
	steps?: readonly PedStep[];
	/** Metres per step. Default a typical adult stride. */
	strideM?: number;
	/** Walkable surface for the soft map factor; omit to disable the map term. */
	walkable?: WalkableGeo | null;
	/** Optimiser iteration cap (default 400 — instant for these sizes). */
	iterations?: number;
}

export interface SmoothVertex extends LatLon {
	ts: number;
	/** Posterior 1-σ position uncertainty (m) — honest confidence. */
	sigmaM: number;
}

export interface SmoothResult {
	path: SmoothVertex[];
}

// --- weights (relative; GPS is the unit scale) ------------------------------
/** Acceleration penalty — gait smoothness. Modest: GPS+PDR should dominate. */
const W_SMOOTH = 0.6;
/** Step-distance (PDR) penalty. Strong — the pedometer is the precise length. */
const W_STEP = 1.4;
/** Endpoint anchor penalty. Strong — both ends are well-known. */
const W_ANCHOR = 6;
/** Soft map pull, full strength (a lone corridor). Small vs GPS+PDR. */
const W_MAP = 0.25;
/** Building repulsion. Strong — a vertex inside a building footprint is firmly
 *  pulled onto the nearest walkable way, overriding the openness gate. You can
 *  walk freely in a park but not through a wall. Well above W_MAP so the line
 *  reliably exits the building, but finite so a genuine indoor fix isn't
 *  impossibly penalised. */
const W_BUILDING = 1.5;
/** The map only speaks when a walkable way is within this far. Beyond it you're
 *  in open ground (a park, a forest, a car park) where the user is "free to walk
 *  anywhere" — so the map exerts no pull at all. This is the openness model:
 *  near a path → gentle nudge; far from any path → unconstrained. */
const OPENNESS_RADIUS_M = 35;
/** Huber threshold (in σ units): residuals beyond this switch to L1, so a
 *  far outlier fix pulls with vanishing weight. */
const HUBER_DELTA = 1.5;
/** Floor on a fix's accuracy (m) so an over-confident 1 m fix can't dominate. */
const MIN_ACC_M = 5;
/** Treated as the accuracy of a fix with no reported value. */
const DEFAULT_ACC_M = 30;
/** Default metres per step (typical adult). */
const DEFAULT_STRIDE_M = 0.72;
/** A leg shorter than this many fixes isn't worth smoothing. */
const MIN_FIXES = 3;

interface Vec {
	x: number;
	y: number;
}

/** Local equirectangular frame anchored at a reference lat/lon. */
function makeFrame(refLat: number, refLon: number) {
	const cosLat = Math.cos((refLat * Math.PI) / 180);
	return {
		toXY: (lat: number, lon: number): Vec => ({ x: (lon - refLon) * 111_320 * cosLat, y: (lat - refLat) * 111_320 }),
		toLatLon: (v: Vec): LatLon => ({ lat: refLat + v.y / 111_320, lon: refLon + v.x / (111_320 * cosLat) }),
	};
}

/** Steps walked in [from, to), distributing each per-minute count by the
 *  fraction of its minute that overlaps the interval. Fixes are ~15 s apart but
 *  step rows are per-minute, so a whole minute's steps must be spread across the
 *  sub-minute fix intervals it spans, not dumped on the one containing its top. */
function stepsBetween(steps: readonly PedStep[], from: number, to: number): number {
	if (to <= from) return 0;
	let n = 0;
	for (const s of steps) {
		const lo = Math.max(from, s.ts);
		const hi = Math.min(to, s.ts + 60);
		if (hi > lo) n += s.steps * ((hi - lo) / 60);
	}
	return n;
}

/** Closest point on segment a→b to p, all in the planar metric frame. */
function projectXY(p: Vec, a: Vec, b: Vec): Vec {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const len2 = abx * abx + aby * aby;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
	return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Nearest point on the walkable network to `p` (local frame), or null if the
 *  network is empty. Used as the (fixed-within-iteration) map target. */
function nearestWalkable(p: Vec, ways: WalkableGeo["ways"], frame: ReturnType<typeof makeFrame>): Vec | null {
	let best: Vec | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const w of ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = frame.toXY(w.coords[i - 1][0], w.coords[i - 1][1]);
			const b = frame.toXY(w.coords[i][0], w.coords[i][1]);
			const q = projectXY(p, a, b);
			const d = Math.hypot(p.x - q.x, p.y - q.y);
			if (d < bestD) {
				bestD = d;
				best = q;
			}
		}
	}
	return best;
}

/** Ray-cast point-in-polygon for a single lat/lon ring in the local frame. */
function pointInRing(p: Vec, ring: ReadonlyArray<LatLon>, frame: ReturnType<typeof makeFrame>): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const pi = frame.toXY(ring[i].lat, ring[i].lon);
		const pj = frame.toXY(ring[j].lat, ring[j].lon);
		const intersect = pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** Whether a local-frame point lies inside any open zone (free to roam). */
function inOpenZone(p: Vec, zones: WalkableGeo["openZones"], frame: ReturnType<typeof makeFrame>): boolean {
	if (!zones) return false;
	for (const ring of zones) if (pointInRing(p, ring, frame)) return true;
	return false;
}

/** Whether a local-frame point lies inside any building footprint (impassable). */
function inBuilding(p: Vec, buildings: WalkableGeo["buildings"], frame: ReturnType<typeof makeFrame>): boolean {
	if (!buildings) return false;
	for (const ring of buildings) if (pointInRing(p, ring, frame)) return true;
	return false;
}

/**
 * Smooth a walking leg's GPS into a physically-precise trajectory. Returns null
 * when there are too few fixes to bother. The result has one vertex per input
 * fix (same timestamps), each on the MAP trajectory with a posterior σ.
 */
export function smoothPedestrianTrajectory(fixes: readonly PedFix[], opts: SmoothOpts = {}): SmoothResult | null {
	if (fixes.length < MIN_FIXES) return null;
	const sorted = [...fixes].sort((a, b) => a.ts - b.ts);
	const n = sorted.length;
	const frame = makeFrame(sorted[0].lat, sorted[0].lon);
	const stride = opts.strideM ?? DEFAULT_STRIDE_M;
	const iterations = opts.iterations ?? 400;

	const z = sorted.map((f) => frame.toXY(f.lat, f.lon)); // GPS observations
	const invSig2 = sorted.map((f) => {
		const acc = Math.max(MIN_ACC_M, f.accuracy ?? DEFAULT_ACC_M);
		return 1 / (acc * acc);
	});
	const sig = sorted.map((f) => Math.max(MIN_ACC_M, f.accuracy ?? DEFAULT_ACC_M));

	// PDR target distance per inter-fix interval (0 ⇒ factor off for that edge).
	const stepDist: number[] = new Array(n).fill(0);
	const hasSteps = (opts.steps?.length ?? 0) > 0;
	if (hasSteps && opts.steps) {
		for (let i = 1; i < n; i++) stepDist[i] = stepsBetween(opts.steps, sorted[i - 1].ts, sorted[i].ts) * stride;
	}

	const anchorA = opts.anchorStart ? frame.toXY(opts.anchorStart.lat, opts.anchorStart.lon) : null;
	const anchorB = opts.anchorEnd ? frame.toXY(opts.anchorEnd.lat, opts.anchorEnd.lon) : null;

	// Initialise at the raw fixes (clamped to anchors where given).
	const p: Vec[] = z.map((v) => ({ ...v }));
	if (anchorA) p[0] = { ...anchorA };
	if (anchorB) p[n - 1] = { ...anchorB };

	// Adam optimiser state — robust to the smoothness term's stiffness.
	const mx = new Array(n).fill(0);
	const my = new Array(n).fill(0);
	const vx = new Array(n).fill(0);
	const vy = new Array(n).fill(0);
	const lr = 2.0;
	const b1 = 0.9;
	const b2 = 0.999;
	const eps = 1e-8;

	const gx = new Array(n).fill(0);
	const gy = new Array(n).fill(0);

	for (let iter = 1; iter <= iterations; iter++) {
		gx.fill(0);
		gy.fill(0);

		// Robust GPS (IRLS Huber weight from the current residual).
		for (let i = 0; i < n; i++) {
			const rx = p[i].x - z[i].x;
			const ry = p[i].y - z[i].y;
			const r = Math.hypot(rx, ry) / sig[i];
			const w = r <= HUBER_DELTA ? 1 : HUBER_DELTA / r; // Huber
			gx[i] += 2 * w * invSig2[i] * rx;
			gy[i] += 2 * w * invSig2[i] * ry;
		}

		// Smoothness: Σ |p_{i-1} − 2p_i + p_{i+1}|².
		for (let i = 1; i < n - 1; i++) {
			const dx = p[i - 1].x - 2 * p[i].x + p[i + 1].x;
			const dy = p[i - 1].y - 2 * p[i].y + p[i + 1].y;
			gx[i - 1] += 2 * W_SMOOTH * dx;
			gy[i - 1] += 2 * W_SMOOTH * dy;
			gx[i] += 2 * W_SMOOTH * -2 * dx;
			gy[i] += 2 * W_SMOOTH * -2 * dy;
			gx[i + 1] += 2 * W_SMOOTH * dx;
			gy[i + 1] += 2 * W_SMOOTH * dy;
		}

		// Step-distance (PDR): Σ (|p_i − p_{i-1}| − d_i)².
		for (let i = 1; i < n; i++) {
			if (stepDist[i] <= 0) continue;
			const ex = p[i].x - p[i - 1].x;
			const ey = p[i].y - p[i - 1].y;
			const len = Math.hypot(ex, ey);
			if (len < 1e-6) continue;
			const s = len - stepDist[i];
			const ux = ex / len;
			const uy = ey / len;
			gx[i] += 2 * W_STEP * s * ux;
			gy[i] += 2 * W_STEP * s * uy;
			gx[i - 1] -= 2 * W_STEP * s * ux;
			gy[i - 1] -= 2 * W_STEP * s * uy;
		}

		// Endpoint anchors.
		if (anchorA) {
			gx[0] += 2 * W_ANCHOR * (p[0].x - anchorA.x);
			gy[0] += 2 * W_ANCHOR * (p[0].y - anchorA.y);
		}
		if (anchorB) {
			gx[n - 1] += 2 * W_ANCHOR * (p[n - 1].x - anchorB.x);
			gy[n - 1] += 2 * W_ANCHOR * (p[n - 1].y - anchorB.y);
		}

		// Soft, openness-modulated map pull. Two openness gates: an explicit open
		// zone (park/plaza polygon), and the distance gate — beyond
		// OPENNESS_RADIUS_M from any path you're in open ground and free, so the
		// map says nothing.
		if (opts.walkable && opts.walkable.ways.length > 0) {
			for (let i = 0; i < n; i++) {
				const q = nearestWalkable(p[i], opts.walkable.ways, frame);
				if (!q) continue;
				// Impassable: inside a building, a strong pull onto the nearest
				// walkable surface — overrides the openness gate (you cannot be
				// inside a building, however far it is from a path).
				if (inBuilding(p[i], opts.walkable.buildings, frame)) {
					gx[i] += 2 * W_BUILDING * (p[i].x - q.x);
					gy[i] += 2 * W_BUILDING * (p[i].y - q.y);
					continue;
				}
				if (inOpenZone(p[i], opts.walkable.openZones, frame)) continue; // free here
				const dist = Math.hypot(p[i].x - q.x, p[i].y - q.y);
				if (dist > OPENNESS_RADIUS_M) continue; // open ground — no pull
				gx[i] += 2 * W_MAP * (p[i].x - q.x);
				gy[i] += 2 * W_MAP * (p[i].y - q.y);
			}
		}

		// Adam step.
		for (let i = 0; i < n; i++) {
			mx[i] = b1 * mx[i] + (1 - b1) * gx[i];
			my[i] = b1 * my[i] + (1 - b1) * gy[i];
			vx[i] = b2 * vx[i] + (1 - b2) * gx[i] * gx[i];
			vy[i] = b2 * vy[i] + (1 - b2) * gy[i] * gy[i];
			const mhx = mx[i] / (1 - b1 ** iter);
			const mhy = my[i] / (1 - b1 ** iter);
			const vhx = vx[i] / (1 - b2 ** iter);
			const vhy = vy[i] / (1 - b2 ** iter);
			p[i].x -= (lr * mhx) / (Math.sqrt(vhx) + eps);
			p[i].y -= (lr * mhy) / (Math.sqrt(vhy) + eps);
		}
	}

	// Posterior σ: 1/sqrt(information pinning each vertex). Information = GPS
	// (robust-weighted) + anchor + map + smoothness coupling. A vertex held only
	// by a poor fix is reported uncertain; one near an anchor / good fix, tight.
	// Posterior σ from the ABSOLUTE-position terms that actually pin a vertex —
	// GPS (robust-weighted), anchor, map. Smoothness only correlates neighbours;
	// it transfers information but doesn't independently fix a position, so it is
	// deliberately excluded. The result: σ ≈ the accuracy that pinned the vertex
	// — a good fix reports ~its accuracy, a flung 200 m outlier reports large
	// (we *inferred* its position from neighbours; our confidence in it is low).
	const MAX_SIGMA_M = 250;
	const path: SmoothVertex[] = p.map((v, i) => {
		const rx = v.x - z[i].x;
		const ry = v.y - z[i].y;
		const r = Math.hypot(rx, ry) / sig[i];
		const wGps = r <= HUBER_DELTA ? 1 : HUBER_DELTA / r;
		let info = wGps * invSig2[i];
		if ((i === 0 && anchorA) || (i === n - 1 && anchorB)) info += W_ANCHOR;
		if (opts.walkable && opts.walkable.ways.length > 0) {
			if (inBuilding(v, opts.walkable.buildings, frame)) {
				info += W_BUILDING;
			} else if (!inOpenZone(v, opts.walkable.openZones, frame)) {
				const q = nearestWalkable(v, opts.walkable.ways, frame);
				if (q && Math.hypot(v.x - q.x, v.y - q.y) <= OPENNESS_RADIUS_M) info += W_MAP;
			}
		}
		const sigmaM = Math.min(MAX_SIGMA_M, 1 / Math.sqrt(Math.max(info, 1 / (MAX_SIGMA_M * MAX_SIGMA_M))));
		return { ...frame.toLatLon(v), ts: sorted[i].ts, sigmaM: Math.round(sigmaM * 10) / 10 };
	});
	return { path };
}
