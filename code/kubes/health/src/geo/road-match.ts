/**
 * Road map-matching — draw a road-vehicle leg on the streets it drove,
 * not as the raw GPS zigzag through the buildings between them.
 *
 * # Why this exists
 *
 * On the Map tab a driving / bus / taxi leg renders as the raw filtered
 * GPS polyline (`episode-geometry.ts`, `kind:"raw"`). Urban GPS scatters
 * tens of metres off the carriageway and corner fixes land inside the
 * block, so the drawn line cuts through buildings and short-cuts bends —
 * "I obviously didn't drive through that building." This module snaps the
 * leg onto the OSM road network so the drawn path follows real streets.
 *
 * # Approach: Newson-Krumm HMM map-matching
 *
 * Unlike `rail-snap` (which is station-anchored — fix positions there are
 * untrustworthy clumps and the geometry is driven by the board/alight
 * label) a road leg has no anchors, so it is genuinely fix-driven:
 *
 *   1. Build a routable graph from the road ways (vertices = way nodes,
 *      deduplicated by rounded coordinate so shared nodes connect ways;
 *      near-but-unshared nodes are gap-bridged).
 *   2. For each fix, the candidate road positions are its projections onto
 *      nearby road segments. Emission probability falls off with snap
 *      distance (Gaussian, σ = {@link SIGMA_Z}).
 *   3. The transition probability between a candidate at fix t and one at
 *      fix t+1 rewards an on-road route distance close to the straight-line
 *      distance the GPS actually moved (Newson-Krumm's |route − gps|
 *      exponential, scale {@link BETA}). A candidate pairing that would
 *      require an implausible detour is rejected.
 *   4. Viterbi picks the single most likely candidate per fix; the path is
 *      reconstructed by routing along the network between consecutive
 *      chosen candidates, then time-interpolated across the fix window.
 *
 * # Honest fallback
 *
 * Like rail-snap, a `null` return means "draw the raw fixes" — never a
 * degenerate or confidently-wrong path. It bails when the leg is too short
 * to match, too far off the road network, disconnected, or when the match
 * would be a wildly longer detour than the raw track (a routing blunder).
 *
 * Pure and self-contained: takes a geometry bundle, needs no DB or network,
 * so it is deterministic and unit-testable. Production supplies the road
 * ways from the same `osm_lines` mirror the route graph reads; tests supply
 * synthetic ways.
 */

/** A drivable road way from the OSM mirror. `coords` is an ordered
 *  `[lat, lon]` polyline; `subtype` is the OSM `highway` value. */
export interface OsmRoadWay {
	osmId: number;
	name: string | null;
	subtype: string | null;
	coords: Array<[number, number]>;
}

/** The road network the matcher works against — a self-contained bundle,
 *  so the algorithm needs neither DB nor network. The caller filters to
 *  drivable highway subtypes (see `DRIVABLE_HIGHWAY_SUBTYPES`). */
export interface RoadGeometry {
	ways: OsmRoadWay[];
}

/** One GPS fix to map-match. */
export interface RoadFix {
	lat: number;
	lon: number;
	ts: number;
}

/** One vertex of the matched path, with an interpolated timestamp. */
export interface MatchedPoint {
	lat: number;
	lon: number;
	ts: number;
}

export interface RoadMatchResult {
	/** The leg routed onto the streets, time-interpolated across the window. */
	path: MatchedPoint[];
}

export interface RoadMatchOpts {
	/** Max snap distance (m) for a fix to a road segment to be a candidate. */
	matchRadiusM?: number;
}

/** Below this many fixes the leg is too short to map-match usefully — the
 *  map draws the raw track instead. */
const MIN_FIXES = 3;

/** Candidate snap radius (m). Urban driving GPS sits this far off the
 *  carriageway; beyond it a road is not a plausible source for the fix. */
const DEFAULT_MATCH_RADIUS_M = 50;

/** Most candidate roads considered per fix — the K nearest. Keeps Viterbi
 *  at O(F·K²) and stops a dense junction exploding the candidate set. */
const MAX_CANDIDATES_PER_FIX = 5;

