// Canvas-based board renderer.
//
// Coordinate system: board[row][col], row 0..9, col 0..16.
// Layout: cells are square; canvas size is computed from container width.

export const ROWS = 10;
export const COLS = 17;

const APPLE_RED = "#ff5252";
const APPLE_DARK = "#c62828";
const TEXT_COLOR = "#ffffff";
const EMPTY_COLOR = "#2f3540";
const ME_BOX = "rgba(79, 195, 247, 0.35)";
const ME_BOX_OK = "rgba(105, 240, 174, 0.55)";
const OPP_BOX = "rgba(255, 82, 82, 0.30)";

export class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.board = null;
    this.myDrag = null;     // {r1,c1,r2,c2,sumOk}
    this.peerDrag = null;   // {r1,c1,r2,c2}
    this.cellSize = 0;
    this.padding = 4;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this._fadingCells = []; // [{r,c,start,duration}]
    this._raf = null;
    window.addEventListener("resize", () => this.resize());
  }

  setBoard(board) {
    this.board = board.map((row) => row.slice());
    this.resize();
    this.render();
  }

  clearCells(cells) {
    if (!this.board) return;
    const now = performance.now();
    for (const [r, c] of cells) {
      this._fadingCells.push({ r, c, value: this.board[r][c], start: now, duration: 220 });
      this.board[r][c] = 0;
    }
    this._scheduleAnim();
  }

  setMyDrag(rect) { this.myDrag = rect; this.render(); }
  setPeerDrag(rect) { this.peerDrag = rect; this.render(); }

  resize() {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const w = Math.max(200, wrap.clientWidth - 16);
    const cell = Math.floor((w - this.padding * 2) / COLS);
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
    const x = clientX - rect.left - this.padding;
    const y = clientY - rect.top - this.padding;
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
    return { x: canvasRect.left + cx, y: canvasRect.top + cy };
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

    ctx.fillStyle = "#252a33";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.board) return;

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
          this._drawApple(x, y, cs, v, 1.0);
        }
      }
    }

    // Fading (recently cleared) apples
    const now = performance.now();
    this._fadingCells = this._fadingCells.filter((f) => {
      const t = (now - f.start) / f.duration;
      if (t >= 1) return false;
      const x = pad + f.c * cs;
      const y = pad + f.r * cs;
      this._drawApple(x, y, cs, f.value, 1 - t, 1 + t * 0.4);
      return true;
    });

    // Peer drag
    if (this.peerDrag) this._drawDragRect(this.peerDrag, OPP_BOX, "#ff5252");

    // My drag
    if (this.myDrag) {
      const sum = this.sumIn(this.myDrag);
      const color = sum === 10 ? ME_BOX_OK : ME_BOX;
      const stroke = sum === 10 ? "#69f0ae" : "#4fc3f7";
      this._drawDragRect(this.myDrag, color, stroke);
    }
  }

  _drawApple(x, y, cs, value, alpha = 1, scale = 1) {
    const ctx = this.ctx;
    const cx = x + cs / 2;
    const cy = y + cs / 2;
    const r = (cs / 2 - 2) * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
    grad.addColorStop(0, APPLE_RED);
    grad.addColorStop(1, APPLE_DARK);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // stem
    ctx.strokeStyle = "#5d4037";
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.15, cy - r - r * 0.18);
    ctx.stroke();
    // number
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = `bold ${Math.floor(cs * 0.5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy + 1);
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
