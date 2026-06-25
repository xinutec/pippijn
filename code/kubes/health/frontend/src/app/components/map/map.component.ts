import {
	Component,
	computed,
	effect,
	type ElementRef,
	inject,
	input,
	model,
	NgZone,
	type OnDestroy,
	signal,
	viewChild,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatCheckboxModule } from "@angular/material/checkbox";
import * as L from "leaflet";
import type { LatestFix, VelocityData } from "../../services/health.service";

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
	sleeping: "#94a3b8",
};
const DEFAULT_COLOR = "#94a3b8";

/**
 * Map tab — the day's track on an OpenStreetMap basemap.
 *
 * The map renders the day's **episodes** (`VelocityData.episodes`), the
 * same model the "Your Day" narrative uses, so the two views cannot tell
 * different stories. All point geometry — fix bucketing, spike rejection,
 * the per-mode speed-plausibility filter that stops a mis-segmented train
 * tail being drawn as a 60 km/h "walk" on the rails, stay centroids — is
 * resolved server-side in `buildEpisodes` (`src/geo/episode-geometry.ts`,
 * `docs/design/episode-geometry.md`). This component only plumbs Leaflet:
 * one polyline per episode (dashed when the geometry is inferred — snapped
 * rail or a tentative gap), a marker per stay, the live "current position"
 * marker, and view placement.
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
	/** Two-way: snap walking legs onto the pavement network (pedestrian
	 *  map-matching). Off renders the original smoothed/raw walks. The dashboard
	 *  owns the velocity fetch, so toggling this refetches the day's data. */
	readonly walkMatch = model<boolean>(true);
	readonly mapRef = viewChild<ElementRef<HTMLDivElement>>("map");

	/** When checked, recentre the map on the live marker as each new
	 *  fix arrives. Off by default — auto-panning is opt-in so it never
	 *  yanks the view from under someone reading the map. */
	readonly follow = signal(false);

	/** When checked, overlay the raw GPS fixes (the input the matched / smoothed
	 *  line is estimated from) as faint dots, so the drawn line can be compared
	 *  against where the phone actually reported. Off by default. Pure client-side
	 *  toggle — the raw fixes are always in the response, no refetch. */
	readonly showFixes = signal(false);

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
	/** Every drawn vertex, flattened, for the tap-to-inspect popup — so a
	 *  tap anywhere reports the nearest point's exact coordinate, time, and
	 *  what KIND of point it is (raw GPS fix vs a derived stay centre or gap
	 *  connector). Rebuilt on every render. */
	private inspectPoints: { lat: number; lon: number; ts?: number; sigmaM?: number; mode: string; kind: string; place?: string }[] = [];
	/** The `data` reference the view was last fitted to — guards against
	 *  re-fitting (and yanking the view) on every 15s poll. */
	private fittedTo: VelocityData | null | undefined = undefined;

	constructor() {
		// Redraw when the day's data or the live fix changes.
		effect(() => {
			const data = this.data();
			const fix = this.liveFix();
			this.showFixes(); // re-render when the GPS-fixes overlay toggles
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
			// Tap-to-inspect: report the nearest drawn vertex. Bound once.
			map.on("click", (e: L.LeafletMouseEvent) => this.showInspect(map as L.Map, e.latlng));
			this.map = map;
			this.layer = layer;
		}
		layer.clearLayers();
		this.inspectPoints = [];

		const episodes = data?.episodes ?? [];

		// One polyline per episode, bridged to the previous drawn point so
		// the line stays continuous across a mode change; inferred geometry
		// (snapped rail, tentative gap connectors) is drawn dashed. Stays
		// are a single anchor point — drawn as a marker below, not a line —
		// but still advance continuity so the lines on either side meet at
		// the stay. `allCoords` accumulates every drawn vertex for bounds
		// fitting and the current-position fallback.
		const allCoords: L.LatLngTuple[] = [];
		let prevLast: L.LatLngTuple | null = null;
		for (const ep of episodes) {
			if (ep.points.length === 0) continue;
			for (const p of ep.points) {
				this.inspectPoints.push({ lat: p.lat, lon: p.lon, ts: p.ts, sigmaM: p.sigmaM, mode: ep.mode, kind: ep.kind, place: ep.place });
			}
			if (ep.kind === "anchor") {
				prevLast = [ep.points[0].lat, ep.points[0].lon];
				allCoords.push(prevLast);
				continue;
			}
			const coords = ep.points.map((p) => [p.lat, p.lon] as L.LatLngTuple);
			const dashed = ep.kind === "snapped" || ep.kind === "tentative";
			L.polyline(prevLast ? [prevLast, ...coords] : coords, {
				color: MODE_COLORS[ep.mode] ?? DEFAULT_COLOR,
				weight: 4,
				opacity: 0.9,
				...(dashed ? { dashArray: "6 6" } : {}),
			}).addTo(layer);
			for (const c of coords) allCoords.push(c);
			prevLast = coords[coords.length - 1];
		}

		// A marker at each named stay — the anchor episode's single point.
		for (const ep of episodes) {
			if (ep.kind !== "anchor" || !ep.place || ep.points.length === 0) continue;
			L.circleMarker([ep.points[0].lat, ep.points[0].lon], {
				radius: 6,
				color: "#ffffff",
				weight: 2,
				fillColor: MODE_COLORS["stationary"],
				fillOpacity: 1,
			})
				.bindPopup(ep.place)
				.addTo(layer);
		}

		// Optional overlay: the raw GPS fixes (the matcher/smoother input) as
		// faint dots, so the drawn line can be judged against where the phone
		// actually reported. Drawn on top, small and translucent so it adds
		// context without obscuring the line.
		if (this.showFixes()) {
			for (const f of data?.rawFixes ?? []) {
				L.circleMarker([f.lat, f.lon], {
					radius: 2,
					color: "#444444",
					weight: 0,
					fillColor: "#444444",
					fillOpacity: 0.55,
				}).addTo(layer);
			}
		}

		const lastTuple = allCoords.at(-1);
		const lastDrawn = lastTuple ? { lat: lastTuple[0], lon: lastTuple[1] } : null;

		// The live fix runs ahead of the classified track — the day's
		// episodes only catch up once classification re-runs. Join the
		// track's last point to the live marker with a dashed connector
		// so the marker isn't drawn floating, detached from the path.
		if (fix && lastDrawn) {
			L.polyline(
				[
					[lastDrawn.lat, lastDrawn.lon],
					[fix.lat, fix.lon],
				],
				{ color: "#7c3aed", weight: 3, opacity: 0.7, dashArray: "4 6" },
			).addTo(layer);
		}

		// Current position — the live fix when polling, else the day's
		// last track point. Emphasised: this is the "where are they
		// now" marker the tab exists for.
		const pos = fix ?? lastDrawn ?? null;
		if (fix) {
			this.inspectPoints.push({ lat: fix.lat, lon: fix.lon, ts: fix.ts, mode: "live", kind: "live" });
		}
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
			if (allCoords.length > 0) {
				map.fitBounds(L.latLngBounds(allCoords), { padding: [24, 24] });
			} else if (pos) {
				map.setView([pos.lat, pos.lon], 14);
			} else {
				map.setView([51.505, -0.12], 11);
			}
		}
	}

	/** Open a popup at the drawn vertex nearest the tapped point, reporting
	 *  its exact coordinate, time, and — the useful part for debugging a
	 *  stray location — WHAT it is: a raw GPS fix, a map-matched / rail-snapped
	 *  vertex, a computed stay centre, or a gap connector with no GPS behind
	 *  it. */
	private showInspect(map: L.Map, latlng: L.LatLng): void {
		let best: (typeof this.inspectPoints)[number] | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		for (const p of this.inspectPoints) {
			const d = map.distance(latlng, L.latLng(p.lat, p.lon));
			if (d < bestD) {
				bestD = d;
				best = p;
			}
		}
		if (!best) return;
		const coord = `${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`;
		const when =
			best.ts !== undefined
				? new Date(best.ts * 1000).toLocaleString("en-GB", {
						day: "2-digit",
						month: "short",
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					})
				: "—";
		const source = MapComponent.SOURCE_LABEL[best.kind] ?? best.kind;
		const placeLine = best.place ? `<br><i>${best.place}</i>` : "";
			// Honest uncertainty: a smoothed walk vertex carries a posterior σ.
			const sigmaLine =
				best.sigmaM !== undefined ? `<br><span style="color:#64748b">±${best.sigmaM.toFixed(0)} m (estimate confidence)</span>` : "";
		const html =
			`<div style="font:13px/1.5 system-ui">` +
			`<b>${coord}</b>${placeLine}<br>` +
			`${best.mode} · ${source}${sigmaLine}<br>` +
			`${when}<br>` +
			`<span style="color:#64748b">${bestD < 1 ? "on this point" : `${bestD.toFixed(0)} m from your tap`}</span>` +
			`</div>`;
		L.popup({ closeButton: true }).setLatLng([best.lat, best.lon]).setContent(html).openOn(map);
	}

	/** What each episode `kind` means as a data source — the answer to
	 *  "where does this point come from". */
	private static readonly SOURCE_LABEL: Record<string, string> = {
		raw: "raw GPS fix",
		matched: "map-matched to road",
		smoothed: "smoothed walk (GPS + pedometer + map)",
		snapped: "snapped to rail line",
		anchor: "stay centre (computed average)",
		tentative: "gap connector (inferred, no GPS)",
		live: "live position (latest fix)",
	};
}