/** Emission falloff (m): snap-distance standard deviation in the Gaussian
 *  emission `exp(-½(dist/σ)²)`. Newson-Krumm fit σ≈4.07 m to clean GPS; we
 *  use a looser value because these fixes are already Kalman-smoothed and
 *  the urban error is larger. */
const SIGMA_Z = 12;

/** Transition falloff (m): scale in `exp(-|routeDist − gpsStep|/β)`. A
 *  candidate pairing whose on-road distance matches the straight-line GPS
 *  step is unpenalised; a detour is discounted with this length scale. */
const BETA = 10;

/** Two road vertices within this distance (m) but not sharing an OSM node
 *  are bridged with an edge — OSM ways often fail to share a node at
 *  junctions and tile borders, which would spuriously disconnect the road
 *  graph. Mirrors rail-snap's `GAP_BRIDGE_M`. */
const GAP_BRIDGE_M = 8;

/** Coordinate decimal places for keying graph vertices (~1 cm), so a node
 *  shared by two ways collapses to one vertex without merging distinct
 *  nodes. Mirrors rail-snap's `VERTEX_DP`. */
const VERTEX_DP = 7;

/** A transition's on-road route search is abandoned past
 *  `gpsStep · DETOUR_FACTOR + DETOUR_SLACK_M`; beyond that the pairing is
 *  an implausible detour and gets `-Infinity`. Bounds each Dijkstra to a
 *  local neighbourhood rather than the whole city graph. */
const DETOUR_FACTOR = 4;
const DETOUR_SLACK_M = 250;

/** If the matched path is longer than `rawLen · MAX_LEN_FACTOR +
 *  MAX_LEN_SLACK_M` the match looped the long way round — bail to raw. */
const MAX_LEN_FACTOR = 1.8;
const MAX_LEN_SLACK_M = 200;

/** A fix with no candidate road is dropped from the match; if more than
 *  this fraction of fixes are roadless the leg isn't really on the network
 *  — bail rather than match a sparse subset. */
const MAX_ROADLESS_FRACTION = 0.4;

/** Corridor penalty (the rail-snap fix `road-match` originally shipped
 *  without). An edge within {@link CORRIDOR_NEAR_M} of the GPS track the
 *  leg actually traced routes unpenalised; beyond {@link CORRIDOR_FAR_M} it
 *  carries the full {@link CORRIDOR_MAX_PENALTY} multiplier; it ramps
 *  linearly between. This is what stops the router shortcutting down a side
 *  street the GPS never approached — a plain shortest-distance route happily
 *  invents such a detour because no term pulls it back onto the track. NEAR
 *  is sized to absorb urban GPS error; FAR is the "this road is clearly off
 *  the driven corridor" bar. */
const CORRIDOR_NEAR_M = 25;
const CORRIDOR_FAR_M = 80;
const CORRIDOR_MAX_PENALTY = 40;

/** Road-continuity (turn) penalty, in nats, applied to a Viterbi transition
 *  whose two fixes snap to differently-named roads. A genuine turn pays it
 *  once; a lone GPS fix that jumps onto a side street and back pays it twice
 *  (in and out), so a single scattered fix can no longer drag the route off
 *  the road its neighbours are on. Sized to outweigh the emission gain of a
 *  ~40 m-off lone fix (~5–9 nats over two switches) without blocking a real
 *  turn (one switch, demanded by far-off fixes). */
const ROAD_SWITCH_PENALTY = 5;

/** Douglas-Peucker tolerance (m) for simplifying the final matched polyline.
 *  The route emits every OSM way vertex, so it zig-zags across junction
 *  geometry even while staying within metres of the track; simplifying at
 *  this tolerance drops that visual noise while preserving real corners
 *  (which deviate far more than this from a straight chord). */
const SIMPLIFY_TOLERANCE_M = 12;

interface Pt {
	lat: number;
	lon: number;
}

/**
 * The GPS track the leg actually traced — the ordered fixes as a polyline.
 * Used to penalise routing that strays from where the phone really was:
 * `distTo` is the perpendicular distance from a point to the nearest track
 * segment, `penalty` ramps that into the Dijkstra edge-weight multiplier.
 *
 * The track (not the individual fix points) is the corridor on purpose: a
 * through-road threaded by fixes 100-400 m apart stays within a few tens of
 * metres of the straight segments joining them, while a branching side
 * street leaves that line — so distance-to-track discriminates them even
 * when the fixes are sparse, which distance-to-nearest-fix would not.
 */
