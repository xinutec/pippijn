import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { App } from './app';

describe('App', () => {
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideZonelessChangeDetection(),
				provideHttpClient(),
				provideHttpClientTesting(),
			],
		}).compileComponents();
	});

	it('should create the app', () => {
		const fixture = TestBed.createComponent(App);
		expect(fixture.componentInstance).toBeTruthy();
	});

	it('renders the brand title in the toolbar', async () => {
		const fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		await fixture.whenStable();
		const compiled = fixture.nativeElement as HTMLElement;
		expect(compiled.querySelector('.brand-title')?.textContent).toContain('Home');
	});

	it('offers a "Show IDs" toggle, off by default', async () => {
		const fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		await fixture.whenStable();
		const compiled = fixture.nativeElement as HTMLElement;
		const labels = [...compiled.querySelectorAll('mat-slide-toggle')].map((t) => t.textContent);
		expect(labels.some((l) => l?.includes('Show IDs'))).toBe(true);
		expect(fixture.componentInstance['showIds']()).toBe(false);
	});
});
