import { Component, inject, signal } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatToolbarModule } from "@angular/material/toolbar";

import { CoachApi } from "./coach-api";
import { Me } from "./models";
import { SwUpdates } from "./sw-updates";

interface NavItem {
  path: string;
  icon: string;
  label: string;
}

@Component({
  selector: "app-root",
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatToolbarModule,
  ],
})
export class App {
  private api = inject(CoachApi);
  private swUpdates = inject(SwUpdates);

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);
  readonly avatarError = signal(false);

  readonly nav: NavItem[] = [
    { path: "/today", icon: "bolt", label: "Today" },
    { path: "/program", icon: "calendar_month", label: "Program" },
    { path: "/history", icon: "history", label: "History" },
    { path: "/settings", icon: "settings", label: "Settings" },
  ];

  constructor() {
    this.swUpdates.start();
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loading.set(false);
      },
      error: () => {
        this.me.set(null);
        this.loading.set(false);
      },
    });
  }

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = "/"));
  }
}
