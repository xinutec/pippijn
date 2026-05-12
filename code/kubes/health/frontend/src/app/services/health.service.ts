import { Injectable, inject, signal } from "@angular/core";
import { ConnectionStateService } from "./connection-state.service";

export interface ActivityDay {
  date: string;
  steps: number;
  calories_total: number;
  calories_active: number;
  distance_km: number;
  minutes_sedentary: number;
  minutes_lightly_active: number;
  minutes_fairly_active: number;
  minutes_very_active: number;
  resting_heart_rate: number | null;
}

export interface SleepLog {
  log_id: number;
  date: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  efficiency: number;
  minutes_asleep: number;
  minutes_awake: number;
  minutes_deep: number | null;
  minutes_light: number | null;
  minutes_rem: number | null;
  minutes_wake: number | null;
  is_main_sleep: boolean;
}

export interface SleepStage {
  ts: string;
  stage: string;
  duration_seconds: number;
}

export interface HeartRatePoint {
  ts: string;
  bpm: number;
}

export interface VelocityPoint {
  ts: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  bearing: number;
}

export interface TrackSegment {
  startTs: number;
  endTs: number;
  mode: string;
  /** 0-1 probability of the chosen mode, normalised across modes. */
  confidence: number;
  /** Ratio of best mode score to runner-up. > 2 unambiguous, ~1 ambiguous. */
  confidenceMargin: number;
  avgSpeed: number;
  maxSpeed: number;
  linearity: number;
  pointCount: number;
  // OSM enrichment (optional, may not be present if Nominatim/Overpass failed)
  place?: string;
  city?: string; // city/town/village (stationary segments) — used to group consecutive same-city entries
  wayName?: string;
  refinedMode?: string;
  refinedReason?: string;
  /** IANA tz the segment's timestamps should be rendered in.
   *  Derived per-segment from the segment's location (stationary
   *  centroid, moving midpoint). Lets the UI show times "as you
   *  experienced them" — morning in one tz, evening in another
   *  on a travel day. */
  displayTz?: string;
}

export interface VelocityData {
  points: VelocityPoint[];
  segments: TrackSegment[];
}

export interface UserInfo {
  userId: string;
  displayName: string;
  fitbitLinked: boolean;
  /** Per-connection status object. Old clients see only the
   *  top-level booleans; new clients use this richer view to render
   *  the reauth banner. */
  connections?: {
    nextcloud: { status: "active" | "needs_reauth" | "not_linked" };
    fitbit: { status: "active" | "not_linked" };
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

@Injectable({ providedIn: "root" })
export class HealthService {
  readonly user = signal<UserInfo | null>(null);
  private readonly connection = inject(ConnectionStateService);

  /** All HTTP calls go through here so the connection-state service
   *  can observe 409 reauth signals from any endpoint and flip the
   *  global banner. Mirrors `fetch`'s signature. */
  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return this.connection.fetch(input, init);
  }

  async checkAuth(): Promise<boolean> {
    try {
      const res = await this.fetch("/api/me");
      if (res.ok) {
        const info = (await res.json()) as UserInfo;
        this.user.set(info);
        // Seed connection-state from /api/me so the banner can render
        // on app-load without waiting for the first 409 from a data
        // endpoint. Falls back to legacy boolean when the new field
        // isn't present (server older than this client).
        if (info.connections?.nextcloud) {
          this.connection.setNextcloudStatus(info.connections.nextcloud.status);
        } else {
          this.connection.setNextcloudStatus("active"); // optimistic on legacy backends
        }
        return true;
      }
    } catch {
      // not authenticated
    }
    this.user.set(null);
    return false;
  }

  async getActivity(days = 30): Promise<ActivityDay[]> {
    const res = await this.fetch(`/api/activity?days=${days}`);
    if (!res.ok) throw new Error("Failed to fetch activity");
    return res.json();
  }

  async getSleep(days = 30): Promise<SleepLog[]> {
    const res = await this.fetch(`/api/sleep?days=${days}`);
    if (!res.ok) throw new Error("Failed to fetch sleep");
    return res.json();
  }

  async getSleepStages(date = today()): Promise<SleepStage[]> {
    const res = await this.fetch(`/api/sleep/stages?date=${date}`);
    if (!res.ok) throw new Error("Failed to fetch sleep stages");
    return res.json();
  }

  async getHeartRateIntraday(date = yesterday()): Promise<HeartRatePoint[]> {
    const res = await this.fetch(`/api/heartrate/intraday?date=${date}`);
    if (!res.ok) throw new Error("Failed to fetch heart rate intraday");
    return res.json();
  }

  async getVelocity(date = yesterday()): Promise<VelocityData> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await this.fetch(`/api/velocity?date=${date}&tz=${encodeURIComponent(tz)}`);
    if (!res.ok) throw new Error("Failed to fetch velocity data");
    return res.json();
  }

  /** Fire-and-forget — sets PhoneTrack's visualisation date filter to a
   * sensible default (yesterday 00:00 if before 06:00 local, else today
   * 00:00, no end). Called on dashboard load so navigating to PhoneTrack
   * always shows the relevant range. */
  async syncPhoneTrackFilter(): Promise<void> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await this.fetch(`/api/phonetrack/sync-filter?tz=${encodeURIComponent(tz)}`, { method: "POST" });
    } catch {
      // Non-fatal — the dashboard works regardless.
    }
  }
}
