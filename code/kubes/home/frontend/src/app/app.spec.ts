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

	it('has a "Show IDs" preference, off by default, that toggles', () => {
		const app = TestBed.createComponent(App).componentInstance;
		expect(app['showIds']()).toBe(false);
		app['toggleShowIds']();
		expect(app['showIds']()).toBe(true);
	});

	it('shortId shows only the distinguishing Govee suffix, other ids whole', () => {
		const app = TestBed.createComponent(App).componentInstance;
		expect(app['shortId']('govee-A562')).toBe('A562');
		expect(app['shortId']('airvisual')).toBe('airvisual');
	});
});
