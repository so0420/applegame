// Pointer Events handler — unifies mouse + touch + pen.

const DRAG_THROTTLE_MS = 30;

export function attachDragInput(canvas, renderer, callbacks) {
  let dragging = false;
  let pointerId = null;
  let start = null;
  let lastSent = 0;

  function rectFrom(a, b) {
    return {
      r1: Math.min(a.r, b.r),
      c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r),
      c2: Math.max(a.c, b.c),
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
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
    if (!dragging || e.pointerId !== pointerId) return;
    const cell = renderer.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const rect = rectFrom(start, cell);
    renderer.setMyDrag(rect);
    const now = performance.now();
    if (now - lastSent >= DRAG_THROTTLE_MS) {
      lastSent = now;
      callbacks.onUpdate?.(rect);
    }
  });

  function endDrag(e) {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
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
