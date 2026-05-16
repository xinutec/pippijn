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
import type { VelocityData } from "../../services/health.service";

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

/**
 * Map tab — the day's GPS track drawn on an OpenStreetMap basemap.
 *
 * The track is one polyline per maximal run of consecutive same-mode
 * fixes, coloured by mode; named stays get a marker at their centroid;
 * the most recent fix is emphasised — that "where are they now" marker
 * is the point of the tab.
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
		if (points.length === 0) {
			map.setView([51.505, -0.12], 11);
			return;
		}

		const segments = data?.segments ?? [];
		const modeAt = (ts: number): string => {
			for (const s of segments) {
				if (ts >= s.startTs && ts <= s.endTs) return s.refinedMode ?? s.mode;
			}
			return "stationary";
		};

		// One polyline per maximal run of consecutive same-mode fixes,
		// each run extended to the next run's first point so the line
		// stays continuous across mode changes.
		let i = 0;
		while (i < points.length - 1) {
			const mode = modeAt(points[i].ts);
			let j = i;
			while (j < points.length - 1 && modeAt(points[j + 1].ts) === mode) j++;
			const run = points.slice(i, Math.min(j + 2, points.length));
			L.polyline(
				run.map((p) => [p.lat, p.lon] as L.LatLngTuple),
				{ color: MODE_COLORS[mode] ?? DEFAULT_COLOR, weight: 4, opacity: 0.9 },
			).addTo(layer);
			i = j + 1;
		}

		// A marker at each named stay, at the centroid of its fixes.
		for (const s of segments) {
			if (s.mode !== "stationary" || !s.place) continue;
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

		// The most recent fix, emphasised — the "where are they now"
		// marker this tab exists for.
		const last = points[points.length - 1];
		L.circleMarker([last.lat, last.lon], {
			radius: 9,
			color: "#ffffff",
			weight: 3,
			fillColor: "#7c3aed",
			fillOpacity: 1,
		})
			.bindPopup(`Last seen ${this.lastSeen()}`)
			.addTo(layer);

		map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as L.LatLngTuple)), {
			padding: [24, 24],
		});
	}
}
