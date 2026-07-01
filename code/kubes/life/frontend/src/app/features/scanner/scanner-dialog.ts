import { Component, ElementRef, OnDestroy, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

// BarcodeDetector is a browser global (Chromium) with no TS lib types, so give
// it the minimal shape we use — typed, not `any`, so the call sites stay safe.
interface DetectedBarcode {
  readonly rawValue: string;
  readonly format: string;
}
interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
declare const BarcodeDetector: new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];

/** Full-bleed camera dialog. Closes with the detected barcode string, or null
 *  if cancelled / unsupported. Uses the native BarcodeDetector — no library. */
@Component({
  selector: 'app-scanner-dialog',
  templateUrl: './scanner-dialog.html',
  styleUrl: './scanner-dialog.scss',
  imports: [MatButtonModule, MatIconModule],
})
export class ScannerDialog implements OnDestroy {
  private ref = inject<MatDialogRef<ScannerDialog, string | null>>(MatDialogRef);
  private videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly error = signal<string | null>(null);

  private stream?: MediaStream;
  private raf = 0;
  private frames = 0;
  private detectErrorLogged = false;
  private detector?: BarcodeDetectorInstance;

  constructor() {
    afterNextRender(() => void this.start());
  }

  // Traced with a stable prefix so it's greppable in the Android WebView's
  // logcat (the wrapper forwards console messages). See android/MainActivity.kt.
  private log(...args: unknown[]): void {
    console.debug('[scan]', ...args);
  }

  private async start(): Promise<void> {
    this.log('opening scanner');
    if (typeof BarcodeDetector === 'undefined') {
      this.log('BarcodeDetector unsupported');
      this.error.set('Barcode scanning isn’t supported in this browser — enter the code manually.');
      return;
    }
    const video = this.videoRef()?.nativeElement;
    if (!video) return;
    try {
      this.detector = new BarcodeDetector({ formats: FORMATS });
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = this.stream;
      await video.play();
      this.log('camera opened', `${video.videoWidth}x${video.videoHeight}`);
      void this.scanLoop();
    } catch (e) {
      this.log('camera error', String(e));
      this.error.set('Couldn’t access the camera.');
    }
  }

  private scanLoop = async (): Promise<void> => {
    const video = this.videoRef()?.nativeElement;
    if (this.detector && video && video.readyState >= 2) {
      this.frames++;
      try {
        const codes = await this.detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          this.log('decoded', codes[0].rawValue, codes[0].format, `after ${this.frames} frames`);
          this.finish(codes[0].rawValue);
          return;
        }
      } catch (e) {
        // Detect can throw transiently; log only the first so it doesn't spam.
        if (!this.detectErrorLogged) {
          this.detectErrorLogged = true;
          this.log('detect error', String(e));
        }
      }
      // Heartbeat (~1/s at 60fps) so a non-detecting camera is distinguishable
      // from a stalled loop.
      if (this.frames % 60 === 0) this.log('scanning…', `${this.frames} frames, no code yet`);
    }
    this.raf = requestAnimationFrame(() => void this.scanLoop());
  };

  private finish(code: string): void {
    this.cleanup();
    this.ref.close(code);
  }

  cancel(): void {
    this.log('cancelled', `after ${this.frames} frames`);
    this.cleanup();
    this.ref.close(null);
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  ngOnDestroy(): void {
    this.cleanup();
  }
}
