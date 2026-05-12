/**
 * Thin Fitbit HTTP client. All token management lives in
 * `token-manager.ts`, which provides per-user refresh mutex and
 * typed reauth-required signalling. The client is constructed with
 * userId + OAuth config; rate-limit state stays here because it's a
 * per-process concern, not a per-user one.
 */

import { type FitbitOAuthConfig, getValidTokens } from "./token-manager.js";

export class FitbitClient {
	private rateLimitRemaining_ = 150;
	private rateLimitResetAt = 0;

	constructor(
		private readonly userId: string,
		private readonly config: FitbitOAuthConfig,
	) {}

	get rateLimitRemaining(): number {
		return this.rateLimitRemaining_;
	}

	async get<T>(path: string, retries = 0): Promise<T> {
		const tokens = await getValidTokens(this.userId, this.config);
		await this.waitForRateLimit();

		const url = path.startsWith("http") ? path : `https://api.fitbit.com${path}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${tokens.accessToken}` },
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
