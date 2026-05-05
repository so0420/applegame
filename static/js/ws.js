// Thin WebSocket wrapper with JSON messages and an event bus.

export class GameSocket extends EventTarget {
  constructor() {
    super();
    this.ws = null;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.dispatchEvent(new Event("open")));
    this.ws.addEventListener("close", () => this.dispatchEvent(new Event("close")));
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
    if (this.ws) this.ws.close();
  }
}
