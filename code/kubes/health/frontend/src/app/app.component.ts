import { Component, computed, effect, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterLink, RouterOutlet } from "@angular/router";
import { filter, map, startWith } from "rxjs/operators";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ReauthBannerComponent } from "./components/reauth-banner/reauth-banner.component";
import { HealthService } from "./services/health.service";
import { installErrorReporting } from "./client-diagnostics";

/** What kind of view the current URL maps to. Drives toolbar
 *  controls visibility (the share button, gear and Logout disappear
 *  in share mode; the reauth banner hides too — the recipient has
 *  no path to fix the owner's connection). */
type AppMode = "dashboard" | "settings" | "share";

@Component({
	selector: "app-root",
	standalone: true,
	imports: [
		MatToolbarModule,
		MatButtonModule,
		MatIconModule,
		MatSnackBarModule,
		MatTooltipModule,
		RouterLink,
		RouterOutlet,
		ReauthBannerComponent,
	],
	templateUrl: "./app.component.html",
	styleUrl: "./app.component.scss",
})
export class AppComponent {
	readonly health = inject(HealthService);
	private readonly router = inject(Router);

	/** Mirror of `router.url` as a signal, recomputed on every
	 *  NavigationEnd. `startWith(router.url)` seeds the value so
	 *  the toolbar renders correctly on first paint. */
	private readonly url = toSignal(
		this.router.events.pipe(
			filter((e): e is NavigationEnd => e instanceof NavigationEnd),
			map((e) => e.urlAfterRedirects),
			startWith(this.router.url),
		),
		{ initialValue: this.router.url },
	);

	readonly mode = computed<AppMode>(() => {
		const u = this.url();
		if (u.startsWith("/share/")) return "share";
		if (u === "/settings" || u.startsWith("/settings?") || u.startsWith("/settings/")) return "settings";
		return "dashboard";
	});

	private readonly snackBar = inject(MatSnackBar);

	/** The `date`/`tab` query params of the page currently open,
	 *  re-serialised in a stable order. These are exactly the params
	 *  the dashboard round-trips through the URL (see DashboardComponent),
	 *  so carrying them into a share link lands the recipient on the
	 *  same day and tab. Empty when neither is set — today on the
	 *  default tab, or a page like Settings that has no day. */
	private readonly deepLinkParams = computed<string>(() => {
		const u = this.url();
		const qIdx = u.indexOf("?");
		if (qIdx < 0) return "";
		const src = new URLSearchParams(u.slice(qIdx + 1));
		const out = new URLSearchParams();
		const date = src.get("date");
		const tab = src.get("tab");
		if (date) out.set("date", date);
		if (tab) out.set("tab", tab);
		return out.toString();
	});

	/** The share link for the toolbar quick-copy button, or null while
	 *  no share link is active. Carries the day and tab currently open
	 *  so the recipient opens on the same view; falls back to the bare
	 *  link (as shown in Settings) when the URL has no day/tab. */
	readonly shareUrl = computed<string | null>(() => {
		const s = this.health.shareStatus();
		if (!s?.active || !s.url) return null;
		const params = this.deepLinkParams();
		return params ? `${s.url}?${params}` : s.url;
	});

	constructor() {
		// Install browser error/unhandledrejection listeners up-front so
		// any failure during auth or initial render still gets reported.
		installErrorReporting(this.health);

		// Load the owner's share status once the user is known, so the
		// toolbar can offer a quick-copy button. Skipped in share mode:
		// /api/share is owner-only and a recipient has no link to copy.
		effect(() => {
			if (this.health.user() && this.mode() !== "share" && this.health.shareStatus() === null) {
				this.health.refreshShareStatus().catch(() => {
					// Non-fatal — the Settings page remains the reliable path.
				});
			}
		});
	}

	/** Copy a share link to the clipboard with a transient
	 *  confirmation. The link carries the day and tab currently open
	 *  (see `shareUrl`) so the recipient lands on the same view. */
	async copyShareLink(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url);
			this.snackBar.open("Share link copied", "Dismiss", { duration: 2000 });
		} catch {
			this.snackBar.open("Could not copy — open Settings to copy the link.", "Dismiss", { duration: 4000 });
		}
	}
}
