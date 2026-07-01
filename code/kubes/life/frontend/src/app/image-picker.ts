import { Directive, input, output, signal } from '@angular/core';

/** Client-side ceiling, mirrors the backend's 5 MiB cap so we reject early. */
const MAX_BYTES = 5 * 1024 * 1024;

function firstImage(files: Iterable<File> | undefined): File | undefined {
  return Array.from(files ?? []).find((f) => f.type.startsWith('image/'));
}

/** Turns its host element into a one-tap image picker.
 *
 *  - **Click / Enter / Space** opens the native file dialog with
 *    `accept="image/*"` — on a phone that's Camera / Photo Library / Files in a
 *    single tap, which is the mobile stand-in for "paste an image".
 *  - **Paste** (Cmd/Ctrl+V while the host is focused) takes an image off the
 *    clipboard.
 *  - **Drag-and-drop** an image file onto the host.
 *
 *  Emits the chosen `Blob` via `imagePicked`; non-images and oversized files are
 *  rejected up front through `pickError`. The host gets button semantics so it's
 *  keyboard-reachable and screen-reader announced. */
@Directive({
  selector: '[appImagePicker]',
  exportAs: 'imagePicker',
  host: {
    role: 'button',
    tabindex: '0',
    'aria-label': 'Replace image',
    '[class.drag-over]': 'dragOver()',
    '(click)': 'onActivate()',
    '(keydown.enter)': 'onKey($event)',
    '(keydown.space)': 'onKey($event)',
    '(paste)': 'onPaste($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'dragOver.set(false)',
    '(drop)': 'onDrop($event)',
  },
})
export class ImagePickerDirective {
  readonly imagePicked = output<Blob>();
  readonly pickError = output<string>();
  /** True while a file is dragged over the host — drives a drop-zone outline. */
  readonly dragOver = signal(false);
  /** When false, a tap/Enter doesn't open the file dialog — the host drives it
   *  another way (e.g. a menu whose "Choose photo" item calls `openDialog()`).
   *  Paste and drag-and-drop still work regardless. */
  readonly clickToOpen = input(true);

  onActivate(): void {
    if (this.clickToOpen()) this.openDialog();
  }

  openDialog(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      this.accept(input.files?.[0]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  onKey(e: Event): void {
    e.preventDefault();
    this.onActivate();
  }

  onPaste(e: ClipboardEvent): void {
    const file = Array.from(e.clipboardData?.items ?? [])
      .find((i) => i.type.startsWith('image/'))
      ?.getAsFile();
    if (file) {
      e.preventDefault();
      this.accept(file);
    }
  }

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    this.accept(firstImage(e.dataTransfer?.files));
  }

  private accept(file: File | undefined | null): void {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.pickError.emit('That’s not an image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      this.pickError.emit('Image is larger than 5 MB.');
      return;
    }
    this.imagePicked.emit(file);
  }
}
