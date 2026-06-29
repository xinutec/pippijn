import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch()),
    // A single componentless catch-all: the app is one shell component, but the
    // router gives us query-param navigation state (?origin, ?chat) so it's in
    // the URL — bookmarkable, refresh-safe, and Back-button-aware.
    provideRouter([{ path: '**', children: [] }]),
  ],
};
