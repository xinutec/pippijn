import { Injectable, signal } from "@angular/core";

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

export interface HeartRateZone {
  date: string;
  zone_name: string;
  minutes: number;
  calories: number;
  min_bpm: number;
  max_bpm: number;
}

export interface UserInfo {
  userId: string;
  displayName: string;
  fitbitLinked: boolean;
}

@Injectable({ providedIn: "root" })
export class HealthService {
  readonly user = signal<UserInfo | null>(null);
  readonly loading = signal(true);

  async checkAuth(): Promise<boolean> {
    try {
      const res = await fetch("/api/me");
      if (res.ok) {
        this.user.set(await res.json());
        return true;
      }
    } catch {
      // not authenticated
    }
    this.user.set(null);
    return false;
  }

  async getActivity(days = 30): Promise<ActivityDay[]> {
    const res = await fetch(`/api/activity?days=${days}`);
    if (!res.ok) throw new Error("Failed to fetch activity");
    return res.json();
  }

  async getSleep(days = 30): Promise<SleepLog[]> {
    const res = await fetch(`/api/sleep?days=${days}`);
    if (!res.ok) throw new Error("Failed to fetch sleep");
    return res.json();
  }

  async getHeartRateZones(days = 30): Promise<HeartRateZone[]> {
    const res = await fetch(`/api/heartrate/zones?days=${days}`);
    if (!res.ok) throw new Error("Failed to fetch heart rate zones");
    return res.json();
  }
}
