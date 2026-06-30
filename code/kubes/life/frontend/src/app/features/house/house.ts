import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  inject,
  isDevMode,
  signal,
  viewChild,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { LifeApi } from '../../life-api';
import { HouseScene, WallOpening } from '../../models';
import { bounds, roomPerimeter, segments } from './scene-geometry';
import type { Pt, WallSeg } from './scene-geometry';

const WALL_COLOR = 0xb9b7bd;
const RED_COLOR = 0xff5252;
const FLOOR_COLOR = 0x1b1f24;
const DEFAULT_FURNITURE = '#9e9e9e';

@Component({
  selector: 'app-house',
  templateUrl: './house.html',
  styleUrl: './house.scss',
})
export class House implements AfterViewInit, OnDestroy {
  readonly empty = signal(false);

  private api = inject(LifeApi);
  private zone = inject(NgZone);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('canvas');

  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private frame = 0;
  private resize?: ResizeObserver;

  ngAfterViewInit(): void {
    this.initThree();
    this.api.house().subscribe({
      next: (scene) => this.buildHouse(scene),
      error: () => this.empty.set(true),
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
  }

  private initThree(): void {
    const host = this.host().nativeElement;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(host.clientWidth, host.clientHeight || 400);
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene.background = new THREE.Color(0x101418);

    this.camera = new THREE.PerspectiveCamera(50, this.aspect(), 0.1, 200);
    this.camera.position.set(6, 6, 8);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);
    this.scene.add(new THREE.GridHelper(20, 20, 0x2a2f36, 0x20242a));

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.zone.runOutsideAngular(() => this.animate());
  }

  private buildHouse(scene: HouseScene): void {
    const h = scene.height;
    const wallMat = new THREE.MeshStandardMaterial({
      color: WALL_COLOR,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    // A `?red=14,5` URL param tints those walls (by GLOBAL index — walls are
    // counted across the rooms in order) semi-transparent red, same opacity.
    const red = this.redWalls();
    const redMat = new THREE.MeshStandardMaterial({
      color: RED_COLOR,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });

    // Each room is its own outline: render its walls (cut by its openings) and
    // its floor. A wall shared between two rooms is simply drawn by each of them.
    let n = 0;
    const allPts: Pt[] = [];
    for (const room of scene.rooms ?? []) {
      const pts = roomPerimeter(room);
      allPts.push(...pts);
      const ops = room.openings ?? [];
      segments(pts).forEach((s, i) => {
        this.renderWall(s, ops.filter((o) => o.wall === i), h, red.has(n) ? redMat : wallMat);
        if (isDevMode()) {
          // Number each wall (global index) so you can say "change wall 7".
          const label = this.numberSprite(String(n));
          label.position.set((s.ax + s.bx) / 2, h * 0.5, (s.az + s.bz) / 2);
          this.scene.add(label);
        }
        n++;
      });
      this.addFloor(pts);
    }
    this.empty.set(n === 0);

    // Furniture as coloured boxes (world coordinates).
    for (const f of scene.furniture ?? []) {
      const mat = new THREE.MeshStandardMaterial({ color: f.color ?? DEFAULT_FURNITURE });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d), mat);
      mesh.position.set(f.cx, (f.y0 ?? 0) + f.h / 2, f.cz);
      this.scene.add(mesh);
    }

    this.frameBounds(allPts);
  }

  // A camera-facing number on a dark disc — drawn to a canvas, used as a sprite
  // texture. depthTest off + high renderOrder so it's never hidden by walls.
  private numberSprite(text: string): THREE.Sprite {
    const px = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(16,20,24,0.88)';
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd166';
    ctx.font = `bold ${px * 0.52}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px / 2, px / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
    );
    sprite.scale.setScalar(0.45);
    sprite.renderOrder = 999;
    return sprite;
  }

  // Wall indices to tint red, from the `?red=14,5` query param (debug marking).
  private redWalls(): Set<number> {
    const raw = new URLSearchParams(window.location.search).get('red') ?? '';
    return new Set(
      raw
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n)),
    );
  }

  // Render one wall segment, cut by its openings: solid piers between/around the
  // openings, a lintel above each, and a sill below (for windows). A full-width
  // floor-to-`height` opening therefore leaves only the lintel — i.e. a header.
  private renderWall(s: WallSeg, ops: WallOpening[], h: number, mat: THREE.Material): void {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    if (len < 1e-6) return;
    const cuts = ops
      .map((o) => ({ a0: o.offset, a1: o.offset + o.width, yb: o.sill ?? 0, yt: (o.sill ?? 0) + o.height }))
      .sort((p, q) => p.a0 - q.a0);
    if (cuts.length === 0) {
      this.addWallPanel(s, len, 0, len, 0, h, mat);
      return;
    }
    let cursor = 0;
    for (const c of cuts) {
      const a0 = Math.max(0, Math.min(len, c.a0));
      const a1 = Math.max(0, Math.min(len, c.a1));
      if (a0 > cursor) this.addWallPanel(s, len, cursor, a0, 0, h, mat);
      if (c.yt < h) this.addWallPanel(s, len, a0, a1, c.yt, h, mat);
      if (c.yb > 0) this.addWallPanel(s, len, a0, a1, 0, c.yb, mat);
      cursor = Math.max(cursor, a1);
    }
    if (cursor < len) this.addWallPanel(s, len, cursor, len, 0, h, mat);
  }

  // One rectangular slab of a wall, spanning [a0,a1] along the segment (metres
  // from its start) and [yb,yt] vertically. Used to build piers/lintels/sills
  // around openings.
  private addWallPanel(
    s: WallSeg,
    len: number,
    a0: number,
    a1: number,
    yb: number,
    yt: number,
    mat: THREE.Material,
  ): void {
    const w = a1 - a0;
    const ht = yt - yb;
    if (w < 1e-6 || ht < 1e-6) return;
    const dx = (s.bx - s.ax) / len;
    const dz = (s.bz - s.az) / len;
    const along = (a0 + a1) / 2;
    // A flat plane (no thickness); rotated about Y so its width runs along the
    // wall, height stays vertical, normal points across the wall. Double-sided
    // material shows it from inside and out.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, ht), mat);
    mesh.position.set(s.ax + dx * along, (yb + yt) / 2, s.az + dz * along);
    mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
    this.scene.add(mesh);
  }

  private addFloor(pts: Pt[]): void {
    if (pts.length < 3) return;
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].z);
    for (const p of pts.slice(1)) shape.lineTo(p.x, p.z);
    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(Math.PI / 2); // XY shape → XZ floor plane
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, side: THREE.DoubleSide }),
    );
    mesh.position.y = -0.01;
    this.scene.add(mesh);
  }

  private frameBounds(pts: Pt[]): void {
    const b = bounds(pts);
    if (!b || !this.camera || !this.controls) return;
    this.controls.target.set(b.cx, 1, b.cz);
    this.camera.position.set(b.cx + b.span * 0.9, b.span * 0.9, b.cz + b.span * 1.2);
    this.controls.update();
  }

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls?.update();
    if (this.renderer && this.camera) this.renderer.render(this.scene, this.camera);
  };

  private aspect(): number {
    const host = this.host().nativeElement;
    return host.clientWidth / (host.clientHeight || 400);
  }

  private onResize(): void {
    const host = this.host().nativeElement;
    this.renderer?.setSize(host.clientWidth, host.clientHeight || 400);
    if (this.camera) {
      this.camera.aspect = this.aspect();
      this.camera.updateProjectionMatrix();
    }
  }
}
