import {
	Component,
	computed,
	effect,
	type ElementRef,
	inject,
	input,
	NgZone,
	type OnDestroy,
	signal,
	viewChild,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatCheckboxModule } from "@angular/material/checkbox";
import * as L from "leaflet";
import type { LatestFix, VelocityData, VelocityPoint } from "../../services/health.service";

/** Track colour per transport mode — distinct hues from the app
 *  palette, so a glance at the line shows how the day was travelled. */
const MODE_COLORS: Record<string, string> = {
	walking: "#22c55e",
	cycling: "#f59e0b",
	driving: "#ef4444",
	bus: "#ea580c",
	train: "#3b82f6",
	plane: "#8b5cf6",
	stationary: "#94a3b8",
};
const DEFAULT_COLOR = "#94a3b8";

/** A vertex of the rendered track: a position, the mode it belongs to
 *  (used to colour the polyline), and whether it is an *inferred*
 *  vertex — a train run drawn on the OSM rail track rather than from
 *  measured GPS fixes. Inferred runs are drawn dashed. */
interface DisplayPoint {
	lat: number;
	lon: number;
	mode: string;
	snapped: boolean;
}

function equirectMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Drop lone teleport spikes from a moving segment's fixes — display
 * only; the underlying data keeps every fix. A point juts out and back
 * when the detour through it (prev→point→next) is both several times
 * longer than going straight past it AND a large absolute excess. A
 * gentle path curve or a sharp corner stays well under that bar.
 */
function rejectSpikes(pts: VelocityPoint[]): VelocityPoint[] {
	if (pts.length < 3) return pts;
	const keep: VelocityPoint[] = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = keep[keep.length - 1];
		const cur = pts[i];
		const next = pts[i + 1];
		const direct = equirectMeters(prev.lat, prev.lon, next.lat, next.lon);
		const through =
			equirectMeters(prev.lat, prev.lon, cur.lat, cur.lon) + equirectMeters(cur.lat, cur.lon, next.lat, next.lon);
		if (through > direct * 3 && through - direct > 500) continue;
		keep.push(cur);
	}
	keep.push(pts[pts.length - 1]);
	return keep;
}

/**
 * Map tab — the day's GPS track on an OpenStreetMap basemap.
 *
 * The map draws a *display* track derived from the classified
 * segments, not the raw fix cloud: a stationary segment collapses to a
 * single vertex (its centroid); a moving segment contributes its path
 * with lone teleport spikes dropped. Every raw fix stays in the data —
 * this only changes what is drawn.
 *
 * The `liveFix` input carries the most recent PhoneTrack fix — polled
 * and cached by the dashboard, which outlives this component (the Map
 * tab is lazily torn down and rebuilt on every visit). When set, it
 * drives the emphasised "current position" marker. The map view is
 * fitted once per day; with the follow toggle on it instead recentres
 * on each new fix.
 *
 * Leaflet owns its container's DOM and registers its own pan/zoom
 * listeners, so the map is created and driven outside Angular's zone.
 */
@Component({
	selector: "app-map",
	standalone: true,
	imports: [MatCardModule, MatCheckboxModule],
	templateUrl: "./map.component.html",
	styleUrl: "./map.component.scss",
})
export class MapComponent implements OnDestroy {
	readonly data = input<VelocityData | null>(null);
	/** True when the displayed day is today — live updates apply, so
	 *  the follow toggle is meaningful. */
	readonly live = input<boolean>(false);
	/** Most recent PhoneTrack fix, supplied by the dashboard (which
	 *  owns the polling + caching). Drives the live "current position"
	 *  marker. */
	readonly liveFix = input<LatestFix | null>(null);
	readonly mapRef = viewChild<ElementRef<HTMLDivElement>>("map");

	/** When checked, recentre the map on the live marker as each new
	 *  fix arrives. Off by default — auto-panning is opt-in so it never
	 *  yanks the view from under someone reading the map. */
	readonly follow = signal(false);

