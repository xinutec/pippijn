import { Component, OnInit, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { HealthService, type ShareStatus } from "../../services/health.service";

/**
 * Settings page. Today: just the share-link section.
 *
 * One token per user. The "Generate new" button rotates (DELETE +
 * INSERT atomically server-side) — the previous URL stops working
 * the instant the new one is shown. "Revoke" removes the row;
 * server returns 404 to the old URL afterwards.
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
	],
	template: `
		<div class="settings-page">
			<header class="settings-header">
				<a mat-icon-button href="/" aria-label="Back to dashboard">
					<mat-icon>arrow_back</mat-icon>
				</a>
				<h1>Settings</h1>
			</header>

			<mat-card class="share-card">
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
							<p>Active share link:</p>
							<div class="link-row">
								<input matInput class="link-input" readonly [value]="s.url" #linkInput />
								<button mat-raised-button (click)="copyLink(linkInput.value)">
									<mat-icon>content_copy</mat-icon>
									{{ copied() ? "Copied" : "Copy" }}
								</button>
							</div>
							<p class="meta">
								Showing the last {{ s.daysBack }} day{{ s.daysBack === 1 ? "" : "s" }}.
								@if (s.lastAccessedAt) {
									Last accessed: {{ formatDate(s.lastAccessedAt) }}.
								} @else {
									Not yet accessed.
								}
							</p>
							<div class="actions">
								<button mat-stroked-button color="warn" (click)="revoke()">Revoke</button>
								<button mat-stroked-button (click)="rotate(s.daysBack ?? 7)">Generate new link</button>
							</div>
						} @else {
							<p>No share link active. Choose how many days to share, then create one.</p>
							<mat-form-field appearance="outline" class="days-field">
								<mat-label>Days to share</mat-label>
								<input matInput type="number" min="1" max="365" [(ngModel)]="daysInput" />
							</mat-form-field>
							<div class="actions">
								<button mat-raised-button color="primary" (click)="create()">Create share link</button>
							</div>
						}
					}
					@if (error(); as e) {
						<p class="error">{{ e }}</p>
					}
				</mat-card-content>
			</mat-card>
		</div>
	`,
	styles: [
		`
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
		.share-card { margin-top: 1rem; }
		.link-row {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			margin: 0.75rem 0;
		}
		.link-input {
			flex: 1;
			padding: 0.5rem;
			font-family: var(--font-mono, ui-monospace, monospace);
			font-size: 0.875rem;
			border: 1px solid var(--mat-sys-outline);
			border-radius: 4px;
			background: var(--mat-sys-surface-variant);
		}
		.meta { color: var(--mat-sys-on-surface-variant); margin: 0.5rem 0; }
		.actions { display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
		.days-field { width: 200px; margin-top: 0.5rem; }
		.error { color: var(--mat-sys-error); margin-top: 0.5rem; }
		`,
	],
})
export class SettingsComponent implements OnInit {
	readonly health = inject(HealthService);
	readonly loading = signal(true);
	readonly status = signal<ShareStatus | null>(null);
	readonly error = signal<string | null>(null);
	readonly copied = signal(false);
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
		// Rotation keeps the current days_back. Use the settings page's
		// days-input only on first creation.
		this.error.set(null);
		try {
			const s = await this.health.createOrRotateShare(currentDays);
			this.status.set(s);
			this.copied.set(false);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async revoke(): Promise<void> {
		this.error.set(null);
		try {
			await this.health.revokeShare();
			this.status.set({ active: false });
			this.copied.set(false);
		} catch (e) {
			this.error.set((e as Error).message);
		}
	}

	async copyLink(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this.copied.set(true);
			// reset after 2s
			setTimeout(() => this.copied.set(false), 2000);
		} catch {
			this.error.set("Could not copy — select and copy manually.");
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