class TrackCorridor {
	private readonly pts: Pt[];
	constructor(fixes: ReadonlyArray<{ lat: number; lon: number }>) {
		this.pts = fixes.map((f) => ({ lat: f.lat, lon: f.lon }));
	}
	distTo(lat: number, lon: number): number {
		if (this.pts.length === 0) return 0;
		if (this.pts.length === 1) return metersBetween(lat, lon, this.pts[0].lat, this.pts[0].lon);
		let best = Number.POSITIVE_INFINITY;
		for (let i = 1; i < this.pts.length; i++) {
			const d = projectPointToSegment({ lat, lon }, this.pts[i - 1], this.pts[i]).distM;
			if (d < best) best = d;
		}
		return best;
	}
	penalty(distM: number): number {
		if (distM <= CORRIDOR_NEAR_M) return 1;
		if (distM >= CORRIDOR_FAR_M) return CORRIDOR_MAX_PENALTY;
		return 1 + (CORRIDOR_MAX_PENALTY - 1) * ((distM - CORRIDOR_NEAR_M) / (CORRIDOR_FAR_M - CORRIDOR_NEAR_M));
	}
	/** Penalised weight of a graph edge: its metric length times the
	 *  corridor penalty at its midpoint. Dijkstra minimises this. */
	edgeWeight(aLat: number, aLon: number, bLat: number, bLon: number): number {
		const len = metersBetween(aLat, aLon, bLat, bLon);
		return len * this.penalty(this.distTo((aLat + bLat) / 2, (aLon + bLon) / 2));
	}
}

/** Equirectangular metres between two lat/lon points — accurate enough at
 *  the city scale this module operates on. */
function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Project a point onto a segment, returning the foot of the perpendicular
 * (clamped to the segment), its fractional position `t ∈ [0,1]` from `a` to
 * `b`, and the perpendicular distance in metres. Works in a local
 * equirectangular frame around the segment.
 */
export function projectPointToSegment(p: Pt, a: Pt, b: Pt): { lat: number; lon: number; t: number; distM: number } {
	const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const ax = 0;
	const ay = 0;
	const bx = (b.lon - a.lon) * 111_320 * cosLat;
	const by = (b.lat - a.lat) * 111_320;
	const px = (p.lon - a.lon) * 111_320 * cosLat;
	const py = (p.lat - a.lat) * 111_320;
	const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
	let t = len2 === 0 ? 0 : ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2;
	t = Math.max(0, Math.min(1, t));
	const lat = a.lat + t * (b.lat - a.lat);
	const lon = a.lon + t * (b.lon - a.lon);
	const distM = metersBetween(p.lat, p.lon, lat, lon);
	return { lat, lon, t, distM };
}

/** Drivable highway subtypes — duplicated from `rail-road-proximity.ts`'s
 *  `DRIVABLE_HIGHWAY_SUBTYPES` deliberately to keep this module
 *  dependency-free and self-contained; the caller filters with the shared
 *  set when building the bundle. Kept here only for documentation. */

interface RoadSegment {
	u: number; // graph vertex id of coords[i-1]
	v: number; // graph vertex id of coords[i]
	lengthM: number;
	/** Name of the OSM way this segment belongs to — the road-continuity
	 *  prior compares consecutive fixes' road names (a road keeps its name
	 *  across its many OSM ways; a turn onto a side street changes it). */
	wayName: string | null;
}

interface RoadGraph {
	vertices: Pt[];
	adj: Array<Array<{ to: number; w: number }>>;
	/** Real road segments (way edges) — the candidate-projection surface.
	 *  Excludes gap-bridge edges, which are graph connectivity only. */
	segments: RoadSegment[];
}

/**
 * Build a routable, undirected graph from the road ways. Vertices are way
 * nodes deduplicated by rounded coordinate (shared nodes connect ways);
 * edges are consecutive node pairs within a way plus gap-bridge edges
 * between nearby vertices of different ways.
 */
