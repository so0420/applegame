// Thin WebSocket wrapper with JSON messages and an event bus.

const HEARTBEAT_INTERVAL_MS = 25_000;

export class GameSocket extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this._heartbeat = null;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    this.ws = new WebSocket(url);
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
