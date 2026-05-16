// Canvas-based board renderer.
//
// Coordinate system: board[row][col], row 0..9, col 0..16.
// Layout: cells are square; canvas size is computed from container width.

export const ROWS = 10;
export const COLS = 17;

function rectsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
}

const APPLE_RED = "#e53935";
const APPLE_DARK = "#b71c1c";
const TEXT_COLOR = "#ffffff";
const BOARD_BG = "#ffffff";
const EMPTY_COLOR = "#f0f1f3";
const ME_BOX = "rgba(25, 118, 210, 0.18)";
const ME_BOX_OK = "rgba(46, 125, 50, 0.28)";
const ME_STROKE = "#1976d2";
const ME_STROKE_OK = "#2e7d32";
const OPP_BOX = "rgba(198, 40, 40, 0.18)";
const OPP_STROKE = "#c62828";
const GOLD = "#f6c244";
const GOLD_DARK = "#c98a10";
const HINT_FILL = "rgba(255, 235, 59, 0.55)";
const HINT_STROKE = "#fbc02d";

export class BoardRenderer {
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error("BoardRenderer: canvas element is null");
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mini = !!options.mini;
    this.board = null;
    this.myDrag = null;     // {r1,c1,r2,c2,sumOk}
    this.peerDrag = null;   // {r1,c1,r2,c2}
    this.cellSize = 0;
    this.padding = this.mini ? 2 : 4;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this._fadingCells = []; // [{r,c,start,duration}]
    this._raf = null;
    // Item-mode state
    this.goldenCells = new Set();   // "r,c" keys
    this.blind = false;             // hide numeric values
    this.hintCells = null;          // [[r,c], ...]
    this._shakeUntil = 0;
    // Keep bound refs so dispose() can actually removeEventListener them.
    // Inline arrow functions would leak — the listener stays attached to
    // window forever and keeps the whole renderer alive via closure.
    this._onWindowResize = () => this.resize();
    window.addEventListener("resize", this._onWindowResize);
    // Catch parent layout changes too (media-query breakpoints,
    // sidebar appearing, etc.) — without this, click coords go stale
    // when the board is resized by something other than the window.
    if (typeof ResizeObserver !== "undefined" && this.canvas.parentElement) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas.parentElement);
    }
  }

  dispose() {
    if (this._onWindowResize) {
      window.removeEventListener("resize", this._onWindowResize);
      this._onWindowResize = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._fadingCells = [];
    this.board = null;
    this.myDrag = null;
    this.peerDrag = null;
    this.hintCells = null;
    this.goldenCells.clear();
  }

  setBoard(board) {
    this.board = board.map((row) => row.slice());
    this.resize();
    this.render();
  }

  setGolden(r, c, on) {
    const key = `${r},${c}`;
    if (on) this.goldenCells.add(key);
    else this.goldenCells.delete(key);
    this.render();
  }

  clearGolden() {
    if (this.goldenCells.size === 0) return;
    this.goldenCells.clear();
    this.render();
  }

  setBlind(on) {
    if (this.blind === on) return;
    this.blind = on;
    this.render();
  }

  setHint(cells) {
    this.hintCells = cells && cells.length ? cells.slice() : null;
    this.render();
  }

  shakeOnce() {
    this._shakeUntil = performance.now() + 600;
    this._scheduleAnim();
  }

  clearCells(cells) {
    if (!this.board) return;
    const now = performance.now();
    for (const [r, c] of cells) {
      const v = this.board[r][c];
      if (v === 0) continue;  // already cleared (e.g. optimistic apply)
      const isGold = this.goldenCells.has(`${r},${c}`);
      this._fadingCells.push({ r, c, value: v, start: now, duration: 100, gold: isGold });
      this.board[r][c] = 0;
      this.goldenCells.delete(`${r},${c}`);
    }
    this._scheduleAnim();
  }

  // Instant clear (no fade) — used by replay seek so we can rebuild
  // arbitrary points in the timeline without queuing animations.
  applyClear(cells) {
    if (!this.board) return;
    for (const [r, c] of cells) {
      this.board[r][c] = 0;
      this.goldenCells.delete(`${r},${c}`);
    }
    this.render();
  }

  // Undo a recent clear — used to roll back an optimistic local apply
  // when the server rejects the submit.
  restoreCells(cells) {
    if (!this.board) return;
    const keys = new Set();
    for (const c of cells) {
      this.board[c.r][c.c] = c.value;
      keys.add(c.r + "," + c.c);
    }
    // Cancel any in-flight fade for these cells so they snap back cleanly
    this._fadingCells = this._fadingCells.filter(
      (f) => !keys.has(f.r + "," + f.c),
    );
    this.render();
  }

  setMyDrag(rect) {
    if (rectsEqual(rect, this.myDrag)) return;  // skip needless rerenders
    this.myDrag = rect;
    this.render();
  }
  setPeerDrag(rect) {
    if (rectsEqual(rect, this.peerDrag)) return;
    this.peerDrag = rect;
    this.render();
  }

  shouldRotate() {
    if (this.mini) return false;
    return window.matchMedia("(orientation: portrait) and (max-width: 900px)").matches;
  }

  resize() {
    // The main board now sits inside a .board-wrap whose size is dictated
    // by the canvas itself (inline-block). To break the chicken-and-egg
    // loop we read sizing from the surrounding .board-area, which has
    // independent flex sizing. Mini canvases keep the parent lookup.
    const wrap = this.mini
      ? this.canvas.parentElement
      : (this.canvas.closest(".board-area") || this.canvas.parentElement);
    if (!wrap) return;
    const cs = window.getComputedStyle(wrap);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    this.rotated = this.shouldRotate();

    const availW = Math.max(120, wrap.clientWidth - padX);
    const cellByW = Math.floor((availW - this.padding * 2) / COLS);
    let cellByH = Infinity;
    if (!this.mini) {
      // Rotated mode: parent has explicit flex sizing — its clientHeight is
      // the actual visual envelope. Otherwise use viewport-based cap so we
      // don't get into a parent-shrinks-because-canvas-shrinks loop.
      let usable;
      if (this.rotated) {
        usable = Math.max(120, wrap.clientHeight - padY);
      } else {
        usable = Math.max(150, window.innerHeight * 0.72);
      }
      cellByH = Math.floor((usable - this.padding * 2) / ROWS);
    }
    let cell = Math.min(cellByW, cellByH);
    cell = Math.max(8, cell);
    this.cellSize = cell;
    const cssW = cell * COLS + this.padding * 2;
    const cssH = cell * ROWS + this.padding * 2;
    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.render();
  }

  cellAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const bl = this.canvas.clientLeft;
    const bt = this.canvas.clientTop;
    let x, y;
    if (this.rotated) {
      // CSS transform: translate(cssH, 0) rotate(90deg) — visual (vx, vy)
      // maps back to canvas-local (vy, cssH - vx).
      const cssH = this.cellSize * ROWS + this.padding * 2;
      const vx = clientX - rect.left;
      const vy = clientY - rect.top;
      x = vy;
      y = cssH - vx;
    } else {
      x = clientX - rect.left - bl;
      y = clientY - rect.top - bt;
    }
    x -= this.padding;
    y -= this.padding;
    const c = Math.floor(x / this.cellSize);
    const r = Math.floor(y / this.cellSize);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    return { r, c };
  }

  rectCenter(rect) {
    if (!rect) return null;
    const cx = this.padding + ((rect.c1 + rect.c2 + 1) / 2) * this.cellSize;
    const cy = this.padding + (rect.r1 * this.cellSize);
    const canvasRect = this.canvas.getBoundingClientRect();
    const bl = this.canvas.clientLeft;
    const bt = this.canvas.clientTop;
    if (this.rotated) {
      // After 90° CW rotation, "above the rect" in the user's view is +x in
      // viewport. Push the anchor a bit further past the rect's user-top
      // edge so the (centered) badge floats clearly above instead of
      // overlapping the cells.
      const cssH = this.cellSize * ROWS + this.padding * 2;
      const offset = Math.max(20, this.cellSize * 0.7);
      return {
        x: canvasRect.left + (cssH - cy) + offset,
        y: canvasRect.top + cx,
      };
    }
    return { x: canvasRect.left + bl + cx, y: canvasRect.top + bt + cy };
  }

  sumIn(rect) {
    if (!rect || !this.board) return 0;
    let total = 0;
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        total += this.board[r][c] || 0;
      }
    }
    return total;
  }

  render() {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;

    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.board) return;

    // Shake transform for shuffle effect
    const now = performance.now();
    let shaking = false;
    if (this._shakeUntil > now) {
      shaking = true;
      const tLeft = (this._shakeUntil - now) / 600;
      const mag = Math.max(2, cs * 0.08) * tLeft;
      const dx = (Math.random() * 2 - 1) * mag;
      const dy = (Math.random() * 2 - 1) * mag;
      ctx.save();
      ctx.translate(dx, dy);
    }

    // Hint highlight (under apples so they remain readable)
    if (this.hintCells) {
      for (const [r, c] of this.hintCells) {
        const x = pad + c * cs;
        const y = pad + r * cs;
        ctx.fillStyle = HINT_FILL;
        ctx.strokeStyle = HINT_STROKE;
        ctx.lineWidth = 2;
        this._roundedRect(x + 1, y + 1, cs - 2, cs - 2, 4);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Apples
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = this.board[r][c];
        const x = pad + c * cs;
        const y = pad + r * cs;
        if (v === 0) {
          ctx.fillStyle = EMPTY_COLOR;
          this._roundedRect(x + 2, y + 2, cs - 4, cs - 4, 4);
          ctx.fill();
        } else {
          const gold = this.goldenCells.has(`${r},${c}`);
          this._drawApple(x, y, cs, v, 1.0, 1.0, { gold, hideNumber: this.blind });
        }
      }
    }

    // Fading (recently cleared) apples
    this._fadingCells = this._fadingCells.filter((f) => {
      const t = (now - f.start) / f.duration;
      if (t >= 1) return false;
      const x = pad + f.c * cs;
      const y = pad + f.r * cs;
      this._drawApple(x, y, cs, f.value, 1 - t, 1 + t * 0.4, { gold: f.gold, hideNumber: this.blind });
      return true;
    });

    // Peer drag
    if (this.peerDrag) this._drawDragRect(this.peerDrag, OPP_BOX, OPP_STROKE);

    // My drag
    if (this.myDrag) {
      const sum = this.sumIn(this.myDrag);
      const color = sum === 10 ? ME_BOX_OK : ME_BOX;
      const stroke = sum === 10 ? ME_STROKE_OK : ME_STROKE;
      this._drawDragRect(this.myDrag, color, stroke);
    }

    if (shaking) ctx.restore();
    if (this._shakeUntil > now) this._scheduleAnim();
  }

  _drawApple(x, y, cs, value, alpha = 1, scale = 1, opts = {}) {
    const ctx = this.ctx;
    const cx = x + cs / 2;
    const cy = y + cs / 2;
    const margin = this.mini ? 0.5 : 2;
    const r = (cs / 2 - margin) * scale;
    const gold = !!opts.gold;
    const hideNumber = !!opts.hideNumber;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (this.mini) {
      ctx.fillStyle = gold ? GOLD : APPLE_RED;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (gold) {
        ctx.strokeStyle = GOLD_DARK;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
      if (gold) {
        grad.addColorStop(0, "#fff7c2");
        grad.addColorStop(0.55, GOLD);
        grad.addColorStop(1, GOLD_DARK);
      } else {
        grad.addColorStop(0, APPLE_RED);
        grad.addColorStop(1, APPLE_DARK);
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (gold) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.6;
        ctx.strokeStyle = GOLD_DARK;
        ctx.lineWidth = Math.max(2, cs * 0.08);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = gold ? "#8b6900" : "#5d4037";
      ctx.lineWidth = Math.max(1.5, cs * 0.06);
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.15, cy - r - r * 0.18);
      ctx.stroke();
      if (!hideNumber) {
        ctx.fillStyle = gold ? "#3a2a00" : TEXT_COLOR;
        ctx.font = `bold ${Math.floor(cs * 0.5)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(value), cx, cy + 1);
      } else {
        // Blind: faint placeholder so the apple still looks "occupied"
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = `bold ${Math.floor(cs * 0.5)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("?", cx, cy + 1);
      }
    }
    ctx.restore();
  }

  _drawDragRect(rect, fill, stroke) {
    const cs = this.cellSize;
    const pad = this.padding;
    const x = pad + rect.c1 * cs;
    const y = pad + rect.r1 * cs;
    const w = (rect.c2 - rect.c1 + 1) * cs;
    const h = (rect.r2 - rect.r1 + 1) * cs;
    this.ctx.fillStyle = fill;
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = 2;
    this._roundedRect(x, y, w, h, 4);
    this.ctx.fill();
    this.ctx.stroke();
  }

  _roundedRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _scheduleAnim() {
    if (this._raf) return;
    const tick = () => {
      this._raf = null;
      this.render();
      if (this._fadingCells.length > 0) this._scheduleAnim();
    };
    this._raf = requestAnimationFrame(tick);
  }
}
