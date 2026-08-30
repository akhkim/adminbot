// Click-and-drag horizontal panning for a wide table's scroller, shared by the Lab Members grid
// and the member roster: both are far wider than the viewport, and dragging the empty space
// between cells is how people expect to move sideways through a spreadsheet.
//
// The window listeners are installed on drag start and removed on drag end, so the handler
// stays a stable module-level reference and Lit re-renders never accumulate listeners. Drags
// starting on an interactive element are ignored so buttons, inputs, and links keep working --
// which matters more for the roster, where every cell is an input and a drag that started on one
// is the operator selecting text, not panning.
export function startSheetPan(event: MouseEvent): void {
  const scroller = event.currentTarget;
  if (!(scroller instanceof HTMLElement) || event.button !== 0) {
    return;
  }
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("button, input, select, textarea, a, label, [popover]")
  ) {
    return;
  }
  const startX = event.pageX;
  const startScrollLeft = scroller.scrollLeft;
  scroller.classList.add("adminbot-member-sheet__scroll--panning");
  const onMove = (move: MouseEvent) => {
    scroller.scrollLeft = startScrollLeft - (move.pageX - startX);
  };
  const onUp = () => {
    scroller.classList.remove("adminbot-member-sheet__scroll--panning");
    globalThis.removeEventListener("mousemove", onMove);
    globalThis.removeEventListener("mouseup", onUp);
  };
  globalThis.addEventListener("mousemove", onMove);
  globalThis.addEventListener("mouseup", onUp);
}