function buildRoadGraph(ways: readonly OsmRoadWay[], corridor: TrackCorridor): RoadGraph {
	const vertices: Pt[] = [];
	const adj: Array<Array<{ to: number; w: number }>> = [];
	const segments: RoadSegment[] = [];
	const idByKey = new Map<string, number>();

	const vertexId = (lat: number, lon: number): number => {
		const key = `${lat.toFixed(VERTEX_DP)},${lon.toFixed(VERTEX_DP)}`;
		let id = idByKey.get(key);
		if (id === undefined) {
			id = vertices.length;
			idByKey.set(key, id);
			vertices.push({ lat, lon });
			adj.push([]);
		}
		return id;
	};
	const addEdge = (a: number, b: number, w: number): void => {
		if (a === b) return;
		adj[a].push({ to: b, w });
		adj[b].push({ to: a, w });
	};

	for (const way of ways) {
		let prev = -1;
		let prevLat = 0;
		let prevLon = 0;
		for (const [lat, lon] of way.coords) {
			const id = vertexId(lat, lon);
			if (prev >= 0 && id !== prev) {
				// Edge weight is corridor-penalised (routing cost); the segment's
				// `lengthM` is the raw metric length (candidate offsets + the
				// physical route length reported to the transition model).
				addEdge(prev, id, corridor.edgeWeight(prevLat, prevLon, lat, lon));
				segments.push({ u: prev, v: id, lengthM: metersBetween(prevLat, prevLon, lat, lon), wayName: way.name });
			}
			prev = id;
			prevLat = lat;
			prevLon = lon;
		}
	}

	bridgeGaps(vertices, adj, corridor);
	return { vertices, adj, segments };
}

/** Add edges between vertices of different ways within {@link GAP_BRIDGE_M}
 *  that do not share an OSM node. Candidate pairs come from a coarse grid
 *  hash so this stays linear in vertex count. Mirrors rail-snap. */
function bridgeGaps(vertices: Pt[], adj: Array<Array<{ to: number; w: number }>>, corridor: TrackCorridor): void {
	if (vertices.length === 0) return;
	const cellLat = GAP_BRIDGE_M / 111_320;
	const midLat = vertices[0].lat;
	const cellLon = GAP_BRIDGE_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
	const buckets = new Map<string, number[]>();
	for (let i = 0; i < vertices.length; i++) {
		const key = `${Math.floor(vertices[i].lat / cellLat)},${Math.floor(vertices[i].lon / cellLon)}`;
		const b = buckets.get(key);
		if (b) b.push(i);
		else buckets.set(key, [i]);
	}
	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		const baseLat = Math.floor(v.lat / cellLat);
		const baseLon = Math.floor(v.lon / cellLon);
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = buckets.get(`${baseLat + dLat},${baseLon + dLon}`);
				if (!b) continue;
				for (const j of b) {
					if (j <= i) continue;
					const gap = metersBetween(v.lat, v.lon, vertices[j].lat, vertices[j].lon);
					if (gap > GAP_BRIDGE_M) continue;
					if (adj[i].some((e) => e.to === j)) continue;
					const w = corridor.edgeWeight(v.lat, v.lon, vertices[j].lat, vertices[j].lon);
					adj[i].push({ to: j, w });
					adj[j].push({ to: i, w });
				}
			}
		}
	}
}

/** A grid index over road segments for fast nearby-segment queries. Each
 *  segment is rasterised into every cell its polyline passes through (not
 *  just its endpoints) — a long way's segment would otherwise be missed for
 *  a fix near its middle, since the cell is only the match radius wide. With
 *  rasterisation the 3×3 neighbourhood of a fix contains every segment whose
 *  nearest point is within the match radius. */
class SegmentIndex {
	private readonly cellLat: number;
	private readonly cellLon: number;
	private readonly buckets = new Map<string, number[]>();

