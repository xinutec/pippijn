export class NextcloudClient {
	private accessToken: string;
	private refreshToken: string;
	private expiresAt: number;
	private readonly baseUrl: string;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly onTokenRefresh?: (accessToken: string, refreshToken: string, expiresIn: number) => Promise<void>;

	constructor(config: {
		accessToken: string;
		refreshToken: string;
		expiresAt: number;
		baseUrl: string;
		clientId: string;
		clientSecret: string;
		onTokenRefresh?: (accessToken: string, refreshToken: string, expiresIn: number) => Promise<void>;
	}) {
		this.accessToken = config.accessToken;
		this.refreshToken = config.refreshToken;
		this.expiresAt = config.expiresAt;
		this.baseUrl = config.baseUrl;
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.onTokenRefresh = config.onTokenRefresh;
	}

	async get<T>(path: string): Promise<T> {
		await this.ensureToken();

		const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				"OCS-APIRequest": "true",
			},
		});

		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Nextcloud API ${path}: ${res.status} ${body}`);
		}

		return res.json() as Promise<T>;
	}

	private async ensureToken(): Promise<void> {
		if (Date.now() < this.expiresAt - 60 * 1000) return;

		const res = await fetch(`${this.baseUrl}/index.php/apps/oauth2/api/v1/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.refreshToken,
				client_id: this.clientId,
				client_secret: this.clientSecret,
			}),
		});

		if (!res.ok) {
			throw new Error(`Nextcloud token refresh failed: ${res.status} ${await res.text()}`);
		}

		const data = (await res.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in?: number;
		};

		this.accessToken = data.access_token;
		this.refreshToken = data.refresh_token;
		const expiresIn = data.expires_in ?? 3600;
		this.expiresAt = Date.now() + expiresIn * 1000;

		await this.onTokenRefresh?.(data.access_token, data.refresh_token, expiresIn);
	}
}
