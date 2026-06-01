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

// Warm cream/sage palette — matches the new CSS design tokens.
const APPLE_LIGHT = "#E5675A";     // top-left highlight side
const APPLE_BASE  = "#C44536";     // mid body
const APPLE_DEEP  = "#8E2D24";     // bottom-right shading
const APPLE_OUTLINE = "rgba(70,20,15,0.18)";
const LEAF_LIGHT = "#7AA876";
const LEAF_DEEP  = "#4A6B4A";
const STEM_COLOR = "#5A3E2B";
const TEXT_COLOR = "#FFFFFF";
const BOARD_BG = "transparent";
const EMPTY_COLOR = "rgba(91, 117, 83, 0.06)";  // sage-tinted hollow
const ME_BOX = "rgba(91, 117, 83, 0.16)";       // sage drag
const ME_BOX_OK = "rgba(91, 117, 83, 0.34)";    // sum=10 → stronger sage
const ME_STROKE = "#5B7553";
const ME_STROKE_OK = "#3E5A38";
const OPP_BOX = "rgba(196, 69, 54, 0.16)";
const OPP_STROKE = "#C44536";
const GOLD_LIGHT = "#F5D27A";
const GOLD_BASE  = "#E5A21F";
const GOLD_DEEP  = "#A07015";
const GOLD_OUTLINE = "rgba(80,50,5,0.22)";
const HINT_FILL = "rgba(229, 162, 31, 0.22)";
const HINT_STROKE = "#E5A21F";

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
    this.overload = false;          // show deceptive (value+1) numbers
    this.hintCells = null;          // [[r,c], ...]
    this._shakeUntil = 0;
    // Pre-built Path2D for the apple silhouette / leaf in unit coords (0..1).
    // Drawn once, scaled per-cell — cheaper than rebuilding bezier curves
    // for every one of the 170 cells per frame.
    this._applyBodyPath = _buildAppleBodyPath();
    this._applyLeafPath = _buildLeafPath();
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

  setOverload(on) {
    if (this.overload === on) return;
    this.overload = on;
    this.render();
  }

  // Deceptive value shown under the "overload" attack: 1..9 shifted up by
  // one (9 wraps to 1) so the displayed number is always wrong but still a
  // single digit. Real board values are untouched — server validation and
  // the optimistic clear both use the true values.
  _displayValue(v) {
    return (v % 9) + 1;
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
    this._dropHintCells(cells);
    this._scheduleAnim();
  }

  // Drop any of `cells` from the active hint highlight so a stale border
  // can't survive the apple it was pointing at.
  _dropHintCells(cells) {
    if (!this.hintCells || !this.hintCells.length) return;
    const gone = new Set(cells.map(([r, c]) => `${r},${c}`));
    const left = this.hintCells.filter(([r, c]) => !gone.has(`${r},${c}`));
    this.hintCells = left.length ? left : null;
  }

  // Instant clear (no fade) — used by replay seek so we can rebuild
  // arbitrary points in the timeline without queuing animations.
  applyClear(cells) {
    if (!this.board) return;
    for (const [r, c] of cells) {
      this.board[r][c] = 0;
      this.goldenCells.delete(`${r},${c}`);
    }
    this._dropHintCells(cells);
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
        const v = this.board[r][c] || 0;
        if (!v) continue;
        // While overloaded the running-sum badge must reflect the deceptive
        // numbers the player sees, otherwise the trap is obvious.
        total += this.overload ? this._displayValue(v) : v;
      }
    }
    return total;
  }

  render() {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (BOARD_BG !== "transparent") {
      ctx.fillStyle = BOARD_BG;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

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

    // Hint highlight (under apples so they remain readable). Skip cells
    // already cleared so the highlight border vanishes the instant a
    // hinted apple is removed (otherwise it lingers over an empty cell).
    if (this.hintCells) {
      for (const [r, c] of this.hintCells) {
        if (!this.board[r] || !this.board[r][c]) continue;
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
    const gold = !!opts.gold;
    const hideNumber = !!opts.hideNumber;

    // Tiny cells (mini leaderboard boards) can't carry the detailed
    // silhouette legibly — fall back to a clean filled lobe + leaf dot.
    if (this.mini || cs < 16) {
      const cx = x + cs / 2;
      const cy = y + cs / 2;
      const r = (cs / 2 - (this.mini ? 0.5 : 1.5)) * scale;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = gold ? GOLD_BASE : APPLE_BASE;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // Single leaf nub so even minis read as "apple".
      ctx.fillStyle = gold ? GOLD_DEEP : LEAF_DEEP;
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.35, cy - r * 0.85, r * 0.32, r * 0.16, -0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Full apple: scale the unit-coord Path2D into the cell. A small
    // negative inset keeps the silhouette off the grid lines.
    const inset = cs * 0.02;
    const size = (cs - inset * 2) * scale;
    const cx = x + cs / 2;
    const cy = y + cs / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    // Translate so the unit shape (centred at 0.5,0.56) sits in the cell.
    ctx.translate(cx, cy);
    ctx.scale(size, size);
    ctx.translate(-0.5, -0.56);

    // Soft contact shadow under the apple.
    ctx.save();
    ctx.globalAlpha = alpha * 0.18;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(0.5, 0.93, 0.30, 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- Leaf (behind body shoulder) ---
    const leafGrad = ctx.createLinearGradient(0.5, 0.05, 0.8, 0.22);
    leafGrad.addColorStop(0, LEAF_LIGHT);
    leafGrad.addColorStop(1, LEAF_DEEP);
    ctx.fillStyle = leafGrad;
    ctx.fill(this._applyLeafPath);

    // --- Stem ---
    ctx.strokeStyle = STEM_COLOR;
    ctx.lineWidth = 0.045;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0.5, 0.20);
    ctx.lineTo(0.485, 0.07);
    ctx.stroke();

    // --- Body ---
    // Diagonal gradient: lit upper-left → deep lower-right.
    const grad = ctx.createLinearGradient(0.2, 0.22, 0.85, 0.92);
    if (gold) {
      grad.addColorStop(0, GOLD_LIGHT);
      grad.addColorStop(0.55, GOLD_BASE);
      grad.addColorStop(1, GOLD_DEEP);
    } else {
      grad.addColorStop(0, APPLE_LIGHT);
      grad.addColorStop(0.55, APPLE_BASE);
      grad.addColorStop(1, APPLE_DEEP);
    }
    ctx.fillStyle = grad;
    ctx.fill(this._applyBodyPath);

    // Thin outline crisps the silhouette against light backgrounds.
    ctx.strokeStyle = gold ? GOLD_OUTLINE : APPLE_OUTLINE;
    ctx.lineWidth = 0.02;
    ctx.stroke(this._applyBodyPath);

    // --- Specular highlight (upper-left) ---
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;
    const hl = ctx.createRadialGradient(0.34, 0.38, 0.01, 0.34, 0.38, 0.16);
    hl.addColorStop(0, "rgba(255,255,255,0.95)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.ellipse(0.34, 0.40, 0.13, 0.18, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // --- Number (drawn in cell pixel space, not the scaled unit space) ---
    const shown = this.overload ? this._displayValue(value) : value;
    const label = hideNumber ? "?" : String(shown);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = hideNumber ? "rgba(255,255,255,0.85)" : TEXT_COLOR;
    ctx.font = `700 ${Math.floor(cs * 0.46)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(60,15,10,0.35)";
    ctx.shadowBlur = cs * 0.04;
    ctx.shadowOffsetY = cs * 0.02;
    ctx.fillText(label, cx, cy + cs * 0.04);
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

// Apple body silhouette in unit coordinates (0..1). A side-profile apple:
// two rounded lobes with a dimple at the top centre and a softly tapered
// base. Built once and reused (scaled) for every cell.
function _buildAppleBodyPath() {
  const p = new Path2D();
  // Start at the top dimple.
  p.moveTo(0.5, 0.24);
  // Left shoulder
  p.bezierCurveTo(0.41, 0.17, 0.28, 0.16, 0.20, 0.26);
  // Left side down to the base
  p.bezierCurveTo(0.07, 0.41, 0.07, 0.66, 0.19, 0.83);
  // Bottom-left lobe meeting the centre dimple of the base
  p.bezierCurveTo(0.30, 0.96, 0.43, 0.95, 0.50, 0.88);
  // Bottom-right lobe
  p.bezierCurveTo(0.57, 0.95, 0.70, 0.96, 0.81, 0.83);
  // Right side up
  p.bezierCurveTo(0.93, 0.66, 0.93, 0.41, 0.80, 0.26);
  // Right shoulder back to the dimple
  p.bezierCurveTo(0.72, 0.16, 0.59, 0.17, 0.50, 0.24);
  p.closePath();
  return p;
}

// A small leaf angled up-right from the stem base.
function _buildLeafPath() {
  const p = new Path2D();
  p.moveTo(0.50, 0.17);
  p.quadraticCurveTo(0.66, 0.04, 0.80, 0.11);
  p.quadraticCurveTo(0.74, 0.24, 0.55, 0.22);
  p.quadraticCurveTo(0.50, 0.20, 0.50, 0.17);
  p.closePath();
  return p;
}
