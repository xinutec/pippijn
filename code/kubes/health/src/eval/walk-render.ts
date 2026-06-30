/**
 * Visual diff harness for pedestrian map-matching (#293). Renders each walk's
 * RAW GPS (where the phone actually was) against the MATCHED line (what the
 * snapper drew) as a grid of small SVG panels, so an out-and-back spur — the
 * matched line hooking away from the raw dots and back — is visible by eye.
 *
 * Geometry-only on purpose: the raw dots are the ground truth, so a matched
 * line that leaves them and returns is an invented detour with or without
 * street context. Pure (geometry → SVG string), no DB / tiles / deps.
 */
import type { LatLon } from "./walk-score.js";

export interface WalkPanel {
	label: string;
	/** Raw GPS fixes — the truth. */
	raw: LatLon[];
	/** The matched (snapped) line. */
	matched: LatLon[];
	/** The smoothed (walk-match-off) line, for reference. */
	smoothed: LatLon[];
	/** Triage metric (corridor stall, m) shown in the panel header. */
	stallM: number;
}

const m = (a: LatLon, b: LatLon): number => {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
};

/**
 * The longest run of `path` that travels far while its monotone projection onto
 * the time-ordered `fixes` polyline barely advances — an out-and-back that makes
 * no corridor progress. A triage signal only (confounded by genuine
 * there-and-back walks), used to sort the worst-looking panels to the top.
 */
export function maxCorridorStall(fixes: readonly LatLon[], path: readonly LatLon[], tolM = 15): number {
	if (path.length < 2 || fixes.length < 2) return 0;
	const fArc = [0];
	for (let i = 1; i < fixes.length; i++) fArc.push(fArc[i - 1] + m(fixes[i - 1], fixes[i]));
	const pArc = [0];
	for (let i = 1; i < path.length; i++) pArc.push(pArc[i - 1] + m(path[i - 1], path[i]));
	const cp: number[] = [];
	let minS = 0;
	for (const v of path) {
		let best = Number.POSITIVE_INFINITY;
		let bestS = minS;
		for (let i = 0; i < fixes.length - 1; i++) {
			const a = fixes[i];
			const b = fixes[i + 1];
			const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
			const bx = (b.lon - a.lon) * 111_320 * cosLat;
			const by = (b.lat - a.lat) * 111_320;
			const px = (v.lon - a.lon) * 111_320 * cosLat;
			const py = (v.lat - a.lat) * 111_320;
			const l2 = bx * bx + by * by || 1e-9;
			const t = Math.max(0, Math.min(1, (px * bx + py * by) / l2));
			const d = Math.hypot(px - t * bx, py - t * by);
			const s = fArc[i] + t * (fArc[i + 1] - fArc[i]);
			if (d < best && s >= minS - 1) {
				best = d;
				bestS = s;
			}
		}
		cp.push(bestS);
		minS = bestS;
	}
	let j = 0;
	let worst = 0;
	for (let k = 0; k < path.length; k++) {
		while (cp[k] - cp[j] > tolM) j++;
		worst = Math.max(worst, pArc[k] - pArc[j]);
	}
	return worst;
}

const PANEL = Number(process.env.WALK_RENDER_PANEL ?? 260);
const PAD = 26;
const COLS = Number(process.env.WALK_RENDER_COLS ?? 4);

/** Project a panel's points into its inner box, lat increasing upward. */
function makeProjector(pts: LatLon[]): (p: LatLon) => [number, number] {
	const lats = pts.map((p) => p.lat);
	const lons = pts.map((p) => p.lon);
	const minLat = Math.min(...lats);
	const maxLat = Math.max(...lats);
	const minLon = Math.min(...lons);
	const maxLon = Math.max(...lons);
	const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
	const w = Math.max((maxLon - minLon) * cosLat, 1e-6);
	const h = Math.max(maxLat - minLat, 1e-6);
	const inner = PANEL - 2 * PAD;
	const scale = Math.min(inner / w, inner / h);
	const offX = (inner - w * scale) / 2;
	const offY = (inner - h * scale) / 2;
	return (p: LatLon): [number, number] => [
		PAD + offX + (p.lon - minLon) * cosLat * scale,
		PAD + offY + (maxLat - p.lat) * scale, // flip y
	];
}

const polyline = (
	pts: LatLon[],
	proj: (p: LatLon) => [number, number],
	stroke: string,
	width: number,
	dash = "",
): string => {
	if (pts.length < 2) return "";
	const d = pts.map((p) => proj(p).join(",")).join(" ");
	return `<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
};

function renderPanel(panel: WalkPanel): string {
	const all = [...panel.raw, ...panel.matched, ...panel.smoothed];
	if (all.length === 0) return "";
	const proj = makeProjector(all);
	const dots = panel.raw.map((p) => {
		const [x, y] = proj(p);
		return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="#f59e0b" fill-opacity="0.9"/>`;
	});
	const flag = panel.stallM >= 80 ? "#ef4444" : panel.stallM >= 40 ? "#f59e0b" : "#94a3b8";
	return [
		`<rect x="1" y="1" width="${PANEL - 2}" height="${PANEL - 2}" fill="#0b0f17" stroke="#1e293b"/>`,
		// smoothed (reference), raw track, matched line, raw dots on top
		polyline(panel.smoothed, proj, "#475569", 1, "3 3"),
		polyline(panel.raw, proj, "#f59e0b", 1),
		polyline(panel.matched, proj, "#3b82f6", 2.2),
		dots.join(""),
		`<text x="8" y="16" font-family="sans-serif" font-size="11" fill="#e2e8f0">${panel.label}</text>`,
		`<text x="${PANEL - 8}" y="16" text-anchor="end" font-family="sans-serif" font-size="11" fill="${flag}">stall ${panel.stallM.toFixed(0)}m</text>`,
	].join("");
}

/** Compose all panels into one SVG (a grid), sorted worst-stall first. */
export function renderWalkGrid(panels: readonly WalkPanel[]): string {
	const sorted = [...panels].sort((a, b) => b.stallM - a.stallM);
	const rows = Math.ceil(sorted.length / COLS);
	const W = COLS * PANEL;
	const H = rows * PANEL + 40;
	const cells = sorted.map((panel, i) => {
		const x = (i % COLS) * PANEL;
		const y = 40 + Math.floor(i / COLS) * PANEL;
		return `<g transform="translate(${x},${y})">${renderPanel(panel)}</g>`;
	});
	const legend =
		'<text x="8" y="24" font-family="sans-serif" font-size="14" fill="#e2e8f0">' +
		'Walk match diff — <tspan fill="#f59e0b">raw GPS</tspan> vs <tspan fill="#3b82f6">matched</tspan> ' +
		'(<tspan fill="#475569">smoothed</tspan>); worst corridor-stall first</text>';
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#020617"/>${legend}${cells.join("")}</svg>`;
}
