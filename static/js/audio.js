// Procedural audio: synthesized in real time via Web Audio API, so there
// are zero copyright concerns — nothing is sampled or recorded. Includes a
// gentle looping BGM and short countdown blips.
//
// Browsers gate AudioContext behind a user gesture; call audio.unlock()
// from any click/keydown handler before playing anything.

const STORAGE_KEY = "audio_muted_v1";

class GameAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.bgmGain = null;
    this.muted = localStorage.getItem(STORAGE_KEY) === "1";
    this.bgmPlaying = false;
    this._bgmNextStart = 0;
    this._bgmTimer = null;
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  setMuted(m) {
    this.muted = !!m;
    localStorage.setItem(STORAGE_KEY, this.muted ? "1" : "0");
    if (this.masterGain && this.ctx) {
      const t = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this.masterGain.gain.linearRampToValueAtTime(
        this.muted ? 0 : 1, t + 0.05,
      );
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // Generic short tone with snappy ADSR.
  _blip(freq, when, dur, type = "triangle", peak = 0.35) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(env);
    env.connect(this.masterGain);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  // 3-2-1 ascending beeps; call countdownBeep(0) for the GO chord.
  countdownBeep(n) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (n === 3)      this._blip(523.25, t, 0.18, "triangle", 0.30); // C5
    else if (n === 2) this._blip(659.25, t, 0.18, "triangle", 0.32); // E5
    else if (n === 1) this._blip(783.99, t, 0.18, "triangle", 0.34); // G5
    else if (n === 0) {
      // GO! — bright major chord with a tiny stagger so it shimmers
      this._blip(1046.50, t,        0.45, "triangle", 0.32); // C6
      this._blip(1318.51, t + 0.02, 0.45, "triangle", 0.28); // E6
      this._blip(1567.98, t + 0.04, 0.45, "triangle", 0.24); // G6
    }
  }

  // -- BGM: gentle 4-chord loop (Am - F - C - G) -------------------------
  startBgm() {
    if (!this.ctx || this.bgmPlaying) return;
    this.bgmPlaying = true;
    if (!this.bgmGain) {
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.connect(this.masterGain);
    }
    const t = this.ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t);
    this.bgmGain.gain.setValueAtTime(0, t);
    this.bgmGain.gain.linearRampToValueAtTime(0.45, t + 0.6);
    this._bgmNextStart = t + 0.05;
    this._scheduleBgmBar();
  }

  stopBgm() {
    this.bgmPlaying = false;
    if (this._bgmTimer) {
      clearTimeout(this._bgmTimer);
      this._bgmTimer = null;
    }
    if (this.bgmGain && this.ctx) {
      const t = this.ctx.currentTime;
      this.bgmGain.gain.cancelScheduledValues(t);
      this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, t);
      this.bgmGain.gain.linearRampToValueAtTime(0.0001, t + 0.25);
    }
  }

  _scheduleBgmBar() {
    if (!this.bgmPlaying || !this.ctx) return;
    // 100 BPM → quarter = 0.6s. 8th notes for arpeggio.
    const beat = 0.6;
    const eighth = beat / 2;

    // Am, F, C, G — diatonic loop, two beats each = 4 bars total.
    const chords = [
      { bass: 110.00, arp: [220.00, 261.63, 329.63, 440.00, 329.63, 261.63, 329.63, 440.00] }, // Am
      { bass:  87.31, arp: [174.61, 220.00, 261.63, 349.23, 261.63, 220.00, 261.63, 349.23] }, // F
      { bass: 130.81, arp: [261.63, 329.63, 392.00, 523.25, 392.00, 329.63, 392.00, 523.25] }, // C
      { bass:  98.00, arp: [196.00, 246.94, 293.66, 392.00, 293.66, 246.94, 293.66, 392.00] }, // G
    ];

    let t = Math.max(this._bgmNextStart, this.ctx.currentTime + 0.02);
    for (const c of chords) {
      // Held bass note (one per bar).
      this._bgmBass(c.bass, t, 8 * eighth);
      // Arpeggio of 8 short triangle notes.
      let nt = t;
      for (const f of c.arp) {
        this._bgmNote(f, nt, eighth * 0.85);
        nt += eighth;
      }
      t += 8 * eighth;
    }
    this._bgmNextStart = t;

    // Re-schedule slightly before the next loop boundary.
    const aheadSec = chords.length * 8 * eighth;
    this._bgmTimer = setTimeout(
      () => this._scheduleBgmBar(),
      Math.max(50, (aheadSec - 0.3) * 1000),
    );
  }

  _bgmNote(freq, when, dur) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.18, when + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(env);
    env.connect(this.bgmGain);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  _bgmBass(freq, when, dur) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.25, when + 0.05);
    env.gain.setValueAtTime(0.25, when + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(env);
    env.connect(this.bgmGain);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }
}

export const audio = new GameAudio();
