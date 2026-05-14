import { Component, computed, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router, RouterLink, RouterOutlet } from "@angular/router";
import { filter, map, startWith } from "rxjs/operators";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatToolbarModule } from "@angular/material/toolbar";
import { ReauthBannerComponent } from "./components/reauth-banner/reauth-banner.component";
import { HealthService } from "./services/health.service";
import { installErrorReporting } from "./client-diagnostics";

/** What kind of view the current URL maps to. Drives toolbar
 *  controls visibility (the gear and Logout disappear in share
 *  mode; the reauth banner hides too — the recipient has no path
 *  to fix the owner's connection). */
type AppMode = "dashboard" | "settings" | "share";

@Component({
	selector: "app-root",
	standalone: true,
	imports: [MatToolbarModule, MatButtonModule, MatIconModule, RouterLink, RouterOutlet, ReauthBannerComponent],
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

	constructor() {
		// Install browser error/unhandledrejection listeners up-front so
		// any failure during auth or initial render still gets reported.
		installErrorReporting(this.health);
	}
}