	/** Wall-clock time of the current position — the live fix if
	 *  polling, else the last fix of the displayed day. */
	readonly lastSeen = computed(() => {
		const ts = this.liveFix()?.ts ?? this.data()?.points?.at(-1)?.ts;
		if (ts === undefined) return "";
		return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	});

	private readonly zone = inject(NgZone);
	private map: L.Map | null = null;
	private layer: L.LayerGroup | null = null;
	private resizeObs: ResizeObserver | null = null;
	private recenterControl: L.Control | null = null;
	/** Latest position the recentre control should jump to. */
	private currentPos: { lat: number; lon: number } | null = null;
	/** The `data` reference the view was last fitted to — guards against
	 *  re-fitting (and yanking the view) on every 15s poll. */
	private fittedTo: VelocityData | null | undefined = undefined;

	constructor() {
		// Redraw when the day's data or the live fix changes.
		effect(() => {
			const data = this.data();
			const fix = this.liveFix();
			const el = this.mapRef();
			if (!el) return;
			this.zone.runOutsideAngular(() => this.render(el.nativeElement, data, fix));
		});
	}

	ngOnDestroy(): void {
		this.resizeObs?.disconnect();
		this.map?.remove();
	}

	/** A Leaflet corner control that recentres the map on the current
	 *  position — the one-shot counterpart to the follow toggle. Zooms
	 *  in to at least street level if currently zoomed further out. */
	private buildRecenterControl(map: L.Map): L.Control {
		const control = new L.Control({ position: "topright" });
		control.onAdd = (): HTMLElement => {
			const container = L.DomUtil.create("div", "leaflet-bar");
			const btn = L.DomUtil.create("a", "", container) as HTMLAnchorElement;
			btn.href = "#";
			btn.title = "Centre on current location";
			btn.setAttribute("role", "button");
			btn.setAttribute("aria-label", "Centre on current location");
			btn.textContent = "◎";
			L.DomEvent.on(btn, "click", L.DomEvent.stop);
			L.DomEvent.on(btn, "click", () => {
				const p = this.currentPos;
				if (p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
			});
			return container;
		};
		return control;
	}

	private render(el: HTMLElement, data: VelocityData | null, fix: LatestFix | null): void {
		let map = this.map;
		let layer = this.layer;
		if (!map || !layer) {
			map = L.map(el, { attributionControl: true });
			L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
				maxZoom: 19,
				attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
			}).addTo(map);
			layer = L.layerGroup().addTo(map);
			// The container can resize after the mat-tab transition
			// settles; re-measure so tiles and bounds use the real size.
			this.resizeObs = new ResizeObserver(() => this.map?.invalidateSize());
			this.resizeObs.observe(el);
			this.map = map;
			this.layer = layer;
		}
		layer.clearLayers();

		const points = data?.points ?? [];
		const segments = data?.segments ?? [];

		// Build the display track from the classified segments.
		const track: DisplayPoint[] = [];
		for (const seg of segments) {
			const mode = seg.refinedMode ?? seg.mode;
			// A train run that snapped to the rail network carries a
			// snappedPath — the journey drawn on the OSM track. Render
			// that inferred geometry in place of the raw zigzag. It can
			// span a GPS-dark window with no points of its own, so this
			// branch comes before the inSeg emptiness check.
			if (mode === "train" && seg.snappedPath && seg.snappedPath.length >= 2) {
				for (const p of seg.snappedPath) track.push({ lat: p.lat, lon: p.lon, mode, snapped: true });
				continue;
			}
			const inSeg = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (inSeg.length === 0) continue;
			if (mode === "stationary") {
				const lat = inSeg.reduce((a, p) => a + p.lat, 0) / inSeg.length;
				const lon = inSeg.reduce((a, p) => a + p.lon, 0) / inSeg.length;
				track.push({ lat, lon, mode, snapped: false });
			} else {
				for (const p of rejectSpikes(inSeg)) track.push({ lat: p.lat, lon: p.lon, mode, snapped: false });
			}
		}

