// Fitbit API response types

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user_id: string;
  scope: string;
}

export interface DailyActivity {
  date: string;
  summary: {
    steps: number;
    caloriesOut: number;
    activityCalories: number;
    distances: Array<{ activity: string; distance: number }>;
    floors: number;
    elevation: number;
    sedentaryMinutes: number;
    lightlyActiveMinutes: number;
    fairlyActiveMinutes: number;
    veryActiveMinutes: number;
    restingHeartRate?: number;
    activeScore: number;
  };
}

export interface HeartRateZone {
  name: string;
  min: number;
  max: number;
  minutes: number;
  caloriesOut: number;
}

export interface HeartRateIntraday {
  time: string;
  value: number;
}

export interface SleepLog {
  logId: number;
  dateOfSleep: string;
  startTime: string;
  endTime: string;
  duration: number;
  efficiency: number;
  minutesAsleep: number;
  minutesAwake: number;
  isMainSleep: boolean;
  levels?: {
    summary: {
      deep?: { minutes: number };
      light?: { minutes: number };
      rem?: { minutes: number };
      wake?: { minutes: number };
    };
    data: Array<{
      dateTime: string;
      level: string;
      seconds: number;
    }>;
  };
}

export interface BodyLog {
  date: string;
  weight?: number;
  bmi?: number;
  fat?: number;
}

export interface SpO2Daily {
  dateTime: string;
  value: {
    avg: number;
    min: number;
    max: number;
  };
}

export interface SpO2Intraday {
  dateTime: string;
  value: number;
}

export interface HrvDaily {
  dateTime: string;
  value: {
    dailyRmssd: number;
    deepRmssd: number;
  };
}

export interface BreathingRate {
  dateTime: string;
  value: {
    breathingRate: number;
    fullSleepSummary?: { breathingRate: number };
    deepSleepSummary?: { breathingRate: number };
    lightSleepSummary?: { breathingRate: number };
    remSleepSummary?: { breathingRate: number };
  };
}

export interface SkinTemperature {
  dateTime: string;
  value: {
    nightlyRelative: number;
  };
}

export interface CardioFitness {
  dateTime: string;
  value: {
    vo2Max: string; // comes as string from API
  };
}

export interface Device {
  id: string;
  deviceVersion: string;
  type: string;
  battery: string;
  lastSyncTime: string;
}