	constructor(vertices: readonly Pt[], segments: readonly RoadSegment[], cellM: number, refLat: number) {
		this.cellLat = cellM / 111_320;
		this.cellLon = cellM / (111_320 * Math.cos((refLat * Math.PI) / 180));
		for (let i = 0; i < segments.length; i++) {
			const s = segments[i];
			const a = vertices[s.u];
			const b = vertices[s.v];
			// Walk the segment at half-cell spacing so every point on it is
			// within half a cell of a sample — guaranteeing a fix within the
			// match radius lands in the sample's 3×3 neighbourhood.
			const steps = Math.max(1, Math.ceil((s.lengthM * 2) / cellM));
			const seen = new Set<string>();
			for (let k = 0; k <= steps; k++) {
				const f = k / steps;
				const key = this.key(a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon));
				if (seen.has(key)) continue;
				seen.add(key);
				const bucket = this.buckets.get(key);
				if (bucket) bucket.push(i);
				else this.buckets.set(key, [i]);
			}
		}
	}

	private key(lat: number, lon: number): string {
		return `${Math.floor(lat / this.cellLat)},${Math.floor(lon / this.cellLon)}`;
	}

	/** Segment indices whose cell neighbourhood covers `(lat, lon)`. */
	near(lat: number, lon: number): number[] {
		const baseLat = Math.floor(lat / this.cellLat);
		const baseLon = Math.floor(lon / this.cellLon);
		const out = new Set<number>();
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = this.buckets.get(`${baseLat + dLat},${baseLon + dLon}`);
				if (b) for (const i of b) out.add(i);
			}
		}
		return [...out];
	}
}

/** A candidate road position for one fix: the projection onto a road
 *  segment, with the segment's endpoints and on-edge offset for routing. */
interface Candidate {
	lat: number;
	lon: number;
	distM: number;
	seg: RoadSegment;
	/** Fractional position from `seg.u` to `seg.v`. */
	t: number;
}

/** The `MAX_CANDIDATES_PER_FIX` nearest road projections within radius. */
function candidatesForFix(fix: RoadFix, graph: RoadGraph, index: SegmentIndex, radiusM: number): Candidate[] {
	const cands: Candidate[] = [];
	for (const si of index.near(fix.lat, fix.lon)) {
		const seg = graph.segments[si];
		const a = graph.vertices[seg.u];
		const b = graph.vertices[seg.v];
		const proj = projectPointToSegment(fix, a, b);
		if (proj.distM <= radiusM) cands.push({ lat: proj.lat, lon: proj.lon, distM: proj.distM, seg, t: proj.t });
	}
	cands.sort((p, q) => p.distM - q.distM);
	return cands.slice(0, MAX_CANDIDATES_PER_FIX);
}

/** A binary min-heap keyed on numeric priority — the Dijkstra queue.
 *  Mirrors rail-snap's `MinHeap`. */
class MinHeap {
	private readonly heap: Array<{ p: number; v: number }> = [];
	get size(): number {
		return this.heap.length;
	}
	push(p: number, v: number): void {
		const h = this.heap;
		h.push({ p, v });
		let i = h.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (h[parent].p <= h[i].p) break;
			[h[parent], h[i]] = [h[i], h[parent]];
			i = parent;
		}
	}
	pop(): { p: number; v: number } | undefined {
		const h = this.heap;
		const top = h[0];
		if (top === undefined) return undefined;
		const last = h.pop();
		if (last !== undefined && h.length > 0) {
			h[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = 2 * i + 2;
				let s = i;
				if (l < h.length && h[l].p < h[s].p) s = l;
				if (r < h.length && h[r].p < h[s].p) s = r;
				if (s === i) break;
				[h[s], h[i]] = [h[i], h[s]];
				i = s;
			}
		}
		return top;
	}
}

/** A radius-bounded Dijkstra from one source vertex. Returns `dist`/`prev`
 *  arrays; vertices past `maxRadiusM` are left unreached (`Infinity`), which
 *  keeps each search local rather than over the whole city graph. Memoised
 *  per source by the caller. */
function dijkstraFrom(graph: RoadGraph, source: number, maxRadiusM: number): { dist: Float64Array; prev: Int32Array } {
	const n = graph.vertices.length;
	const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const prev = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	dist[source] = 0;
	const heap = new MinHeap();
	heap.push(0, source);
	while (heap.size > 0) {
		const cur = heap.pop();
		if (cur === undefined) break;
		const u = cur.v;
		if (done[u]) continue;
		done[u] = 1;
		if (cur.p > maxRadiusM) break;
		for (const e of graph.adj[u]) {
			const nd = cur.p + e.w;
			if (nd < dist[e.to]) {
				dist[e.to] = nd;
				prev[e.to] = u;
				heap.push(nd, e.to);
			}
		}
	}
	return { dist, prev };
}

