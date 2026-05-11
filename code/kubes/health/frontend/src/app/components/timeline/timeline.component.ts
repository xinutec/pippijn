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

type TimelineRow = { kind: "city"; city: string } | { kind: "entry"; entry: TimelineEntry };

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

  readonly rows = computed<TimelineRow[]>(() => {
    const v = this.data();
    if (!v?.segments?.length) return [];
    return this.buildRows(v.segments);
  });

  /** Walk the segments in order. Emit a city header whenever the city changes
   *  on a stationary segment; moving segments don't carry city and don't break
   *  a run (so a city header keeps applying through driving between two stops
   *  in the same city — but a drive *between* two cities sits between two
   *  separate headers and reads as a transit). */
  private buildRows(segments: TrackSegment[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let lastCity: string | null = null;
    for (const s of segments) {
      if (s.city && s.city !== lastCity) {
        rows.push({ kind: "city", city: s.city });
        lastCity = s.city;
      }
      rows.push({ kind: "entry", entry: this.toEntry(s) });
    }
    return rows;
  }

  private toEntry(s: TrackSegment): TimelineEntry {
    const mode = s.refinedMode ?? s.mode;
    const icon = MODE_ICONS[mode] ?? "place";

    // Render timestamps in the segment's location-derived tz so the UI shows
    // events "as the user experienced them" — morning at parents in CEST,
    // evening home in BST, even across a travel day. Falls back to the
    // browser tz when the segment didn't get a displayTz tag (older data
    // pre-Phase 2 deploy, or a corner case in the backend).
    const tz = s.displayTz;
    const startLabel = this.formatTime(s.startTs, tz);
    const endLabel = this.formatTime(s.endTs, tz);
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

  private formatTime(unixTs: number, tz?: string): string {
    const d = new Date(unixTs * 1000);
    if (tz === undefined) {
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    }
    // Use Intl with the segment's tz so a CEST-recorded morning shows
    // "09:44" even when the browser is in BST.
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    // en-GB renders midnight as "00" not "24" — but be defensive.
    return `${h === "24" ? "00" : h}:${m}`;
  }

  private formatDuration(seconds: number): string {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
}
