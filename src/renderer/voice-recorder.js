/**
 * VoiceRecorder Controller for OllaChat Windows.
 * Handles microphone capture, MediaRecorder lifecycle, audio waveform visualization,
 * duration constraints, and stream cleanup.
 */

export const RECORDING_STATE = Object.freeze({
  IDLE: 'idle',
  RECORDING: 'recording',
  CANCELLED: 'cancelled',
  SENDING: 'sending',
  ERROR: 'error'
});

export const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes maximum
export const DEFAULT_MIN_DURATION_MS = 500; // 0.5s minimum

/**
 * Returns preferred and supported audio MIME type for voice recording.
 * Standard format: audio/webm;codecs=opus.
 */
export function getSupportedAudioMimeType(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass || typeof MediaRecorderClass.isTypeSupported !== 'function') {
    return 'audio/webm;codecs=opus';
  }
  const preferred = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const mime of preferred) {
    if (MediaRecorderClass.isTypeSupported(mime)) {
      return mime;
    }
  }
  return 'audio/webm';
}

/**
 * Standalone event emitter for voice recording events.
 */
class RecorderEventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[RecorderEventEmitter] Error in listener for "${event}":`, err?.message || err);
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

/**
 * VoiceRecorder manages recording audio voice notes using HTML5 MediaRecorder.
 */
export class VoiceRecorder extends RecorderEventEmitter {
  /**
   * @param {object} [options]
   * @param {MediaDevices} [options.mediaDevices] - navigator.mediaDevices or mock
   * @param {Function} [options.MediaRecorderClass] - MediaRecorder constructor or mock
   * @param {Function} [options.AudioContextClass] - AudioContext or webkitAudioContext constructor or mock
   * @param {number} [options.maxDurationMs] - maximum duration before auto-stop
   * @param {number} [options.minDurationMs] - minimum duration required to produce a valid recording
   */
  constructor({
    mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
    MediaRecorderClass = typeof globalThis.MediaRecorder !== 'undefined' ? globalThis.MediaRecorder : null,
    AudioContextClass = typeof globalThis.AudioContext !== 'undefined'
      ? globalThis.AudioContext
      : (typeof globalThis.webkitAudioContext !== 'undefined' ? globalThis.webkitAudioContext : null),
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    minDurationMs = DEFAULT_MIN_DURATION_MS
  } = {}) {
    super();

    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.AudioContextClass = AudioContextClass;
    this.maxDurationMs = maxDurationMs;
    this.minDurationMs = minDurationMs;

    this.state = RECORDING_STATE.IDLE;
    this.error = null;

    this._mediaStream = null;
    this._mediaRecorder = null;
    this._chunks = [];
    this._startTime = 0;
    this._timerId = null;
    this._audioContext = null;
    this._analyser = null;
    this._levelCheckId = null;
    this._mimeType = '';
  }

  /**
   * Returns current recording state.
   */
  getState() {
    return this.state;
  }

  /**
   * Returns whether recording is currently active.
   */
  isRecording() {
    return this.state === RECORDING_STATE.RECORDING;
  }

  /**
   * Returns current recording duration in seconds.
   */
  getDuration() {
    if (this._startTime <= 0) return 0;
    return Math.max(0, (Date.now() - this._startTime) / 1000);
  }

  /**
   * Formats seconds into MM:SS display.
   */
  static formatDuration(seconds) {
    const totalSec = Math.floor(Math.max(0, seconds || 0));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Transitions state and emits stateChange event.
   * @private
   */
  _setState(newState, error = null) {
    if (this.state === newState && this.error === error) return;
    this.state = newState;
    this.error = error;
    this.emit('stateChange', {
      state: newState,
      duration: this.getDuration(),
      error
    });
  }

  /**
   * Starts microphone recording.
   * Strictly requests audio: true, video: false.
   */
  async start() {
    if (this.state === RECORDING_STATE.RECORDING) {
      throw new Error('Already recording');
    }

    if (!this.mediaDevices?.getUserMedia) {
      const msg = 'Microphone access is not supported on this platform';
      this._setState(RECORDING_STATE.ERROR, msg);
      throw new Error(msg);
    }

    this._cleanup();
    this.error = null;
    this._chunks = [];

    let stream;
    try {
      // Voice only: strictly audio true, video false. No camera permission requested!
      stream = await this.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
    } catch (err) {
      let msg;
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        msg = 'Microphone permission denied. Please allow microphone access in Windows / Electron settings to record voice messages.';
      } else if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
        msg = 'No microphone device found. Please connect a microphone to record voice messages.';
      } else if (err?.name === 'NotReadableError' || err?.name === 'TrackStartError') {
        msg = 'Microphone is already in use by another application or cannot be opened.';
      } else if (err?.name === 'OverconstrainedError') {
        msg = 'Requested microphone audio constraints could not be satisfied.';
      } else if (err?.name === 'SecurityError') {
        msg = 'Microphone access is restricted by system security policy.';
      } else {
        msg = `Unable to access microphone: ${err?.message || 'Device unavailable'}`;
      }
      this._setState(RECORDING_STATE.ERROR, msg);
      throw new Error(msg);
    }

    this._mediaStream = stream;
    this._mimeType = getSupportedAudioMimeType(this.MediaRecorderClass);

    try {
      const options = this._mimeType ? { mimeType: this._mimeType } : {};
      this._mediaRecorder = new this.MediaRecorderClass(stream, options);
    } catch (recorderErr) {
      // Fallback if specific codec is rejected by platform constructor
      try {
        this._mediaRecorder = new this.MediaRecorderClass(stream);
        this._mimeType = this._mediaRecorder.mimeType || 'audio/webm';
      } catch (fallbackErr) {
        this._cleanupTracks();
        const msg = `MediaRecorder initialization failed: ${fallbackErr.message || recorderErr.message}`;
        this._setState(RECORDING_STATE.ERROR, msg);
        throw new Error(msg);
      }
    }

    this._mediaRecorder.ondataavailable = (event) => {
      if (event && event.data && event.data.size > 0) {
        this._chunks.push(event.data);
      }
    };

    this._mediaRecorder.onerror = (event) => {
      const err = event?.error || new Error('MediaRecorder recording error');
      this._cleanupTracks();
      this._setState(RECORDING_STATE.ERROR, err.message || 'Recording error');
      this.emit('error', err);
    };

    this._startTime = Date.now();
    try {
      // Start recording with timeslice (e.g. 100ms) for steady data delivery
      this._mediaRecorder.start(100);
    } catch (err) {
      this._cleanupTracks();
      this._setState(RECORDING_STATE.ERROR, err.message || 'Failed to start recorder');
      throw err;
    }

    this._setState(RECORDING_STATE.RECORDING);

    // Setup periodic duration timer
    this._timerId = setInterval(() => {
      if (this.state !== RECORDING_STATE.RECORDING) return;
      const elapsedMs = Date.now() - this._startTime;
      const durationSec = elapsedMs / 1000;
      this.emit('timeUpdate', {
        duration: durationSec,
        elapsedMs,
        formatted: VoiceRecorder.formatDuration(durationSec)
      });

      // Auto-stop if max duration reached (10 minutes)
      if (elapsedMs >= this.maxDurationMs) {
        this.emit('maxDurationReached');
        this.stop().catch((e) => console.error('[VoiceRecorder] Auto-stop failed:', e));
      }
    }, 100);
    if (this._timerId && typeof this._timerId.unref === 'function') {
      this._timerId.unref();
    }

    // Setup real-time audio volume visualizer if AudioContext is available
    this._setupAudioAnalyser(stream);

    return true;
  }

  /**
   * Sets up AudioContext AnalyserNode to emit normalized sound levels [0.0 - 1.0].
   * @private
   */
  _setupAudioAnalyser(stream) {
    if (!this.AudioContextClass) return;
    try {
      const ctx = new this.AudioContextClass();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      this._audioContext = ctx;
      this._analyser = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const checkLevel = () => {
        if (this.state !== RECORDING_STATE.RECORDING || !this._analyser) return;
        this._analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / (dataArray.length || 1);
        const normalized = Math.min(1.0, avg / 128); // 0.0 - 1.0
        this.emit('level', normalized);
        this._levelCheckId = setTimeout(checkLevel, 80);
        if (this._levelCheckId && typeof this._levelCheckId.unref === 'function') {
          this._levelCheckId.unref();
        }
      };
      checkLevel();
    } catch {
      // AudioContext failure is non-fatal for recording
    }
  }

  /**
   * Stops recording and returns the recorded audio Blob and duration.
   * If duration < 0.5s, recording is discarded and returns null.
   *
   * @returns {Promise<{ blob: Blob, duration: number, mimeType: string } | null>}
   */
  async stop() {
    if (this.state !== RECORDING_STATE.RECORDING) {
      return null;
    }

    const elapsedMs = Date.now() - this._startTime;
    const duration = elapsedMs / 1000;

    this._stopTimer();
    this._stopAudioAnalyser();

    const recorder = this._mediaRecorder;
    const stream = this._mediaStream;

    return new Promise((resolve, reject) => {
      if (!recorder || recorder.state === 'inactive') {
        this._cleanupTracks();
        this._setState(RECORDING_STATE.IDLE);
        resolve(null);
        return;
      }

      recorder.onstop = () => {
        this._cleanupTracks(stream);

        // Discard recordings shorter than minimum duration (0.5s)
        if (elapsedMs < this.minDurationMs) {
          this._chunks = [];
          this._setState(RECORDING_STATE.IDLE);
          this.emit('tooShort', { elapsedMs, duration });
          resolve(null);
          return;
        }

        const mime = this._mimeType || recorder.mimeType || 'audio/webm;codecs=opus';
        let blob;
        try {
          blob = new Blob(this._chunks, { type: mime });
        } catch (e) {
          this._setState(RECORDING_STATE.ERROR, e.message);
          reject(e);
          return;
        }

        this._chunks = [];
        this._setState(RECORDING_STATE.IDLE);

        resolve({
          blob,
          duration,
          mimeType: mime,
          byteSize: blob.size
        });
      };

      try {
        recorder.stop();
      } catch (err) {
        this._cleanupTracks(stream);
        this._setState(RECORDING_STATE.ERROR, err.message);
        reject(err);
      }
    });
  }

  /**
   * Cancels and discards the current recording.
   * Releasing microphone tracks immediately.
   */
  cancel() {
    if (this.state !== RECORDING_STATE.RECORDING) {
      return;
    }

    this._stopTimer();
    this._stopAudioAnalyser();

    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      try {
        this._mediaRecorder.onstop = null;
        this._mediaRecorder.stop();
      } catch {}
    }

    this._cleanupTracks();
    this._chunks = [];
    this._setState(RECORDING_STATE.CANCELLED);
    this._setState(RECORDING_STATE.IDLE);
    this.emit('cancelled');
  }

  /**
   * Stops all active tracks on the microphone MediaStream.
   * @private
   */
  _cleanupTracks(stream = this._mediaStream) {
    if (stream) {
      try {
        const tracks = stream.getTracks ? stream.getTracks() : [];
        for (const track of tracks) {
          try {
            track.stop();
          } catch {}
        }
      } catch {}
    }
    if (this._mediaStream === stream) {
      this._mediaStream = null;
    }
  }

  /**
   * Stops duration timer.
   * @private
   */
  _stopTimer() {
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Stops audio analyser.
   * @private
   */
  _stopAudioAnalyser() {
    if (this._levelCheckId) {
      clearTimeout(this._levelCheckId);
      this._levelCheckId = null;
    }
    if (this._audioContext) {
      try {
        this._audioContext.close();
      } catch {}
      this._audioContext = null;
    }
    this._analyser = null;
  }

  /**
   * Full internal cleanup.
   * @private
   */
  _cleanup() {
    this._stopTimer();
    this._stopAudioAnalyser();
    this._cleanupTracks();
    this._mediaRecorder = null;
    this._chunks = [];
    this._startTime = 0;
  }
}
