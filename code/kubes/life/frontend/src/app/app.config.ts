import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from "@angular/core";
import { provideHttpClient, withFetch } from "@angular/common/http";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { provideServiceWorker } from "@angular/service-worker";

import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // Cache the app shell + read data so the app opens and shows your things
    // offline (prod build only). registerImmediately, not registerWhenStable:
    // the offline-first Buy list keeps the app "unstable" (its sync retries), so
    // waiting for stability would delay caching up to 30s — register now so the
    // cache is ready the moment you open the app (e.g. before the Tube).
    provideServiceWorker("ngsw-worker.js", {
      enabled: !isDevMode(),
      registrationStrategy: "registerImmediately",
    }),
  ],
};
