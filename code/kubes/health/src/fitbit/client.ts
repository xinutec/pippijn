import type { TokenPair } from "./types.js";

interface RateLimitState {
  remaining: number;
  resetAt: number; // epoch ms
}

export class FitbitClient {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private rateLimit: RateLimitState = { remaining: 150, resetAt: 0 };
  private onTokenRefresh?: (tokens: TokenPair) => Promise<void>;

  constructor(config: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    clientId: string;
    clientSecret: string;
    onTokenRefresh?: (tokens: TokenPair) => Promise<void>;
  }) {
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.expiresAt = config.expiresAt;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() < this.expiresAt - 5 * 60 * 1000) return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const basicAuth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`
    ).toString("base64");

    const res = await fetch("https://api.fitbit.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed: ${res.status} ${body}`);
    }

    const tokens: TokenPair = await res.json();
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.expiresAt = Date.now() + tokens.expires_in * 1000;

    if (this.onTokenRefresh) {
      await this.onTokenRefresh(tokens);
    }
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get("fitbit-rate-limit-remaining");
    const reset = headers.get("fitbit-rate-limit-reset");
    if (remaining !== null) {
      this.rateLimit.remaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.rateLimit.resetAt = Date.now() + parseInt(reset, 10) * 1000;
    }
  }

  get rateLimitRemaining(): number {
    return this.rateLimit.remaining;
  }

  async get<T>(path: string): Promise<T> {
    await this.ensureToken();

    if (this.rateLimit.remaining <= 5 && Date.now() < this.rateLimit.resetAt) {
      const waitMs = this.rateLimit.resetAt - Date.now();
      console.log(
        `Rate limit near (${this.rateLimit.remaining} remaining), waiting ${Math.ceil(waitMs / 1000)}s`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const url = path.startsWith("http")
      ? path
      : `https://api.fitbit.com${path}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    this.updateRateLimit(res.headers);

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 3600;
      console.log(`Rate limited, waiting ${waitSec}s`);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      return this.get<T>(path);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fitbit API ${path}: ${res.status} ${body}`);
    }

    return res.json();
  }
}
