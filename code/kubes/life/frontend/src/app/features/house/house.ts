import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, inject, signal, viewChild } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { LifeApi } from '../../life-api';
import { HouseScene } from '../../models';
import { bounds, wallSegments } from './scene-geometry';

const WALL_COLOR = 0xb9b7bd;
const WALL_THICKNESS = 0.06;
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
    const segs = wallSegments(scene);
    this.empty.set(segs.length === 0);
    const h = scene.height;

    // Walls as thin upright boxes along each perimeter segment.
    const wallMat = new THREE.MeshStandardMaterial({
      color: WALL_COLOR,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    for (const s of segs) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (len < 1e-6) continue;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, WALL_THICKNESS), wallMat);
      mesh.position.set((s.ax + s.bx) / 2, h / 2, (s.az + s.bz) / 2);
      mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
      this.scene.add(mesh);
    }

    // Floor polygon from the perimeter outline.
    this.addFloor(scene);

    // Furniture as coloured boxes.
    for (const f of scene.furniture) {
      const mat = new THREE.MeshStandardMaterial({ color: f.color ?? DEFAULT_FURNITURE });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h, f.d), mat);
      mesh.position.set(f.cx, (f.y0 ?? 0) + f.h / 2, f.cz);
      this.scene.add(mesh);
    }

    this.frameBounds(scene);
  }

  private addFloor(scene: HouseScene): void {
    const shape = new THREE.Shape();
    const segs = wallSegments(scene);
    if (segs.length === 0) return;
    shape.moveTo(segs[0].ax, segs[0].az);
    for (const s of segs) shape.lineTo(s.bx, s.bz);
    const geom = new THREE.ShapeGeometry(shape);
    geom.rotateX(Math.PI / 2); // XY shape → XZ floor plane
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, side: THREE.DoubleSide }),
    );
    mesh.position.y = -0.01;
    this.scene.add(mesh);
  }

  private frameBounds(scene: HouseScene): void {
    const b = bounds(scene);
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