/** Memoised radius-bounded Dijkstra cache, scoped to one match run. */
class RouteCache {
	private readonly cache = new Map<number, { dist: Float64Array; prev: Int32Array }>();
	constructor(
		private readonly graph: RoadGraph,
		private readonly maxRadiusM: number,
	) {}
	from(source: number): { dist: Float64Array; prev: Int32Array } {
		let r = this.cache.get(source);
		if (r === undefined) {
			r = dijkstraFrom(this.graph, source, this.maxRadiusM);
			this.cache.set(source, r);
		}
		return r;
	}
}

/** The on-road route from candidate `a` to candidate `b`: its length (m)
 *  and the polyline from `a`'s projection to `b`'s projection. Considers the
 *  four endpoint combinations of the two segments (and the same-segment
 *  case) and returns the shortest feasible one, or null when no route is
 *  within the cache's radius. */
function routeBetween(
	a: Candidate,
	b: Candidate,
	graph: RoadGraph,
	cache: RouteCache,
): { distM: number; verts: Pt[] } | null {
	// Same road segment: travel straight along it.
	if (a.seg.u === b.seg.u && a.seg.v === b.seg.v) {
		const distM = Math.abs(b.t - a.t) * a.seg.lengthM;
		return {
			distM,
			verts: [
				{ lat: a.lat, lon: a.lon },
				{ lat: b.lat, lon: b.lon },
			],
		};
	}

	// Choose the endpoint combination by penalised routing COST (so the route
	// hugs the GPS corridor), but report the physical metric length — the
	// transition model compares it to the straight-line GPS step, which is
	// metric. `weighted` mixes the penalised Dijkstra distance with metric
	// on-segment offsets; the offsets are short partials on the candidates'
	// own segments (sat on the GPS track, penalty ≈ 1), so the approximation
	// is immaterial to which combination wins.
	let best: { weighted: number; verts: Pt[] } | null = null;
	const aEnds: Array<{ vid: number; offset: number }> = [
		{ vid: a.seg.u, offset: a.t * a.seg.lengthM },
		{ vid: a.seg.v, offset: (1 - a.t) * a.seg.lengthM },
	];
	const bEnds: Array<{ vid: number; offset: number }> = [
		{ vid: b.seg.u, offset: b.t * b.seg.lengthM },
		{ vid: b.seg.v, offset: (1 - b.t) * b.seg.lengthM },
	];
	for (const ae of aEnds) {
		const { dist, prev } = cache.from(ae.vid);
		for (const be of bEnds) {
			const mid = dist[be.vid];
			if (!Number.isFinite(mid)) continue;
			const weighted = ae.offset + mid + be.offset;
			if (best && weighted >= best.weighted) continue;
			// Reconstruct the vertex path ae.vid → be.vid.
			const idPath: number[] = [];
			for (let v = be.vid; v !== -1; v = prev[v]) idPath.push(v);
			idPath.reverse();
			if (idPath[0] !== ae.vid) continue; // unreached / disconnected
			const verts: Pt[] = [{ lat: a.lat, lon: a.lon }];
			for (const vid of idPath) verts.push(graph.vertices[vid]);
			verts.push({ lat: b.lat, lon: b.lon });
			best = { weighted, verts: dedupeConsecutive(verts) };
		}
	}
	return best ? { distM: pathLength(best.verts), verts: best.verts } : null;
}

/** Drop consecutive near-duplicate vertices (a projection that lands on a
 *  segment endpoint, the shared corner of two ways). */
function dedupeConsecutive(pts: readonly Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && metersBetween(last.lat, last.lon, p.lat, p.lon) < 0.5) continue;
		out.push(p);
	}
	return out;
}

/**
 * Douglas-Peucker simplification of a timestamped polyline: drop vertices
 * within {@link SIMPLIFY_TOLERANCE_M} of the line joining the retained
 * neighbours. Endpoints are always kept. Removes the junction zig-zag the
 * raw route emits (every OSM vertex) while preserving real corners, which
 * deviate far more than the tolerance from a straight chord. Retained
 * vertices keep their interpolated timestamps, so the result stays
 * monotonic and window-anchored.
 */
