import {
	Component,
	computed,
	effect,
	type ElementRef,
	inject,
	input,
	NgZone,
	type OnDestroy,
	viewChild,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import * as L from "leaflet";
import type { VelocityData, VelocityPoint } from "../../services/health.service";

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
 * Map tab — the day's GPS track drawn on an OpenStreetMap basemap.
 *
 * The map draws a *display* track derived from the classified
 * segments, not the raw fix cloud: a stationary segment collapses to a
 * single vertex (its centroid), so hours of GPS jitter at a stay
 * become one clean point; a moving segment contributes its path with
 * lone teleport spikes dropped. Every raw fix stays in the data and in
 * classification — this only changes what is drawn.
 *
 * Each named stay gets a marker; the most recent position is the
 * emphasised marker — that "where are they now" point is the purpose
 * of the tab.
 *
 * Leaflet owns its container's DOM and registers its own pan/zoom
 * listeners, so the map is created and driven outside Angular's zone.
 */
@Component({
	selector: "app-map",
	standalone: true,
	imports: [MatCardModule],
	templateUrl: "./map.component.html",
	styleUrl: "./map.component.scss",
})
export class MapComponent implements OnDestroy {
	readonly data = input<VelocityData | null>(null);
	readonly mapRef = viewChild<ElementRef<HTMLDivElement>>("map");

	/** Wall-clock time of the most recent fix — empty when the day has
	 *  no location data. */
	readonly lastSeen = computed(() => {
		const pts = this.data()?.points;
		if (!pts || pts.length === 0) return "";
		return new Date(pts[pts.length - 1].ts * 1000).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
		});
	});

	private readonly zone = inject(NgZone);
	private map: L.Map | null = null;
	private trackLayer: L.LayerGroup | null = null;
	private resizeObs: ResizeObserver | null = null;

	constructor() {
		effect(() => {
			const data = this.data();
			const el = this.mapRef();
			if (!el) return;
			this.zone.runOutsideAngular(() => this.render(el.nativeElement, data));
		});
	}

	ngOnDestroy(): void {
		this.resizeObs?.disconnect();
		this.map?.remove();
	}

	private render(el: HTMLElement, data: VelocityData | null): void {
		let map = this.map;
		let layer = this.trackLayer;
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
			this.trackLayer = layer;
		}
		layer.clearLayers();

		const points = data?.points ?? [];
		const segments = data?.segments ?? [];
		if (points.length === 0) {
			map.setView([51.505, -0.12], 11);
			return;
		}

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
		if (track.length === 0) {
			map.setView([51.505, -0.12], 11);
			return;
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

		// The most recent position, emphasised — the "where are they
		// now" marker this tab exists for.
		const last = track[track.length - 1];
		L.circleMarker([last.lat, last.lon], {
			radius: 9,
			color: "#ffffff",
			weight: 3,
			fillColor: "#7c3aed",
			fillOpacity: 1,
		})
			.bindPopup(`Last seen ${this.lastSeen()}`)
			.addTo(layer);

		map.fitBounds(L.latLngBounds(track.map((d) => [d.lat, d.lon] as L.LatLngTuple)), {
			padding: [24, 24],
		});
	}
}
