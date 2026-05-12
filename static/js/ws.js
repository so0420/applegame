// Thin WebSocket wrapper with JSON messages and an event bus.

const HEARTBEAT_INTERVAL_MS = 25_000;

// Anti-macro: snapshot the critical native globals at module load (which
// is parser-blocking and runs before most extension content scripts get
// a chance to monkey-patch the page). Anything that looks tampered means
// a userscript / extension has hooked the pipeline; refuse to connect.
const NATIVE_REFS = {
  WebSocket: window.WebSocket,
  send: window.WebSocket && window.WebSocket.prototype && window.WebSocket.prototype.send,
  parse: JSON.parse,
  stringify: JSON.stringify,
  dateNow: Date.now,
  perfNow: performance && performance.now,
};

function isNative(fn) {
  if (typeof fn !== "function") return false;
  // Wrapping a function via bind / new Function would not produce the
  // characteristic "[native code]" body, so this catches the most common
  // monkey-patch patterns. Determined attackers can spoof toString, but
  // that itself is a non-trivial extra step.
  try {
    return /\[native code\]/.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

function tamperedGlobals() {
  // Re-resolve from current window to catch swaps that happened after the
  // initial snapshot (e.g. extensions injecting later).
  const live = {
    WebSocket: window.WebSocket,
    send: window.WebSocket && window.WebSocket.prototype && window.WebSocket.prototype.send,
    parse: JSON.parse,
    stringify: JSON.stringify,
    dateNow: Date.now,
    perfNow: performance && performance.now,
  };
  for (const k of Object.keys(NATIVE_REFS)) {
    if (!isNative(live[k])) return `${k} is not native`;
    if (live[k] !== NATIVE_REFS[k]) return `${k} was swapped`;
  }
  return null;
}

export class GameSocket extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this._heartbeat = null;
  }

  connect() {
    const tamper = tamperedGlobals();
    if (tamper) {
      console.error("Anti-cheat tripwire:", tamper);
      alert("브라우저 확장프로그램이나 스크립트가 네트워크 동작을 가로채고 있어 연결을 거부합니다. 확장프로그램을 비활성화한 뒤 다시 시도해 주세요.");
      return Promise.reject(new Error("tampered_environment"));
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    // Use the snapshotted constructor so a late swap doesn't take effect.
    this.ws = new NATIVE_REFS.WebSocket(url);
    this.ws.addEventListener("open", () => {
      this._startHeartbeat();
      this.dispatchEvent(new Event("open"));
    });
    this.ws.addEventListener("close", () => {
      this._stopHeartbeat();
      this.dispatchEvent(new Event("close"));
    });
    this.ws.addEventListener("error", (e) => this.dispatchEvent(new Event("error")));
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent("msg", { detail: msg }));
      this.dispatchEvent(new CustomEvent(`msg:${msg.type}`, { detail: msg }));
    });
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, ...payload }));
  }

  close() {
    this._stopHeartbeat();
    if (this.ws) this.ws.close();
  }

  // Application-level heartbeat — keeps idle proxies / NATs from
  // dropping the WebSocket. The server silently ignores unknown
  // message types so this is harmless beyond the bytes sent.
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }
}
