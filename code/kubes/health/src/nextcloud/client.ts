/**
 * Thin Nextcloud HTTP client. Delegates all token management to the
 * module-level token manager (see `token-manager.ts`), which provides
 * per-user refresh mutex and reauth-required signalling.
 *
 * The client is stateless apart from holding the userId and config —
 * every request fetches a fresh access token from the manager just
 * before sending. Construction is therefore cheap and the same client
 * can be safely reused across requests (or thrown away).
 */

import { getValidTokens, type NextcloudConfig } from "./token-manager.js";

export class NextcloudClient {
	constructor(
		private readonly userId: string,
		private readonly config: NextcloudConfig,
	) {}

	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	async put<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	async post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const tokens = await getValidTokens(this.userId, this.config);

		const url = path.startsWith("http") ? path : `${this.config.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${tokens.accessToken}`,
			"OCS-APIRequest": "true",
		};
		const init: RequestInit = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}

		const res = await fetch(url, init);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Nextcloud API ${method} ${path}: ${res.status} ${text}`);
		}

		// Some PhoneTrack endpoints return empty body — guard against that.
		const text = await res.text();
		return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
	}
}
