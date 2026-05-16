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
import { HealthService, type LatestFix, type VelocityData, type VelocityPoint } from "../../services/health.service";

/** Track colour per transport mode — distinct hues from the app
 *  palette, so a glance at the line shows how the day was travelled. */
const MODE_COLORS: Record<string, string> = {
	walking: "#22c55e",
	cycling: "#f59e0b",
	driving: "#ef4444",
	train: "#3b82f6",
	plane: "#8b5cf6",
	stationary: "#94a3b8",
};
const DEFAULT_COLOR = "#94a3b8";

/** How often to poll for the latest fix while the live marker is on. */
const POLL_MS = 15_000;

/** A vertex of the rendered track: a position plus the mode it
 *  belongs to (used to colour the polyline). */
interface DisplayPoint {
	lat: number;
	lon: number;
	mode: string;
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
 * When `live` is set (the user is viewing today), the component polls
 * for the most recent PhoneTrack fix every {@link POLL_MS} ms and
 * keeps the emphasised "current position" marker on it — so a viewer
 * watches the marker move in near-real-time. The map view is fitted
 * once per day (not on every poll), so polling never yanks the view.
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
	/** True when the displayed day is today AND the Map tab is active —
	 *  poll for the latest fix and keep the marker live. */
	readonly live = input<boolean>(false);
	readonly mapRef = viewChild<ElementRef<HTMLDivElement>>("map");

	/** When checked, recentre the map on the live marker as each new
	 *  fix arrives. Off by default — auto-panning is opt-in so it never
	 *  yanks the view from under someone reading the map. */
	readonly follow = signal(false);

	/** Most recent fix from polling — null when not live or not yet
	 *  loaded. */
	private readonly liveFix = signal<LatestFix | null>(null);

	/** Wall-clock time of the current position — the live fix if
	 *  polling, else the last fix of the displayed day. */
	readonly lastSeen = computed(() => {
		const ts = this.liveFix()?.ts ?? this.data()?.points?.at(-1)?.ts;
		if (ts === undefined) return "";
		return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	});

	private readonly zone = inject(NgZone);
	private readonly health = inject(HealthService);
	private map: L.Map | null = null;
	private layer: L.LayerGroup | null = null;
	private resizeObs: ResizeObserver | null = null;
	/** The `data` reference the view was last fitted to — guards against
	 *  re-fitting (and yanking the view) on every 15s poll. */
	private fittedTo: VelocityData | null | undefined = undefined;

	constructor() {
		// Poll for the latest fix while live; stop and clear when not.
		effect((onCleanup) => {
			if (!this.live()) {
				this.liveFix.set(null);
				return;
			}
			const poll = (): void => {
				void this.health.getLatestFix().then((f) => this.liveFix.set(f));
			};
			poll();
			const id = setInterval(poll, POLL_MS);
			onCleanup(() => clearInterval(id));
		});

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
			const inSeg = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (inSeg.length === 0) continue;
			if (mode === "stationary") {
				const lat = inSeg.reduce((a, p) => a + p.lat, 0) / inSeg.length;
				const lon = inSeg.reduce((a, p) => a + p.lon, 0) / inSeg.length;
				track.push({ lat, lon, mode });
			} else {
				for (const p of rejectSpikes(inSeg)) track.push({ lat: p.lat, lon: p.lon, mode });
			}
		}

		// One polyline per consecutive same-mode run; each run reaches
		// back to the previous run's last point so the line is
		// continuous across mode changes.
		let runStart = 0;
		for (let i = 1; i <= track.length; i++) {
			if (i < track.length && track[i].mode === track[runStart].mode) continue;
			const from = runStart > 0 ? runStart - 1 : runStart;
			L.polyline(
				track.slice(from, i).map((d) => [d.lat, d.lon] as L.LatLngTuple),
				{ color: MODE_COLORS[track[runStart].mode] ?? DEFAULT_COLOR, weight: 4, opacity: 0.9 },
			).addTo(layer);
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
