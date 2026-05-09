import { Component, computed, input } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import type { TrackSegment, VelocityData } from "../../services/health.service";

interface TimelineEntry {
	startLabel: string;
	endLabel: string;
	durationLabel: string;
	mode: string;
	icon: string;
	primary: string; // main label (place name or "Walking 4.2 km/h")
	secondary?: string; // additional context
}

const MODE_ICONS: Record<string, string> = {
	stationary: "place",
	walking: "directions_walk",
	cycling: "directions_bike",
	driving: "directions_car",
	train: "train",
	plane: "flight",
	boat: "directions_boat",
};

@Component({
	selector: "app-timeline",
	standalone: true,
	imports: [MatCardModule, MatIconModule],
	templateUrl: "./timeline.component.html",
	styleUrl: "./timeline.component.scss",
})
export class TimelineComponent {
	readonly data = input<VelocityData | null>(null);

	readonly entries = computed<TimelineEntry[]>(() => {
		const v = this.data();
		if (!v?.segments?.length) return [];
		return v.segments.map((s) => this.toEntry(s));
	});

	private toEntry(s: TrackSegment): TimelineEntry {
		const mode = s.refinedMode ?? s.mode;
		const icon = MODE_ICONS[mode] ?? "place";

		const startLabel = this.formatTime(s.startTs);
		const endLabel = this.formatTime(s.endTs);
		const durationLabel = this.formatDuration(s.endTs - s.startTs);

		let primary: string;
		let secondary: string | undefined;

		if (mode === "stationary") {
			primary = s.place ?? "Stopped";
			secondary = `${durationLabel} stationary`;
		} else {
			const verb = mode.charAt(0).toUpperCase() + mode.slice(1);
			primary = `${verb} · ${s.avgSpeed} km/h`;
			if (s.wayName) {
				secondary = `On ${s.wayName} · ${durationLabel}`;
			} else if (s.refinedReason) {
				secondary = `${s.refinedReason} · ${durationLabel}`;
			} else {
				secondary = `${durationLabel} · max ${s.maxSpeed} km/h`;
			}
		}

		return { startLabel, endLabel, durationLabel, mode, icon, primary, secondary };
	}

	private formatTime(unixTs: number): string {
		const d = new Date(unixTs * 1000);
		return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
	}

	private formatDuration(seconds: number): string {
		const mins = Math.round(seconds / 60);
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		const rem = mins % 60;
		return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
	}
}
