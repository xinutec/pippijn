import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'home-theme';

/**
 * Tracks the user's theme preference (light / dark / follow-system) and applies
 * it by toggling `color-scheme` on the document, which drives Material 3's
 * `light dark` system variables.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
	private readonly doc = inject(DOCUMENT);
	private readonly media =
		typeof this.doc.defaultView?.matchMedia === 'function'
			? this.doc.defaultView.matchMedia('(prefers-color-scheme: dark)')
			: undefined;

	private readonly _mode = signal<ThemeMode>(this.readStored());
	private readonly _systemDark = signal(this.media?.matches ?? false);

	readonly mode = this._mode.asReadonly();

	/** The colour scheme actually in effect right now. */
	readonly effective = computed<'light' | 'dark'>(() => {
		const mode = this._mode();
		if (mode === 'system') {
			return this._systemDark() ? 'dark' : 'light';
		}
		return mode;
	});

	constructor() {
		this.media?.addEventListener('change', (e) => this._systemDark.set(e.matches));
		effect(() => {
			const scheme = this.effective();
			this.doc.documentElement.style.colorScheme = scheme;
			this.doc.body.style.colorScheme = scheme;
		});
	}

	/** Cycle light → dark → system. */
	toggle(): void {
		const next: Record<ThemeMode, ThemeMode> = {
			light: 'dark',
			dark: 'system',
			system: 'light',
		};
		const value = next[this._mode()];
		this._mode.set(value);
		try {
			this.doc.defaultView?.localStorage.setItem(STORAGE_KEY, value);
		} catch {
			// Ignore storage failures (private mode, etc.).
		}
	}

	private readStored(): ThemeMode {
		try {
			const v = this.doc.defaultView?.localStorage.getItem(STORAGE_KEY);
			if (v === 'light' || v === 'dark' || v === 'system') {
				return v;
			}
		} catch {
			// Ignore.
		}
		return 'system';
	}
}