function simplifyPath(pts: readonly MatchedPoint[], toleranceM: number): MatchedPoint[] {
	if (pts.length <= 2) return [...pts];
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const seg = stack.pop();
		if (seg === undefined) break;
		const [a, b] = seg;
		let maxd = -1;
		let idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = projectPointToSegment(pts[i], pts[a], pts[b]).distM;
			if (d > maxd) {
				maxd = d;
				idx = i;
			}
		}
		if (maxd > toleranceM && idx > 0) {
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	const out: MatchedPoint[] = [];
	for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
	return out;
}

/** Polyline length in metres. */
function pathLength(pts: readonly Pt[]): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	return total;
}

/**
 * Map-match a road-vehicle leg onto the street network.
 *
 * Returns the leg routed onto the streets and time-interpolated across the
 * fix window — or null when it cannot be matched (too few fixes, fixes off
 * the network, a disconnected or implausibly-long route). A null result
 * means "draw the raw fixes"; this never returns a degenerate or
 * confidently-wrong path.
 */
export function matchRoadSegment(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	opts: RoadMatchOpts = {},
): RoadMatchResult | null {
	if (fixes.length < MIN_FIXES) return null;
	const radiusM = opts.matchRadiusM ?? DEFAULT_MATCH_RADIUS_M;

	// The GPS track is the routing corridor: edges are penalised by distance
	// from it, so the route follows the road the phone traced rather than the
	// geometrically-shortest path through any side street.
	const corridor = new TrackCorridor(fixes);
	const graph = buildRoadGraph(geo.ways, corridor);
	if (graph.segments.length === 0) return null;

	const index = new SegmentIndex(graph.vertices, graph.segments, radiusM, fixes[0].lat);

	// Per-fix candidates; drop fixes with none, bail if too many are roadless.
	const obs: Array<{ fix: RoadFix; cands: Candidate[] }> = [];
	let roadless = 0;
	for (const fix of fixes) {
		const cands = candidatesForFix(fix, graph, index, radiusM);
		if (cands.length === 0) roadless++;
		else obs.push({ fix, cands });
	}
	if (roadless / fixes.length > MAX_ROADLESS_FRACTION) return null;
	if (obs.length < MIN_FIXES) return null;

	// Detour bound for the Dijkstra radius: the longest single GPS step times
	// the detour factor. One cache for the whole run.
	let maxStep = 0;
	for (let i = 1; i < obs.length; i++) {
		const d = metersBetween(obs[i - 1].fix.lat, obs[i - 1].fix.lon, obs[i].fix.lat, obs[i].fix.lon);
		if (d > maxStep) maxStep = d;
	}
	// Dijkstra runs on corridor-PENALISED edge weights, so its accumulated
	// distance is up to CORRIDOR_MAX_PENALTY× the metric distance. Scale the
	// early-termination radius by that factor so a legitimate corridor route
	// is never cut for being "too long" in weighted units; implausible
	// detours are still rejected by the penalty itself and the final
	// length guard.
	const cache = new RouteCache(graph, (maxStep * DETOUR_FACTOR + DETOUR_SLACK_M) * CORRIDOR_MAX_PENALTY);

	// Viterbi. Score in log space; emission = −½(dist/σ)²,
	// transition = −|routeDist − gpsStep|/β (− detour penalty implicit in the
	// route length), infeasible routes pruned.
	const n = obs.length;
	const score: number[][] = [];
	const back: number[][] = [];
	// Cache the route geometry chosen for each (prev cand → cur cand) so the
	// reconstruction does not re-route.
	const routeOf: Array<Array<Array<{ distM: number; verts: Pt[] } | null>>> = [];

	score.push(obs[0].cands.map((c) => emission(c.distM)));
	back.push(obs[0].cands.map(() => -1));

	for (let t = 1; t < n; t++) {
		const prev = obs[t - 1];
		const cur = obs[t];
		const gpsStep = metersBetween(prev.fix.lat, prev.fix.lon, cur.fix.lat, cur.fix.lon);
		const row: number[] = [];
		const brow: number[] = [];
		const rmat: Array<Array<{ distM: number; verts: Pt[] } | null>> = [];
		for (let j = 0; j < cur.cands.length; j++) {
			let bestScore = Number.NEGATIVE_INFINITY;
			let bestPrev = -1;
			const rrow: Array<{ distM: number; verts: Pt[] } | null> = [];
			for (let i = 0; i < prev.cands.length; i++) {
				const route = routeBetween(prev.cands[i], cur.cands[j], graph, cache);
				rrow.push(route);
				if (route === null) continue;
				const trans = -Math.abs(route.distM - gpsStep) / BETA;
				// Road-continuity prior: discourage the matched road changing
				// name between consecutive fixes, so a lone scattered fix can't
				// pull the route onto a side street and back.
				const wa = prev.cands[i].seg.wayName;
				const wb = cur.cands[j].seg.wayName;
				const switchPen = wa && wb && wa !== wb ? ROAD_SWITCH_PENALTY : 0;
				const s = score[t - 1][i] + trans - switchPen + emission(cur.cands[j].distM);
				if (s > bestScore) {
					bestScore = s;
					bestPrev = i;
				}
			}
			row.push(bestScore);
			brow.push(bestPrev);
			rmat.push(rrow);
		}
		// A step where every transition was infeasible: the candidates can't
		// be linked on the road network — bail rather than draw a broken path.
		if (row.every((s) => !Number.isFinite(s))) return null;
		score.push(row);
		back.push(brow);
		routeOf.push(rmat);
	}

	// Backtrack from the best terminal candidate.
	let endJ = 0;
	let endBest = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < score[n - 1].length; j++) {
		if (score[n - 1][j] > endBest) {
			endBest = score[n - 1][j];
			endJ = j;
		}
	}
	if (!Number.isFinite(endBest)) return null;
	const chosen = new Int32Array(n);
	chosen[n - 1] = endJ;
	for (let t = n - 1; t > 0; t--) {
		const bp = back[t][chosen[t]];
		if (bp < 0) return null;
		chosen[t - 1] = bp;
	}

	// Reconstruct the routed polyline, anchoring each chosen projection to
	// its fix timestamp and interpolating the interior route vertices.
	const out: MatchedPoint[] = [];
	const first = obs[0].cands[chosen[0]];
	out.push({ lat: first.lat, lon: first.lon, ts: obs[0].fix.ts });
	for (let t = 1; t < n; t++) {
		const route = routeOf[t - 1][chosen[t]][chosen[t - 1]];
		if (route === null) return null;
		appendInterpolated(out, route.verts, obs[t - 1].fix.ts, obs[t].fix.ts);
	}

	const simplified = simplifyPath(out, SIMPLIFY_TOLERANCE_M);
	if (simplified.length < 2) return null;
	const matched = simplified.map((p) => ({ lat: p.lat, lon: p.lon }));
	const rawLen = pathLength(fixes.map((f) => ({ lat: f.lat, lon: f.lon })));
	if (pathLength(matched) > rawLen * MAX_LEN_FACTOR + MAX_LEN_SLACK_M) return null;

	return { path: simplified };
}

/** Gaussian emission log-likelihood for a snap distance. */
function emission(distM: number): number {
	const z = distM / SIGMA_Z;
	return -0.5 * z * z;
}

/**
 * Append a route segment's interior + end vertices to the output, dropping
 * the leading vertex (already present as the previous anchor) and assigning
 * timestamps by cumulative distance between `startTs` (the previous anchor)
 * and `endTs` (this fix). The final vertex lands exactly on `endTs`.
 */
function appendInterpolated(out: MatchedPoint[], verts: readonly Pt[], startTs: number, endTs: number): void {
	if (verts.length === 0) return;
	const cum: number[] = [0];
	for (let i = 1; i < verts.length; i++) {
		cum.push(cum[i - 1] + metersBetween(verts[i - 1].lat, verts[i - 1].lon, verts[i].lat, verts[i].lon));
	}
	const total = cum[cum.length - 1];
	// Skip i=0: it duplicates the previous anchor already in `out`.
	for (let i = 1; i < verts.length; i++) {
		const frac = total > 0 ? cum[i] / total : 1;
		out.push({ lat: verts[i].lat, lon: verts[i].lon, ts: Math.round(startTs + (endTs - startTs) * frac) });
	}
}
