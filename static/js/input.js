// Pointer Events handler — unifies mouse + touch + pen.

const DRAG_THROTTLE_MS = 60;

// Anti-macro: only honour pointer events that the browser itself dispatched.
// Synthetic events created via element.dispatchEvent(new PointerEvent(...))
// arrive with isTrusted === false and are the primary way extensions /
// userscripts drive macros. Real user input has isTrusted === true.
function isReal(e) {
  return e && e.isTrusted === true;
}

export function attachDragInput(canvas, renderer, callbacks) {
  let dragging = false;
  let pointerId = null;
  let start = null;
  let lastSent = 0;
  let lastSentRect = null;

  function rectFrom(a, b) {
    return {
      r1: Math.min(a.r, b.r),
      c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r),
      c2: Math.max(a.c, b.c),
    };
  }
  function rectsEqual(a, b) {
    if (!a || !b) return false;
    return a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!isReal(e)) return;
    if (e.button && e.button !== 0) return;
    const cell = renderer.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    dragging = true;
    pointerId = e.pointerId;
    start = cell;
    canvas.setPointerCapture(e.pointerId);
    const rect = rectFrom(cell, cell);
    renderer.setMyDrag(rect);
    callbacks.onUpdate?.(rect);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!isReal(e)) return;
    if (!dragging || e.pointerId !== pointerId) return;
    const cell = renderer.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const rect = rectFrom(start, cell);
    renderer.setMyDrag(rect);
    // Throttle the network broadcast AND skip if the rect didn't change
    // (pointer moved within the same cell / outside the board) — biggest
    // single source of WS traffic during play.
    const now = performance.now();
    if (now - lastSent >= DRAG_THROTTLE_MS && !rectsEqual(rect, lastSentRect)) {
      lastSent = now;
      lastSentRect = rect;
      callbacks.onUpdate?.(rect);
    }
  });

  function endDrag(e) {
    if (e && !isReal(e)) return;
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    lastSentRect = null;
    try { if (e) canvas.releasePointerCapture(e.pointerId); } catch {}
    const rect = renderer.myDrag;
    renderer.setMyDrag(null);
    if (rect) callbacks.onSubmit?.(rect);
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", (e) => {
    // If pointer leaves while button up, end gracefully
    if (!dragging) return;
    if (e.buttons === 0) endDrag(e);
  });
}
