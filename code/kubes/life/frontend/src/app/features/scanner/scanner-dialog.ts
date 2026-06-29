import { Component, ElementRef, OnDestroy, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

// BarcodeDetector is a browser global (Chromium) with no TS lib types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const BarcodeDetector: any;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private detector?: any;

  constructor() {
    afterNextRender(() => void this.start());
  }

  private async start(): Promise<void> {
    if (typeof BarcodeDetector === 'undefined') {
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
      this.scanLoop();
    } catch {
      this.error.set('Couldn’t access the camera.');
    }
  }

  private scanLoop = async (): Promise<void> => {
    const video = this.videoRef()?.nativeElement;
    if (this.detector && video && video.readyState >= 2) {
      try {
        const codes = await this.detector.detect(video);
        if (codes.length && codes[0].rawValue) {
          this.finish(codes[0].rawValue as string);
          return;
        }
      } catch {
        /* transient detect error — keep scanning */
      }
    }
    this.raf = requestAnimationFrame(() => void this.scanLoop());
  };

  private finish(code: string): void {
    this.cleanup();
    this.ref.close(code);
  }

  cancel(): void {
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
