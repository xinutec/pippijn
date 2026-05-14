import { Component, OnInit, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatSnackBar, MatSnackBarModule } from "@angular/material/snack-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { HealthService, type ShareStatus } from "../../services/health.service";

/**
 * Settings page. Today: just the share-link section.
 *
 * One token per user. "Generate new link" rotates (DELETE + INSERT
 * atomic server-side) — the previous URL stops working the instant
 * the new one is shown. "Revoke" removes the row.
 *
 * Material-first: the URL display is a real `<mat-form-field>` with
 * a `matSuffix` copy button so theming, focus, and contrast all
 * come from Material's tokens (no hand-rolled CSS for the input
 * shell). Copy confirmation uses MatSnackBar instead of a
 * label-swap on the button — transient feedback is exactly what
 * the snack-bar is for.
 */
@Component({
	selector: "app-settings",
	standalone: true,
	imports: [
		FormsModule,
		MatButtonModule,
		MatCardModule,
		MatFormFieldModule,
		MatIconModule,
		MatInputModule,
		MatProgressSpinnerModule,
		MatSnackBarModule,
		MatTooltipModule,
	],
	template: `
		<div class="settings-page">
			<header class="settings-header">
				<a mat-icon-button href="/" aria-label="Back to dashboard">
					<mat-icon>arrow_back</mat-icon>
				</a>
				<h1>Settings</h1>
			</header>

			<mat-card>
				<mat-card-header>
					<mat-card-title>Share your timeline</mat-card-title>
					<mat-card-subtitle>
						Give someone a link to see your last N days. Read-only.
					</mat-card-subtitle>
				</mat-card-header>
				<mat-card-content>
					@if (loading()) {
						<mat-spinner diameter="32"></mat-spinner>
					} @else if (status(); as s) {
						@if (s.active && s.url) {
							<mat-form-field appearance="outline" class="full-width">
								<mat-label>Share link</mat-label>
								<input matInput readonly [value]="s.url" #linkInput />
								<button
									matSuffix
									mat-icon-button
									(click)="copyLink(linkInput.value)"
									matTooltip="Copy link"
									aria-label="Copy link">
									<mat-icon>content_copy</mat-icon>
								</button>
							</mat-form-field>
							<p>
								Showing the last {{ s.daysBack }} day{{ s.daysBack === 1 ? "" : "s" }}.
								@if (s.lastAccessedAt) {
									Last accessed {{ formatDate(s.lastAccessedAt) }}.
								} @else {
									Not yet accessed.
								}
							</p>
						} @else {
							<p>No share link active. Choose how many days to share, then create one.</p>
							<mat-form-field appearance="outline">
								<mat-label>Days to share</mat-label>
								<input matInput type="number" min="1" max="365" [(ngModel)]="daysInput" />
							</mat-form-field>
						}
					}
					@if (error(); as e) {
						<p class="error">{{ e }}</p>
					}
				</mat-card-content>
				@if (status(); as s) {
					<mat-card-actions align="end">
						@if (s.active) {
							<button mat-button color="warn" (click)="revoke()">Revoke</button>
							<button mat-stroked-button (click)="rotate(s.daysBack ?? 7)">Generate new link</button>
						} @else {
							<button mat-raised-button color="primary" (click)="create()">Create share link</button>
						}
					</mat-card-actions>
				}
			</mat-card>
		</div>
	`,
	styles: [
		`
		/* Page-level layout only — nothing visual that Material
		 * already provides via mat-card / mat-form-field. */
		.settings-page {
			max-width: 720px;
			margin: 0 auto;
			padding: 1rem;
		}
		.settings-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.settings-header h1 {
			margin: 0;
			font-size: 1.5rem;
		}
		.full-width {
			width: 100%;
		}
		.error {
			color: var(--mat-sys-error);
		}
		`,
	],
})
export class SettingsComponent implements OnInit {
	readonly health = inject(HealthService);
	private readonly snackBar = inject(MatSnackBar);
	readonly loading = signal(true);
	readonly status = signal<ShareStatus | null>(null);
	readonly error = signal<string | null>(null);
	daysInput = 7;

	async ngOnInit(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		this.error.set(null);
		this.loading.set(true);
		try {
			this.status.set(await this.health.getShareStatus());
		} catch (e) {
			this.error.set((e as Error).message);
		} finally {
			this.loading.set(false);
		}
	}

	async create(): Promise<void> {
		this.error.set(null);
		try {
			const s = await this.health.createOrRotateShare(this.daysInput);
			this.status.set(s);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async rotate(currentDays: number): Promise<void> {
		this.error.set(null);
		try {
			const s = await this.health.createOrRotateShare(currentDays);
			this.status.set(s);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async revoke(): Promise<void> {
		this.error.set(null);
		try {
			await this.health.revokeShare();
			this.status.set({ active: false });
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async copyLink(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this.snackBar.open("Link copied", "Dismiss", { duration: 2000 });
		} catch {
			this.snackBar.open("Could not copy — select and copy manually.", "Dismiss", { duration: 4000 });
		}
	}

	formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}
}
