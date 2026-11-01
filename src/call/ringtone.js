/**
 * Web Audio API based Incoming Call Ringtone generator for Windows Desktop.
 * Self-contained: requires zero external audio files, zero microphone/camera permissions,
 * and produces standard telephone / messaging dual-frequency ring cadence.
 */
export class IncomingCallRingtone {
  /**
   * @param {object} [options]
   * @param {Function} [options.AudioContextClass]
   */
  constructor({
    AudioContextClass = typeof globalThis.AudioContext !== 'undefined'
      ? globalThis.AudioContext
      : (typeof globalThis.webkitAudioContext !== 'undefined' ? globalThis.webkitAudioContext : null)
  } = {}) {
    this.AudioContextClass = AudioContextClass;
    this._ctx = null;
    this._isPlaying = false;
    this._intervalId = null;
    this._activeNodes = [];
  }

  get isPlaying() {
    return this._isPlaying;
  }

  /**
   * Starts playing the incoming call ringtone in a loop.
   * Safe to call multiple times (idempotent).
   */
  start() {
    if (this._isPlaying) return;
    this._isPlaying = true;

    if (!this.AudioContextClass) return;

    try {
      if (!this._ctx || this._ctx.state === 'closed') {
        this._ctx = new this.AudioContextClass();
      }
      if (this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }

      const playBurst = () => {
        if (!this._isPlaying || !this._ctx || this._ctx.state === 'closed') return;
        this._stopNodes();

        try {
          const now = this._ctx.currentTime;
          // Dual frequency phone ring tones: 440Hz + 480Hz with pleasant envelope
          const osc1 = this._ctx.createOscillator();
          const osc2 = this._ctx.createOscillator();
          const gain = this._ctx.createGain();

          osc1.type = 'sine';
          osc1.frequency.setValueAtTime(440, now);
          osc2.type = 'sine';
          osc2.frequency.setValueAtTime(480, now);

          // Smooth attack and release envelope over 1.5s
          gain.gain.setValueAtTime(0.001, now);
          gain.gain.exponentialRampToValueAtTime(0.18, now + 0.08);
          gain.gain.setValueAtTime(0.18, now + 1.4);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(this._ctx.destination);

          osc1.start(now);
          osc2.start(now);
          osc1.stop(now + 1.5);
          osc2.stop(now + 1.5);

          this._activeNodes = [osc1, osc2, gain];
        } catch {}
      };

      playBurst();
      this._intervalId = setInterval(playBurst, 2500); // 1.5s ring + 1.0s silence cadence
      if (this._intervalId && typeof this._intervalId.unref === 'function') {
        this._intervalId.unref();
      }
    } catch (err) {
      console.warn('[IncomingCallRingtone] Failed to start audio ringtone:', err?.message || err);
    }
  }

  /**
   * Stops the ringtone immediately and tears down audio context nodes.
   * Safe to call multiple times (idempotent).
   */
  stop() {
    this._isPlaying = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._stopNodes();
    if (this._ctx && this._ctx.state !== 'closed') {
      try {
        this._ctx.close().catch(() => {});
      } catch {}
      this._ctx = null;
    }
  }

  _stopNodes() {
    for (const node of this._activeNodes) {
      try {
        if (typeof node.stop === 'function') node.stop();
        if (typeof node.disconnect === 'function') node.disconnect();
      } catch {}
    }
    this._activeNodes = [];
  }
}
