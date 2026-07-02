/** Companion to the `.add-fab` floating action button (styles.scss): the FAB
 *  is thumb-reachable at the bottom, but the add forms live at the top of the
 *  scroll — after revealing one, bring it into view and focus its first field
 *  so capture is type-ready in one tap. */
export function revealAddForm(): void {
  // Next tick: the @if block must render first.
  setTimeout(() => {
    const form = document.querySelector<HTMLElement>('.add, .form');
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form?.querySelector<HTMLElement>('input')?.focus();
  });
}
