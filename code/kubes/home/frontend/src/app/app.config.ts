import { provideHttpClient, withFetch } from '@angular/common/http';
import {
	type ApplicationConfig,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideHttpClient(withFetch()),
		provideAnimationsAsync(),
	],
};
