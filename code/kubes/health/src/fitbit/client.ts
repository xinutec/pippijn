import type { FitbitTokenPair } from "../types.js";

export class FitbitClient {
	private accessToken: string;
	private refreshToken: string;
	private expiresAt: number;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly onTokenRefresh?: (tokens: FitbitTokenPair) => Promise<void>;
	private rateLimitRemaining_ = 150;
	private rateLimitResetAt = 0;

	constructor(config: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
		clientId: string;
		clientSecret: string;
		onTokenRefresh?: (tokens: FitbitTokenPair) => Promise<void>;
	}) {
		this.accessToken = config.accessToken;
		this.refreshToken = config.refreshToken;
		this.expiresAt = config.expiresAt;
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.onTokenRefresh = config.onTokenRefresh;
	}

	get rateLimitRemaining(): number {
		return this.rateLimitRemaining_;
	}

	async get<T>(path: string, retries = 0): Promise<T> {
		await this.ensureToken();
		await this.waitForRateLimit();

		const url = path.startsWith("http") ? path : `https://api.fitbit.com${path}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
		});

		this.updateRateLimit(res.headers);

		if (res.status === 429) {
			if (retries >= 3) throw new Error(`Fitbit API ${path}: rate limited after ${retries} retries`);
			const waitSec = parseInt(res.headers.get("retry-after") ?? "3600", 10);
			console.log(`Rate limited, waiting ${waitSec}s (retry ${retries + 1}/3)`);
			await sleep(waitSec * 1000);
			return this.get<T>(path, retries + 1);
		}

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Fitbit API ${path}: ${res.status} ${body}`);
		}

		return res.json() as Promise<T>;
	}

	private async ensureToken(): Promise<void> {
		if (Date.now() < this.expiresAt - 5 * 60 * 1000) return;

		const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
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
			throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
		}

		const tokens = (await res.json()) as FitbitTokenPair;
		this.accessToken = tokens.access_token;
		this.refreshToken = tokens.refresh_token;
		this.expiresAt = Date.now() + tokens.expires_in * 1000;

		await this.onTokenRefresh?.(tokens);
	}

	private async waitForRateLimit(): Promise<void> {
		if (this.rateLimitRemaining_ > 5 || Date.now() >= this.rateLimitResetAt) return;
		const waitMs = this.rateLimitResetAt - Date.now();
		console.log(`Rate limit low (${this.rateLimitRemaining_}), waiting ${Math.ceil(waitMs / 1000)}s`);
		await sleep(waitMs);
	}

	private updateRateLimit(headers: Headers): void {
		const remaining = headers.get("fitbit-rate-limit-remaining");
		const reset = headers.get("fitbit-rate-limit-reset");
		if (remaining !== null) this.rateLimitRemaining_ = parseInt(remaining, 10);
		if (reset !== null) this.rateLimitResetAt = Date.now() + parseInt(reset, 10) * 1000;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
