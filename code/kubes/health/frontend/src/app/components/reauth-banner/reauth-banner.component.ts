import { Component, inject } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { ConnectionStateService } from "../../services/connection-state.service";

/**
 * Top-of-page banner that appears when the user's Nextcloud connection
 * has expired and needs to be re-established. The reconnect button
 * jumps to `/login?return_to=<current path>` so the OAuth callback
 * brings the user back to where they were rather than the home page.
 *
 * The banner reads `ConnectionStateService.nextcloudStatus` directly
 * — that signal is updated either at app-load (from `/api/me`) or
 * the moment any API call returns a 409 reauth signal.
 */
@Component({
	selector: "app-reauth-banner",
	standalone: true,
	imports: [MatButtonModule, MatIconModule],
	template: `
		@if (connectionState.nextcloudStatus() === "needs_reauth") {
			<div class="reauth-banner" role="status">
				<mat-icon class="icon">link_off</mat-icon>
				<span class="message">
					Your Nextcloud connection has expired. Location data won't load until you reconnect.
				</span>
				<button mat-raised-button color="primary" (click)="reconnect()">Reconnect Nextcloud</button>
			</div>
		}
	`,
	styles: [
		`
		.reauth-banner {
			display: flex;
			align-items: center;
			gap: 1rem;
			padding: 0.75rem 1.25rem;
			background-color: #fff3e0;
			color: #5d4037;
			border-bottom: 1px solid #ffb74d;
		}
		.icon { color: #e65100; }
		.message { flex: 1; }
		`,
	],
})
export class ReauthBannerComponent {
	readonly connectionState = inject(ConnectionStateService);

	reconnect(): void {
		// Preserve the current path so post-callback we land back here.
		// Only the pathname + search is forwarded — origin and hash are
		// not part of the round-trip. The backend allowlist validates
		// the shape before honoring it.
		const returnTo = window.location.pathname + window.location.search;
		window.location.href = `/login?return_to=${encodeURIComponent(returnTo)}`;
	}
}