		// One polyline per consecutive run of the same mode AND the same
		// measured/inferred kind; each run reaches back to the previous
		// run's last point so the line stays continuous across the
		// change. Inferred (snapped) runs are drawn dashed.
		let runStart = 0;
		for (let i = 1; i <= track.length; i++) {
			if (i < track.length && track[i].mode === track[runStart].mode && track[i].snapped === track[runStart].snapped) {
				continue;
			}
			const from = runStart > 0 ? runStart - 1 : runStart;
			L.polyline(track.slice(from, i).map((d) => [d.lat, d.lon] as L.LatLngTuple), {
				color: MODE_COLORS[track[runStart].mode] ?? DEFAULT_COLOR,
				weight: 4,
				opacity: 0.9,
				...(track[runStart].snapped ? { dashArray: "6 6" } : {}),
			}).addTo(layer);
			runStart = i;
		}

		// A marker at each named stay, at the centroid of its fixes.
		for (const s of segments) {
			if ((s.refinedMode ?? s.mode) !== "stationary" || !s.place) continue;
			const inSeg = points.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
			if (inSeg.length === 0) continue;
			const lat = inSeg.reduce((a, p) => a + p.lat, 0) / inSeg.length;
			const lon = inSeg.reduce((a, p) => a + p.lon, 0) / inSeg.length;
			L.circleMarker([lat, lon], {
				radius: 6,
				color: "#ffffff",
				weight: 2,
				fillColor: MODE_COLORS["stationary"],
				fillOpacity: 1,
			})
				.bindPopup(s.place)
				.addTo(layer);
		}

		// The live fix runs ahead of the classified track — the day's
		// segments only catch up once classification re-runs. Join the
		// track's last point to the live marker with a dashed connector
		// so the marker isn't drawn floating, detached from the path.
		const tail = track.at(-1);
		if (fix && tail) {
			L.polyline(
				[
					[tail.lat, tail.lon],
					[fix.lat, fix.lon],
				],
				{ color: "#7c3aed", weight: 3, opacity: 0.7, dashArray: "4 6" },
			).addTo(layer);
		}

		// Current position — the live fix when polling, else the day's
		// last track point. Emphasised: this is the "where are they
		// now" marker the tab exists for.
		const pos = fix ?? track.at(-1) ?? null;
		if (pos) {
			L.circleMarker([pos.lat, pos.lon], {
				radius: 9,
				color: "#ffffff",
				weight: 3,
				fillColor: "#7c3aed",
				fillOpacity: 1,
			})
				.bindPopup(`Last seen ${this.lastSeen()}`)
				.addTo(layer);
		}

		// Corner "recentre" control — a one-shot jump to the current
		// position, the manual counterpart to the follow toggle. Shown
		// only while there is a position to jump to.
		this.currentPos = pos;
		if (pos && !this.recenterControl) {
			this.recenterControl = this.buildRecenterControl(map);
			this.recenterControl.addTo(map);
		} else if (!pos && this.recenterControl) {
			this.recenterControl.remove();
			this.recenterControl = null;
		}

		// View placement. In follow mode, recentre on the live marker as
		// each fix arrives (zoom untouched, so the viewer keeps the zoom
		// they chose). Otherwise fit the day's track once — never on a
		// mere poll, which would keep yanking the map while panning.
		// `haveView` guards the very first render: panTo needs a map that
		// already has a view, so the first placement always goes through
		// the fit branch below.
		const haveView = this.fittedTo !== undefined;
		if (this.follow() && fix && haveView) {
			map.panTo([fix.lat, fix.lon], { animate: true });
			this.fittedTo = data;
		} else if (data !== this.fittedTo) {
			this.fittedTo = data;
			const bounds = track.map((d) => [d.lat, d.lon] as L.LatLngTuple);
			if (bounds.length > 0) {
				map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24] });
			} else if (pos) {
				map.setView([pos.lat, pos.lon], 14);
			} else {
				map.setView([51.505, -0.12], 11);
			}
		}
	}
}
