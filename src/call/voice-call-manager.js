import { IncomingCallRingtone } from './ringtone.js';

export const CALL_STATE = Object.freeze({
  IDLE: 'idle',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ENDING: 'ending',
  ENDED: 'ended',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  REMOTE_DECLINED: 'remote_declined',
  REMOTE_CANCELLED: 'remote_cancelled',
  REMOTE_ENDED: 'remote_ended',
  NO_ANSWER: 'no_answer',
  FAILED: 'failed',
  // Backwards-compatible aliases:
  CALLING: 'outgoing_ringing',
  RINGING: 'incoming_ringing'
});

export function isInternalIdOrUuid(str) {
  if (!str || typeof str !== 'string') return true;
  const trimmed = str.trim();
  if (!trimmed) return true;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hexIdRegex = /^[0-9a-f]{24,64}$/i;
  return uuidRegex.test(trimmed) || hexIdRegex.test(trimmed);
}

const VALID_TRANSITIONS = {
  [CALL_STATE.IDLE]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.FAILED
  ],
  [CALL_STATE.OUTGOING_RINGING]: [
    CALL_STATE.CONNECTING,
    CALL_STATE.CANCELLED,
    CALL_STATE.REMOTE_DECLINED,
    CALL_STATE.NO_ANSWER,
    CALL_STATE.FAILED,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED
  ],
  [CALL_STATE.INCOMING_RINGING]: [
    CALL_STATE.CONNECTING,
    CALL_STATE.DECLINED,
    CALL_STATE.REMOTE_CANCELLED,
    CALL_STATE.NO_ANSWER,
    CALL_STATE.FAILED,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED
  ],
  [CALL_STATE.CONNECTING]: [
    CALL_STATE.CONNECTED,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.REMOTE_ENDED,
    CALL_STATE.FAILED
  ],
  [CALL_STATE.CONNECTED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.REMOTE_ENDED,
    CALL_STATE.FAILED
  ],
  [CALL_STATE.ENDING]: [
    CALL_STATE.ENDED,
    CALL_STATE.IDLE,
    CALL_STATE.FAILED
  ],
  [CALL_STATE.ENDED]: [
    CALL_STATE.ENDING,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.DECLINED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.CANCELLED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_DECLINED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_CANCELLED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_ENDED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.NO_ANSWER]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.FAILED]: [
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ]
};

/**
 * Lightweight standalone event emitter for VoiceCallManager.
 */
class CallEventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (typeof listener !== 'function') return () => { };
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
        console.error(`[CallEventEmitter] Error in listener for "${event}":`, err?.message || err);
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

class FallbackSessionDescription {
  constructor(init = {}) {
    this.type = init.type || '';
    this.sdp = init.sdp || '';
  }
}

class FallbackIceCandidate {
  constructor(init = {}) {
    this.candidate = init.candidate || '';
    this.sdpMid = init.sdpMid || '';
    this.sdpMLineIndex = init.sdpMLineIndex ?? 0;
  }
}

/**
 * VoiceCallManager orchestrates 1-to-1 WebRTC voice and video calling on Windows desktop.
 * Faithfully mirrors Android CallViewModel.kt calling lifecycle with verified OllaCore SFU signaling.
 *
 * Enforces:
 * - Strict explicit call modality: 'voice' | 'video'.
 * - Room-scoped RTC WebSocket signaling with ice_servers from room token response.
 * - Safe candidate queuing until remote description is established.
 * - Complete teardown of microphone/camera media tracks, PeerConnection, and sockets on hangup.
 * - Call duration timer running strictly during CONNECTED state from 00:00.
 * - Audio ringtone active only during INCOMING_RINGING state.
 * - 30-second ringing timeout for both caller and callee (NO_ANSWER).
 * - Symmetrical call termination: Caller cancellation, Callee decline, and Remote hangup.
 */
export class VoiceCallManager extends CallEventEmitter {
  /**
   * @param {object} [options]
   * @param {object} [options.rtcBridge] - window.ollacoreDesktop.rtc bridge or mock
   * @param {MediaDevices} [options.mediaDevices] - navigator.mediaDevices or mock
   * @param {Function} [options.PeerConnectionClass] - RTCPeerConnection or mock
   * @param {Function} [options.SessionDescriptionClass] - RTCSessionDescription or mock
   * @param {Function} [options.IceCandidateClass] - RTCIceCandidate or mock
   * @param {HTMLAudioElement} [options.remoteAudioElement] - <audio> element for remote playback
   * @param {HTMLVideoElement} [options.localVideoElement] - <video> element for local preview
   * @param {HTMLVideoElement} [options.remoteVideoElement] - <video> element for remote video
   * @param {IncomingCallRingtone} [options.ringtone] - Ringtone generator instance or mock
   * @param {Function} [options.AudioContextClass] - AudioContext class for ringtone
   */
  constructor({
    rtcBridge = typeof window !== 'undefined' ? window.ollacoreDesktop?.rtc : null,
    mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
    PeerConnectionClass = typeof globalThis.RTCPeerConnection !== 'undefined' ? globalThis.RTCPeerConnection : null,
    SessionDescriptionClass = typeof globalThis.RTCSessionDescription !== 'undefined' ? globalThis.RTCSessionDescription : null,
    IceCandidateClass = typeof globalThis.RTCIceCandidate !== 'undefined' ? globalThis.RTCIceCandidate : null,
    remoteAudioElement = null,
    localVideoElement = null,
    remoteVideoElement = null,
    ringtone = null,
    AudioContextClass = typeof globalThis.AudioContext !== 'undefined'
      ? globalThis.AudioContext
      : (typeof globalThis.webkitAudioContext !== 'undefined' ? globalThis.webkitAudioContext : null),
    sendSignal = null
  } = {}) {
    super();

    this.rtcBridge = rtcBridge;
    this.mediaDevices = mediaDevices;
    this.PeerConnectionClass = PeerConnectionClass;
    this.SessionDescriptionClass = SessionDescriptionClass || FallbackSessionDescription;
    this.IceCandidateClass = IceCandidateClass || FallbackIceCandidate;
    this.remoteAudioElement = remoteAudioElement;
    this.localVideoElement = localVideoElement;
    this.remoteVideoElement = remoteVideoElement;
    this.ringtone = ringtone || new IncomingCallRingtone({ AudioContextClass });

    this.state = CALL_STATE.IDLE;
    this.roomId = null;
    this.callId = null;
    this.peerName = '';
    this.peerPhone = '';
    this.error = null;

    this.mode = 'voice'; // 'voice' | 'video'
    this.isVideo = false;
    this.isMuted = false;
    this.isCameraOff = false;
    this.isScreenSharing = false;
    this.remoteScreenSharing = false;
    this.activeScreenSharerId = null;
    this._isOriginalVideoCall = false;
    this._screenVideoSender = null;
    this._savedCameraTrack = null;
    this._savedCameraOff = false;
    this._screenStream = null;
    this._screenTrack = null;
    this._isStoppingScreenShare = false;

    this.peerConnection = null;
    this._localStream = null;
    this._localAudioTrack = null;
    this._localVideoTrack = null;
    this._remoteStream = null;
    this._pendingIceCandidates = [];
    this._isIncoming = false;
    this._unsubscribeRtcEvents = null;
    this._callStartEpoch = 0;
    this._connectedEpoch = 0;

    // Call Duration Timer
    this.callConnectedAt = null;
    this.durationSec = 0;
    this._timerInterval = null;
    this._iceDisconnectTimer = null;
    this._ringingTimer = null;
    this._cleanupTimer = null;
    this._pendingOffer = null;
    this.sendSignal = typeof sendSignal === 'function' ? sendSignal : null;
    this.participants = new Set();
  }

  /**
   * Tracks an active participant in the ongoing call session.
   * @param {string} userId
   */
  addParticipant(userId) {
    if (!userId) return;
    this.participants.add(String(userId));
    this.emit('participantsChange', { participants: Array.from(this.participants) });
  }

  /**
   * Removes a departed participant from the ongoing call session.
   * @param {string} userId
   */
  removeParticipant(userId) {
    if (!userId) return;
    this.participants.delete(String(userId));
    this.emit('participantsChange', { participants: Array.from(this.participants) });
  }

  /**
   * Checks if a participant is currently registered as active in the call.
   * @param {string} userId
   * @returns {boolean}
   */
  hasParticipant(userId) {
    if (!userId) return false;
    return this.participants.has(String(userId));
  }

  /**
   * Updates call modality (e.g. when video invite signal is received) and notifies UI.
   * @param {'voice'|'video'} mode
   */
  setModality(mode) {
    const isVideo = mode === 'video';
    this.isVideo = isVideo;
    this.mode = isVideo ? 'video' : 'voice';
    if (this.peerName === 'Incoming Voice Call' || this.peerName === 'Voice Call') {
      this.peerName = isVideo ? 'Incoming Video Call' : 'Incoming Voice Call';
    }
    this.emit('modeChange', { isVideo: this.isVideo, mode: this.mode });
  }

  get isCalling() {
    return this.state === CALL_STATE.OUTGOING_RINGING;
  }

  get isRinging() {
    return this.state === CALL_STATE.INCOMING_RINGING;
  }

  get isConnected() {
    return this.state === CALL_STATE.CONNECTED;
  }

  get isOutgoing() {
    return !this._isIncoming && (
      this.state === CALL_STATE.OUTGOING_RINGING ||
      this.state === CALL_STATE.CONNECTING ||
      this.state === CALL_STATE.CONNECTED
    );
  }

  get isIncoming() {
    return Boolean(this._isIncoming);
  }

  get isEnded() {
    return this.state === CALL_STATE.ENDED ||
      this.state === CALL_STATE.DECLINED ||
      this.state === CALL_STATE.CANCELLED ||
      this.state === CALL_STATE.REMOTE_DECLINED ||
      this.state === CALL_STATE.REMOTE_CANCELLED ||
      this.state === CALL_STATE.REMOTE_ENDED ||
      this.state === CALL_STATE.NO_ANSWER ||
      this.state === CALL_STATE.FAILED;
  }

  /**
   * Evaluates if local user is permitted to start screen sharing.
   * Disallowed if another participant is already actively sharing or if not in connected call.
   * @returns {boolean}
   */
  canStartScreenShare() {
    if (this.state !== CALL_STATE.CONNECTED && this.state !== CALL_STATE.CONNECTING) return false;
    if (this.isScreenSharing) return true; // Already sharing: can toggle/stop
    if (this.remoteScreenSharing) return false; // Another participant is sharing
    return true;
  }

  /**
   * Updates remote screen sharing room state and notifies listeners.
   * @param {boolean} isSharing
   * @param {string|null} [sharerId=null]
   */
  setRemoteScreenShareState(isSharing, sharerId = null) {
    const nextSharing = Boolean(isSharing);
    const nextSharerId = nextSharing ? (sharerId || null) : null;
    const changed = this.remoteScreenSharing !== nextSharing || this.activeScreenSharerId !== nextSharerId;
    this.remoteScreenSharing = nextSharing;
    this.activeScreenSharerId = nextSharerId;

    if (this.remoteVideoElement) {
      if (nextSharing) {
        if (this._remoteStream) {
          this.remoteVideoElement.srcObject = this._remoteStream;
          this.remoteVideoElement.play?.().catch(() => { });
        }
      } else if (this.isVideo) {
        const remoteVideoTracks = this._remoteStream?.getVideoTracks ? this._remoteStream.getVideoTracks() : [];
        const hasLiveTrack = remoteVideoTracks.some(t => t.readyState === 'live');
        if (hasLiveTrack && this._remoteStream) {
          this.remoteVideoElement.srcObject = this._remoteStream;
          this.remoteVideoElement.play?.().catch(() => { });
        } else {
          this.remoteVideoElement.srcObject = null;
          try { this.remoteVideoElement.load?.(); } catch (_) { }
        }
      } else {
        this.remoteVideoElement.srcObject = null;
        try { this.remoteVideoElement.load?.(); } catch (_) { }
      }
    }

    if (changed) {
      this.emit('remoteScreenShareChange', {
        remoteScreenSharing: this.remoteScreenSharing,
        activeScreenSharerId: this.activeScreenSharerId
      });
    }
  }

  toJSON() {
    return {
      state: this.state,
      roomId: this.roomId,
      callId: this.callId,
      peerName: this.peerName,
      peerPhone: this.peerPhone,
      isVideo: this.isVideo,
      mode: this.mode,
      isMuted: this.isMuted,
      isCameraOff: this.isCameraOff,
      isScreenSharing: this.isScreenSharing,
      remoteScreenSharing: Boolean(this.remoteScreenSharing),
      activeScreenSharerId: this.activeScreenSharerId || null,
      isCalling: this.isCalling,
      isRinging: this.isRinging,
      isConnected: this.isConnected,
      isEnded: this.isEnded
    };
  }

  setRemoteAudioElement(el) {
    this.remoteAudioElement = el;
    if (this._remoteStream && this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = this._remoteStream;
      this.remoteAudioElement.play?.().catch(() => { });
    }
  }

  setLocalVideoElement(el) {
    this.localVideoElement = el;
    if (this._localStream && this.localVideoElement && this.isVideo) {
      this.localVideoElement.srcObject = this._localStream;
      this.localVideoElement.play?.().catch(() => { });
    }
  }

  setRemoteVideoElement(el) {
    this.remoteVideoElement = el;
    if (this._remoteStream && this.remoteVideoElement && this.isVideo) {
      this.remoteVideoElement.srcObject = this._remoteStream;
      this.remoteVideoElement.play?.().catch(() => { });
    }
  }

  /**
   * Transitions internal call state and emits stateChange event.
   * Validates state transitions to reject impossible state changes.
   * @private
   */
  _setState(newState, error = null) {
    if (this.state === newState && this.error === error) return;

    const allowed = VALID_TRANSITIONS[this.state];
    if (allowed && !allowed.includes(newState)) {
      console.warn(`[VoiceCallManager] Blocked invalid state transition: "${this.state}" -> "${newState}"`);
      return;
    }

    this.state = newState;
    this.error = error;
    this.emit('stateChange', {
      state: newState,
      roomId: this.roomId,
      peerName: this.peerName,
      peerPhone: this.peerPhone,
      error
    });
  }

  /**
   * Starts 30-second ringing timeout.
   * @private
   */
  _startRingingTimer(durationMs = 30000) {
    this._clearRingingTimer();
    this._ringingTimer = setTimeout(async () => {
      this._ringingTimer = null;
      if (this.state === CALL_STATE.OUTGOING_RINGING) {
        console.log('[VoiceCallManager] Outgoing ringing timeout (no answer, 30s)');
        this._setState(CALL_STATE.NO_ANSWER);
        if (this.rtcBridge?.leave) {
          try { await this.rtcBridge.leave(); } catch { }
        }
        this._cleanupResources();
        this._scheduleIdleTransition(CALL_STATE.NO_ANSWER);
      } else if (this.state === CALL_STATE.INCOMING_RINGING) {
        console.log('[VoiceCallManager] Incoming ringing timeout (no answer, 30s)');
        this._setState(CALL_STATE.NO_ANSWER);
        if (this.ringtone) this.ringtone.stop();
        this._cleanupResources();
        this._scheduleIdleTransition(CALL_STATE.NO_ANSWER);
      }
    }, durationMs);
    if (this._ringingTimer && typeof this._ringingTimer.unref === 'function') {
      this._ringingTimer.unref();
    }
  }

  /**
   * Clears ringing timeout.
   * @private
   */
  _clearRingingTimer() {
    if (this._ringingTimer) {
      clearTimeout(this._ringingTimer);
      this._ringingTimer = null;
    }
  }

  /**
   * Schedules delayed return to IDLE after a terminal state so user sees final state in UI.
   * @private
   */
  _scheduleIdleTransition(fromState, delayMs = 800) {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._cleanupTimer = setTimeout(() => {
      this._cleanupTimer = null;
      if (this.state === fromState) {
        this.roomId = null;
        this.callId = null;
        this.peerName = '';
        this.peerPhone = '';
        this.error = null;
        this.isMuted = false;
        this.isCameraOff = false;
        this.isScreenSharing = false;
        this.isVideo = false;
        this.mode = 'voice';
        this._setState(CALL_STATE.IDLE);
      }
    }, delayMs);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  /**
   * Starts the call duration timer.
   * Starts at 00:00 strictly upon CONNECTED state.
   */
  startCallDurationTimer() {
    if (this._timerInterval) {
      return; // Prevent duplicate timers
    }
    this.callConnectedAt = this._connectedEpoch || Date.now();
    this.durationSec = 0;
    this.emit('timerTick', {
      durationSec: 0,
      formatted: '00:00'
    });

    this._timerInterval = setInterval(() => {
      if (!this.callConnectedAt) return;
      this.durationSec = Math.max(0, Math.floor((Date.now() - this.callConnectedAt) / 1000));
      this.emit('timerTick', {
        durationSec: this.durationSec,
        formatted: this.getFormattedDuration()
      });
    }, 1000);
    if (this._timerInterval && typeof this._timerInterval.unref === 'function') {
      this._timerInterval.unref();
    }
  }

  /**
   * Authoritative elapsed seconds.
   * @returns {number}
   */
  get duration() {
    return this.durationSec || 0;
  }

  /**
   * Stops and resets the call duration timer.
   */
  stopCallDurationTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
    this.callConnectedAt = null;
    this.durationSec = 0;
    this.emit('timerTick', {
      durationSec: 0,
      formatted: '00:00'
    });
  }

  /**
   * Formats current elapsed duration as MM:SS (or HH:MM:SS if >= 1hr).
   * @returns {string}
   */
  getFormattedDuration() {
    const totalSec = this.durationSec || 0;
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');

    if (hours > 0) {
      const hh = String(hours).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
  }

  /**
   * Starts a 5-second grace period timer when ICE / RTC connectivity drops.
   * If connectivity is not restored within 5 seconds, tears down the call cleanly.
   * @private
   */
  _startIceDisconnectTimer() {
    if (this._iceDisconnectTimer) return;
    this._iceDisconnectTimer = setTimeout(async () => {
      this._iceDisconnectTimer = null;
      if (this.state === CALL_STATE.CONNECTED) {
        console.log('[VoiceCallManager] ICE disconnected timeout reached. Terminating call.');
        this._setState(CALL_STATE.ENDED);
        await this.endCall(false);
      }
    }, 15000);
    if (this._iceDisconnectTimer && typeof this._iceDisconnectTimer.unref === 'function') {
      this._iceDisconnectTimer.unref();
    }
  }

  /**
   * Clears the ICE disconnect grace timer if connectivity is restored.
   * @private
   */
  _clearIceDisconnectTimer() {
    if (this._iceDisconnectTimer) {
      clearTimeout(this._iceDisconnectTimer);
      this._iceDisconnectTimer = null;
    }
  }

  /**
   * Wires signaling event listeners from the RTC bridge.
   * @private
   */
  _setupRtcListener() {
    if (this._unsubscribeRtcEvents) {
      this._unsubscribeRtcEvents();
      this._unsubscribeRtcEvents = null;
    }
    const subscribe = this.rtcBridge?.onEvent || this.rtcBridge?.onEvents;
    if (!subscribe) return;

    this._unsubscribeRtcEvents = subscribe.call(this.rtcBridge, (eventData) => {
      return this._handleRtcEvent(eventData);
    });
  }

  /**
   * Dispatches incoming RTC events.
   * @private
   */
  async _handleRtcEvent(event) {
    if (!event || typeof event !== 'object') return;
    const targetRoomId = event.roomId || this.roomId;

    // Reject stale room RTC events
    if (this.roomId && targetRoomId !== this.roomId) {
      return;
    }

    switch (event.type) {
      case 'offer':
        await this._handleIncomingOffer(event.sdp, event.requestId, {
          isVideo: event.isVideo,
          callType: event.callType
        });
        break;

      case 'answer':
        await this._handleIncomingAnswer(event.sdp);
        break;

      case 'candidate':
        await this._handleIncomingCandidate(event.candidate);
        break;

      case 'call_ended':
      case 'ended':
      case 'leave':
      case 'peer_left':
      case 'participant_left':
      case 'call.ended':
      case 'hangup':
        if (this.ringtone) this.ringtone.stop();
        this.stopCallDurationTimer();
        this._clearIceDisconnectTimer();
        this._clearRingingTimer();
        await this.handleRemoteCallEnded({ roomId: targetRoomId });
        break;

      case 'disconnected':
        if (event.code === 1000 || event.reason === 'Client disconnect' || event.reason === 'Normal closure') {
          console.log('[VoiceCallManager] Ignoring normal/client RTC signaling disconnect');
          break;
        }
        if (this.state === CALL_STATE.CONNECTED) {
          if (this.ringtone) this.ringtone.stop();
          this.stopCallDurationTimer();
          this._clearIceDisconnectTimer();
          this._clearRingingTimer();
          console.log('[VoiceCallManager] RTC signaling disconnected unexpectedly, ending local call');
          await this.endCall(false);
        }
        break;

      case 'error':
        if (this.ringtone) this.ringtone.stop();
        this.stopCallDurationTimer();
        this._clearIceDisconnectTimer();
        this._clearRingingTimer();
        if (this.state !== CALL_STATE.IDLE && this.state !== CALL_STATE.ENDED) {
          this._setState(CALL_STATE.FAILED, event.error || 'Signaling error');
          await this.endCall(false);
        }
        break;
    }
  }

  /**
   * Acquire user microphone (and camera for video calls).
   * Voice call: audio: true, video: false (Zero camera request).
   * Video call: audio: true, video: true.
   * @param {boolean} [isVideo=false]
   * @private
   */
  async _acquireMedia(isVideo = false) {
    if (!this.mediaDevices?.getUserMedia) {
      throw new Error('Media access is not supported on this platform');
    }
    try {
      const stream = await this.mediaDevices.getUserMedia({
        audio: true,
        video: Boolean(isVideo)
      });
      this._localStream = stream;
      const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
      this._localAudioTrack = audioTracks[0] || null;
      this._localVideoTrack = videoTracks[0] || null;

      if (this._localAudioTrack) {
        this._localAudioTrack.enabled = !this.isMuted;
        if (typeof this._localAudioTrack.applyConstraints === 'function') {
          try {
            await this._localAudioTrack.applyConstraints({
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              googEchoCancellation: true,
              googAutoGainControl: true,
              googNoiseSuppression: true,
              googHighpassFilter: true
            });
          } catch (_) {}
        }
      }
      if (this._localVideoTrack) {
        this._localVideoTrack.enabled = !this.isCameraOff;
      }

      if (isVideo && this._localVideoTrack && typeof this._localVideoTrack.applyConstraints === 'function') {
        try {
          // 4K Ultra HD video (3840x2160) @ up to 60fps
          await this._localVideoTrack.applyConstraints({
            width: { ideal: 3840, max: 3840 },
            height: { ideal: 2160, max: 2160 },
            frameRate: { ideal: 30, max: 60 }
          });
        } catch (_) {
          try {
            await this._localVideoTrack.applyConstraints({
              width: { ideal: 1920, max: 1920 },
              height: { ideal: 1080, max: 1080 },
              frameRate: { ideal: 30, max: 30 }
            });
          } catch (_) {}
        }
      }

      if (isVideo && this.localVideoElement) {
        this.localVideoElement.srcObject = this._localStream;
        this.localVideoElement.play?.().catch(() => { });
      }

      return stream;
    } catch (err) {
      const isDenied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      let msg;
      if (isVideo) {
        msg = isDenied
          ? 'Camera / microphone permission denied. Please allow camera and microphone permissions to make video calls.'
          : `Unable to access camera / microphone: ${err?.message || 'Device unavailable'}`;
      } else {
        msg = isDenied
          ? 'Microphone permission denied. Please allow microphone access to make voice calls.'
          : `Unable to access microphone: ${err?.message || 'Device unavailable'}`;
      }
      this._setState(CALL_STATE.FAILED, msg);
      throw new Error(msg);
    }
  }

  /**
   * Initializes RTCPeerConnection with ice_servers from OllaCore room-token response.
   * @private
   */
  _createPeerConnection(iceServers = []) {
    if (!this.PeerConnectionClass) {
      throw new Error('RTCPeerConnection is not supported');
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.oniceconnectionstatechange = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.close();
      } catch { }
      this.peerConnection = null;
    }

    const configs = Array.isArray(iceServers) && iceServers.length > 0
      ? iceServers.map((server) => {
        const entry = {
          urls: server.urls || (server.url ? [server.url] : [])
        };
        if (server.username) entry.username = server.username;
        if (server.credential) entry.credential = server.credential;
        return entry;
      })
      : [];

    const pc = new this.PeerConnectionClass({ iceServers: configs });
    this.peerConnection = pc;

    // 1. ICE Candidate generation -> send via RTC WebSocket
    pc.onicecandidate = (event) => {
      const candidate = event?.candidate;
      if (candidate && this.rtcBridge?.sendCandidate) {
        const candStr = candidate.candidate || candidate.sdp || '';
        const sdpMid = candidate.sdpMid || '';
        const sdpMLineIndex = candidate.sdpMLineIndex ?? 0;
        if (candStr) {
          console.log('[VoiceCallManager] ICE_SENT');
          this.rtcBridge.sendCandidate(candStr, sdpMid, sdpMLineIndex).catch(() => { });
        }
      }
    };

    // 2. Remote audio / video track reception
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        if (!this._remoteStream) {
          this._remoteStream = event.streams[0];
        } else if (this._remoteStream !== event.streams[0]) {
          const incomingTracks = event.streams[0].getTracks ? event.streams[0].getTracks() : [];
          for (const track of incomingTracks) {
            const existing = this._remoteStream.getTracks ? this._remoteStream.getTracks() : [];
            if (!existing.includes(track) && typeof this._remoteStream.addTrack === 'function') {
              this._remoteStream.addTrack(track);
            }
          }
        }
      } else if (event.track) {
        if (!this._remoteStream && typeof globalThis.MediaStream !== 'undefined') {
          this._remoteStream = new globalThis.MediaStream();
        }
        if (this._remoteStream && typeof this._remoteStream.addTrack === 'function') {
          const existing = this._remoteStream.getTracks ? this._remoteStream.getTracks() : [];
          if (!existing.includes(event.track)) {
            this._remoteStream.addTrack(event.track);
          }
        }
      }

      if (event.track && event.track.kind === 'video') {
        const remoteVideoTrack = event.track;
        const handleRemoteVideoEnded = () => {
          if (this.remoteScreenSharing) {
            this.setRemoteScreenShareState(false, null);
          }
        };
        remoteVideoTrack.onended = handleRemoteVideoEnded;
        // Note: Do NOT bind handleRemoteVideoEnded to onmute. Transient network drops trigger
        // onmute events and must not falsely tear down active video feeds.
      }

      if (this.remoteAudioElement && this._remoteStream) {
        this.remoteAudioElement.srcObject = this._remoteStream;
        this.remoteAudioElement.play?.().catch(() => { });
      }

      const hasRemoteVideo = Boolean(
        (event.track && event.track.kind === 'video') ||
        (this._remoteStream?.getVideoTracks && this._remoteStream.getVideoTracks().length > 0)
      );

      if (!this._isOriginalVideoCall && !this.isVideo && hasRemoteVideo && !this.remoteScreenSharing) {
        this.setRemoteScreenShareState(true, null);
      }

      if ((this.isVideo || this.remoteScreenSharing || hasRemoteVideo) && this.remoteVideoElement && this._remoteStream) {
        if (!this._isOriginalVideoCall && !this.remoteScreenSharing && !this.isVideo) {
          this.remoteVideoElement.srcObject = null;
        } else {
          this.remoteVideoElement.srcObject = this._remoteStream;
          this.remoteVideoElement.play?.().catch(() => { });
        }
      }

      this.emit('remoteStream', { stream: this._remoteStream, track: event.track, kind: event.track?.kind });

      // Transition to CONNECTED only when in CONNECTING, or if receiving remote track in OUTGOING_RINGING transition through CONNECTING
      if (this.state === CALL_STATE.CONNECTING) {
        this._markConnected();
      } else if (this.state === CALL_STATE.OUTGOING_RINGING && (this._calleeAccepted || !this.sendSignal)) {
        this._setState(CALL_STATE.CONNECTING);
        this._markConnected();
      }
    };

    // 3. ICE / Connection state monitoring
    const handleStateChange = () => {
      const iceState = pc.iceConnectionState;
      const connState = pc.connectionState;

      console.log('[VoiceCallManager] ICE_CONNECTION_STATE:', iceState);
      console.log('[VoiceCallManager] PEER_CONNECTION_STATE:', connState);

      if (iceState === 'connected' || iceState === 'completed' || connState === 'connected') {
        this._clearIceDisconnectTimer();
        // Mark connected ONLY for calls already in CONNECTING state.
        // Neither caller (OUTGOING_RINGING) nor callee (INCOMING_RINGING) must transition
        // to CONNECTED on ICE connection alone before genuine remote acceptance.
        if (this.state === CALL_STATE.CONNECTING) {
          this._markConnected();
        }
      } else if (iceState === 'failed' || connState === 'failed') {
        this._clearIceDisconnectTimer();
        if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING ||
          this.state === CALL_STATE.OUTGOING_RINGING || this.state === CALL_STATE.INCOMING_RINGING) {
          this._setState(CALL_STATE.FAILED, 'Call connection failed');
          this.endCall(false);
        }
      } else if (connState === 'closed') {
        this._clearIceDisconnectTimer();
        if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING ||
          this.state === CALL_STATE.OUTGOING_RINGING) {
          this._setState(CALL_STATE.ENDED);
          this.endCall(false);
        }
      } else if (iceState === 'disconnected' || connState === 'disconnected') {
        this._startIceDisconnectTimer();
      }
    };

    pc.oniceconnectionstatechange = handleStateChange;
    pc.onconnectionstatechange = handleStateChange;

    return pc;
  }

  /**
   * Attaches acquired local microphone (and camera) tracks to PeerConnection.
   * @private
   */
  _attachLocalTracks() {
    if (!this.peerConnection || !this._localStream) return;
    try {
      const senders = this.peerConnection.getSenders ? this.peerConnection.getSenders() : [];
      const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];

      if (this._localAudioTrack) {
        const audioTc = transceivers.find(t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio');
        if (audioTc && !audioTc.sender.track && typeof audioTc.sender.replaceTrack === 'function') {
          audioTc.sender.replaceTrack(this._localAudioTrack).catch(() => { });
          if (audioTc.direction !== 'sendrecv') audioTc.direction = 'sendrecv';
        } else if (!senders.some(s => s.track === this._localAudioTrack)) {
          this.peerConnection.addTrack(this._localAudioTrack, this._localStream);
        }
      }

      if (this._localVideoTrack) {
        const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1'));
        if (videoTc && !videoTc.sender.track && typeof videoTc.sender.replaceTrack === 'function') {
          videoTc.sender.replaceTrack(this._localVideoTrack).catch(() => { });
          if (videoTc.direction !== 'sendrecv') videoTc.direction = 'sendrecv';
        } else if (!senders.some(s => s.track === this._localVideoTrack)) {
          this.peerConnection.addTrack(this._localVideoTrack, this._localStream);
        }
      }

      // Configure 4K and Noise-Cancelled Audio Encodings
      const currentSenders = this.peerConnection.getSenders ? this.peerConnection.getSenders() : [];
      for (const sender of currentSenders) {
        if (sender?.track?.kind === 'video' && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
          try {
            const params = sender.getParameters();
            if (params && params.encodings && params.encodings[0]) {
              params.encodings[0].maxBitrate = 10000000; // 10 Mbps for 4K video
              params.encodings[0].maxFramerate = 60;
              params.encodings[0].networkPriority = 'high';
              sender.setParameters(params).catch(() => {});
            }
          } catch (_) {}
        } else if (sender?.track?.kind === 'audio' && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
          try {
            const params = sender.getParameters();
            if (params && params.encodings && params.encodings[0]) {
              params.encodings[0].maxBitrate = 128000; // 128 kbps crystal clear voice
              sender.setParameters(params).catch(() => {});
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error('[VoiceCallManager] Failed to attach local tracks:', err);
    }
  }

  /**
   * Normalizes a raw candidate into an IceCandidate instance.
   * @private
   */
  _toIceCandidate(raw) {
    if (!raw) return null;
    const candStr = typeof raw === 'string' ? raw : (raw.candidate || raw.sdp || '');
    const sdpMid = typeof raw === 'object' && raw.sdpMid ? raw.sdpMid : '';
    const sdpMLineIndex = typeof raw === 'object' && raw.sdpMLineIndex != null ? raw.sdpMLineIndex : 0;
    return new this.IceCandidateClass({
      candidate: candStr,
      sdpMid,
      sdpMLineIndex
    });
  }

  /**
   * Drains queued ICE candidates once remote description is established.
   * @private
   */
  async _drainQueuedCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    while (this._pendingIceCandidates.length > 0) {
      const rawCand = this._pendingIceCandidates.shift();
      try {
        const iceCand = this._toIceCandidate(rawCand);
        if (iceCand) {
          await this.peerConnection.addIceCandidate(iceCand);
        }
      } catch (err) {
        console.warn('[VoiceCallManager] Error draining ICE candidate:', err);
      }
    }
  }

  /**
   * Transitions to CONNECTED state.
   * Starts duration timer strictly from 00:00 and stops any ringing audio and timeouts.
   * @private
   */
  _markConnected() {
    // Only transition to CONNECTED strictly from CONNECTING.
    // OUTGOING_RINGING and INCOMING_RINGING must NEVER transition to CONNECTED automatically before accept/answer.
    if (this.state === CALL_STATE.CONNECTING) {
      this._connectedEpoch = Date.now();
      this._clearRingingTimer();
      if (this.ringtone) {
        this.ringtone.stop();
      }
      console.log(`[VoiceCallManager] CALL_CONNECTED (${this.mode})`, { roomId: this.roomId });
      this._setState(CALL_STATE.CONNECTED);
      this.startCallDurationTimer();
    }
  }

  /**
   * Initiates an outgoing call (voice or video).
   * Caller Flow:
   * OUTGOING_RINGING -> Acquire Media -> Connect RTC WebSocket -> Create PeerConnection & Attach Tracks -> Create Offer -> Send Offer.
   *
   * @param {string} roomId
   * @param {string} [peerName="Call"]
   * @param {object} [options]
   * @param {boolean} [options.isVideo=false]
   * @param {string} [options.mode="voice"]
   * @param {string} [options.peerPhone=""]
   */
  async startCall(roomId, peerName = 'Call', { isVideo = false, mode = 'voice', peerPhone = '' } = {}) {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      throw new Error('roomId is required to start a call');
    }
    if (this.state !== CALL_STATE.IDLE && this.state !== CALL_STATE.ENDED && this.state !== CALL_STATE.FAILED) {
      throw new Error(`Cannot start call: existing call active in state "${this.state}"`);
    }

    this.roomId = roomId.trim();
    let cleanPeerName = peerName && !isInternalIdOrUuid(peerName) ? peerName.trim() : '';
    let cleanPeerPhone = peerPhone && typeof peerPhone === 'string' ? peerPhone.trim() : '';
    if (!cleanPeerName && cleanPeerPhone) {
      cleanPeerName = cleanPeerPhone;
    } else if (!cleanPeerName) {
      cleanPeerName = (isVideo || mode === 'video') ? 'Video Call' : 'Voice Call';
    }
    this.peerName = cleanPeerName;
    this.peerPhone = cleanPeerPhone;
    this._isIncoming = false;
    this.isVideo = Boolean(isVideo || mode === 'video');
    this.mode = this.isVideo ? 'video' : 'voice';
    this._isOriginalVideoCall = this.isVideo;
    this._screenVideoSender = null;
    this._calleeAccepted = false;
    this.isMuted = false;
    this.isCameraOff = false;
    this._callStartEpoch = Date.now();
    this._connectedEpoch = 0;
    this._pendingIceCandidates = [];
    this._inviteSent = false;
    this.stopCallDurationTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }

    console.log(`[VoiceCallManager] CALL_STARTED (caller ${this.mode})`, { roomId: this.roomId, peerName: this.peerName });
    this._setState(CALL_STATE.OUTGOING_RINGING);
    this._startRingingTimer(30000);
    this._setupRtcListener();

    try {
      // 1. Acquire media (audio for voice, audio + video for video)
      await this._acquireMedia(this.isVideo);

      // 2. Connect RTC WebSocket and fetch iceServers
      const rtcRes = await this.rtcBridge.connect(this.roomId, { isVideo: this.isVideo, callType: this.mode });
      if (!rtcRes?.ok) {
        throw new Error(rtcRes?.error || 'Failed to connect RTC WebSocket');
      }
      console.log('[VoiceCallManager] RTC_CONNECTED', { roomId: this.roomId });
      const iceServers = rtcRes.iceServers || [];

      // 3. Create RTCPeerConnection and attach tracks
      const pc = this._createPeerConnection(iceServers);
      this._attachLocalTracks();

      // 4. Create SDP offer and set local description
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.isVideo
      });
      await pc.setLocalDescription(offer);

      // 5. Transmit offer via RTC WebSocket with call metadata
      console.log(`[VoiceCallManager] OFFER_SENT (caller ${this.mode})`);
      await this.rtcBridge.sendOffer(offer.sdp, { isVideo: this.isVideo, callType: this.mode });

      // 6. Transmit invite signal to callee now that local media and RTC signaling connection are ready
      if (this.sendSignal && this.roomId) {
        try {
          this.sendSignal({
            action: 'invite',
            roomId: this.roomId,
            callType: this.mode,
            isVideo: this.isVideo
          });
          this._inviteSent = true;
        } catch (_) { }
      }
    } catch (err) {
      if (this._inviteSent && this.sendSignal && this.roomId) {
        try {
          this.sendSignal({ action: 'cancel', roomId: this.roomId });
        } catch (_) { }
      }
      this._setState(CALL_STATE.FAILED, err.message || 'Call failed');
      await this.endCall(false);
      throw err;
    }
  }

  /**
   * Helper to start an outgoing video call directly.
   * @param {string} roomId
   * @param {string} [peerName="Video Call"]
   * @param {object} [options]
   */
  async startVideoCall(roomId, peerName = 'Video Call', options = {}) {
    return this.startCall(roomId, peerName, { ...options, isVideo: true, mode: 'video' });
  }

  /**
   * Handles incoming call invitation announced over Chat WebSocket ("call.started").
   * Enters INCOMING_RINGING state, starts ringtone, and starts 30-second timeout.
   *
   * @param {object} params
   * @param {string} params.roomId
   * @param {string} params.callId
   * @param {string} [params.initiator]
   * @param {boolean} [params.isVideo=false]
   * @param {string} [params.callType="voice"]
   * @param {string} [params.peerName=""]
   * @param {string} [params.peerPhone=""]
   */
  handleIncomingCall({ roomId, callId, initiator, isVideo = false, callType = 'voice', peerName = '', peerPhone = '', ...options } = {}) {
    // If already in a call, ignore incoming call to prevent duplicate connections
    if (this.state !== CALL_STATE.IDLE && this.state !== CALL_STATE.ENDED && this.state !== CALL_STATE.FAILED) {
      return;
    }
    if (!roomId) return;

    this.stopCallDurationTimer();
    this.roomId = roomId;
    this.callId = callId || roomId;
    const resolvedIsVideo = Boolean(
      isVideo === true ||
      callType === 'video' ||
      options?.isVideo === true ||
      options?.callType === 'video' ||
      options?.is_video === true ||
      options?.call_type === 'video'
    );
    this.isVideo = resolvedIsVideo;
    this.mode = resolvedIsVideo ? 'video' : 'voice';
    this._isOriginalVideoCall = resolvedIsVideo;
    this._screenVideoSender = null;

    let cleanName = peerName && !isInternalIdOrUuid(peerName) ? peerName.trim() : '';
    let cleanPhone = peerPhone && typeof peerPhone === 'string' ? peerPhone.trim() : '';
    if (!cleanName && initiator && !isInternalIdOrUuid(initiator)) {
      cleanName = initiator.trim();
    }
    if (!cleanName && cleanPhone) {
      cleanName = cleanPhone;
    } else if (!cleanName) {
      cleanName = this.isVideo ? 'Incoming Video Call' : 'Incoming Voice Call';
    }

    this.peerName = cleanName;
    this.peerPhone = cleanPhone;
    this._isIncoming = true;
    this.isMuted = false;
    this.isCameraOff = false;
    this._callStartEpoch = Date.now();
    this._connectedEpoch = 0;
    this._pendingIceCandidates = [];
    this._pendingOffer = null;

    console.log(`[VoiceCallManager] CALL_STARTED (callee incoming ${this.mode})`, { roomId: this.roomId, initiator: this.peerName });
    this._setState(CALL_STATE.INCOMING_RINGING);
    this._startRingingTimer(30000);
    if (this.ringtone) {
      this.ringtone.start();
    }

    // Set up RTC listener synchronously to receive early offer metadata and remote cancel
    this._setupRtcListener();
    if (this.roomId && this.rtcBridge?.connect) {
      this.rtcBridge.connect(this.roomId, { isVideo: this.isVideo, callType: this.mode }).catch((err) => {
        console.warn('[VoiceCallManager] Non-fatal: RTC signaling connect while ringing failed:', err?.message || err);
      });
    }
  }

  /**
   * Accepts an incoming ringing call (voice or video).
   * Stops ringtone and connects to RTC session.
   * Callee Flow:
   * CONNECTING -> Connect RTC WebSocket -> Acquire Media -> Create PeerConnection & Attach Tracks -> Create/Send Offer (or Answer pending offer).
   */
  async acceptCall() {
    if (this.state !== CALL_STATE.INCOMING_RINGING) {
      throw new Error(`Cannot accept call: current state is "${this.state}" (expected "${CALL_STATE.INCOMING_RINGING}")`);
    }

    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    this._calleeAccepted = true;
    this._isIncoming = true;
    // Determine modality before acquiring media to prevent accidental downgrade to voice
    const pendingSdp = typeof this._pendingOffer?.sdp === 'string' ? this._pendingOffer.sdp : (this._pendingOffer?.sdp?.sdp || '');
    const sdpHasVideo = /(?:^|\r?\n)m=video\s+\d+\s+[^0]/i.test(pendingSdp);
    const isVideoCall = Boolean(
      this.isVideo ||
      this.mode === 'video' ||
      this._pendingOffer?.options?.isVideo === true ||
      this._pendingOffer?.options?.callType === 'video' ||
      this._pendingOffer?.options?.is_video === true ||
      this._pendingOffer?.options?.call_type === 'video' ||
      sdpHasVideo
    );

    if (isVideoCall) {
      this.isVideo = true;
      this.mode = 'video';
      this._isOriginalVideoCall = true;
    }

    this._setState(CALL_STATE.CONNECTING);
    this._setupRtcListener();

    if (this.sendSignal && this.roomId) {
      try {
        this.sendSignal({
          action: 'accept',
          roomId: this.roomId,
          callType: this.mode,
          isVideo: this.isVideo
        });
      } catch (_) { }
    }

    try {
      // 1. Acquire media (audio for voice, audio + video for video)
      await this._acquireMedia(this.isVideo);

      // 2. Connect RTC WebSocket and fetch iceServers (reuse existing connection if already connected)
      let iceServers = [];
      const rtcState = this.rtcBridge?.getState ? await this.rtcBridge.getState() : null;
      if (rtcState === 'connected' && this.rtcBridge?.getIceServers) {
        const iceRes = await this.rtcBridge.getIceServers(this.roomId);
        iceServers = iceRes?.iceServers || [];
      } else {
        const rtcRes = await this.rtcBridge.connect(this.roomId, { isVideo: this.isVideo, callType: this.mode });
        if (!rtcRes?.ok) {
          throw new Error(rtcRes?.error || 'Failed to connect RTC WebSocket');
        }
        console.log('[VoiceCallManager] RTC_CONNECTED', { roomId: this.roomId });
        iceServers = rtcRes.iceServers || [];
      }

      // 3. Create RTCPeerConnection and attach tracks
      const pc = this._createPeerConnection(iceServers);
      this._attachLocalTracks();

      // 4. If an offer was preserved while ringing, answer it now!
      if (this._pendingOffer) {
        const pending = this._pendingOffer;
        this._pendingOffer = null;
        console.log('[VoiceCallManager] Processing preserved offer on accept');
        const desc = new this.SessionDescriptionClass({ type: 'offer', sdp: pending.sdp });
        await pc.setRemoteDescription(desc);
        await this._drainQueuedCandidates();
        this._attachLocalTracks();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log('[VoiceCallManager] ANSWER_SENT (callee after accept)');
        await this.rtcBridge.sendAnswer(answer.sdp, pending.requestId);
        this._markConnected();
      } else {
        // 5. Otherwise create and send SDP offer to peer/SFU
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: this.isVideo
        });
        await pc.setLocalDescription(offer);

        // 6. Transmit offer via RTC WebSocket with call metadata
        console.log(`[VoiceCallManager] OFFER_SENT (callee ${this.mode})`);
        await this.rtcBridge.sendOffer(offer.sdp, { isVideo: this.isVideo, callType: this.mode });
      }
    } catch (err) {
      this._setState(CALL_STATE.FAILED, err.message || 'Failed to accept call');
      await this.endCall(false);
      throw err;
    }
  }

  /**
   * Declines an incoming ringing call without joining media.
   * Stops ringtone immediately.
   * Sends minimal RTC {"cmd":"leave"} to inform backend/caller of decline, then tears down RTC cleanly.
   */
  async declineCall() {
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.state !== CALL_STATE.INCOMING_RINGING) return;

    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();

    const targetRoomId = this.roomId;
    console.log('[VoiceCallManager] CALL_DECLINED (callee)', { roomId: targetRoomId });
    this._setState(CALL_STATE.DECLINED);

    if (this.sendSignal && targetRoomId) {
      try {
        this.sendSignal({ action: 'decline', roomId: targetRoomId });
      } catch (_) { }
    }

    // Send minimal RTC leave to notify backend/caller without joining audio/video or active UI
    if (targetRoomId && this.rtcBridge?.leave) {
      try {
        const rtcState = this.rtcBridge?.getState ? await this.rtcBridge.getState() : null;
        if (rtcState !== 'connected' && this.rtcBridge?.connect) {
          await this.rtcBridge.connect(targetRoomId);
        }
        await this.rtcBridge.leave();
        await new Promise((r) => setTimeout(r, 150));
      } catch (err) {
        console.warn('[VoiceCallManager] Error sending decline leave over RTC:', err?.message || err);
      }
    }

    this._cleanupResources();
    this._scheduleIdleTransition(CALL_STATE.DECLINED, 800);
  }

  /**
   * Handles remote call termination event announced over RTC or Chat WebSocket.
   * Distinguishes Caller Cancellation, Callee Decline, and Connected Remote Departure.
   *
   * @param {object} [params]
   * @param {string} [params.roomId]
   */
  async handleRemoteCallEnded({ roomId } = {}) {
    if (this.roomId && roomId && this.roomId !== roomId) {
      return;
    }
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();

    if (this.state === CALL_STATE.IDLE || this.isEnded) {
      return;
    }

    console.log(`[VoiceCallManager] Remote call ended while in state "${this.state}"`, { roomId: this.roomId });

    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      // Caller receives decline from callee
      this._setState(CALL_STATE.REMOTE_DECLINED);
      this._cleanupResources();
      this._scheduleIdleTransition(CALL_STATE.REMOTE_DECLINED, 800);
      return;
    }

    if (this.state === CALL_STATE.INCOMING_RINGING) {
      // Callee receives cancellation from caller
      this._setState(CALL_STATE.REMOTE_CANCELLED);
      this._cleanupResources();
      this._scheduleIdleTransition(CALL_STATE.REMOTE_CANCELLED, 800);
      return;
    }

    if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING) {
      // Connected remote participant left: CONNECTED -> REMOTE_ENDED -> ENDED -> IDLE
      this._setState(CALL_STATE.REMOTE_ENDED);
      this._setState(CALL_STATE.ENDED);
      this._cleanupResources();
      this._scheduleIdleTransition(CALL_STATE.ENDED, 800);
      return;
    }

    await this.endCall(false);
  }

  /**
   * Callee processes incoming offer from caller or SFU renegotiation.
   * @private
   */
  async _handleIncomingOffer(sdp, requestId = 0, options = {}) {
    try {
      console.log('[VoiceCallManager] OFFER_RECEIVED');

      // Preserve/extract video modality from options, payload, or SDP m=video line
      const sdpString = typeof sdp === 'string' ? sdp : (sdp?.sdp || '');
      const mediaBlocks = sdpString.split(/\r?\nm=/).slice(1);
      let hasActiveRemoteMedia = false;
      let hasInactiveRemoteMedia = false;
      let hasActiveVideoMedia = false;

      for (const block of mediaBlocks) {
        const isInactive = /a=inactive/i.test(block);
        const isSend = /a=sendonly|a=sendrecv/i.test(block);
        if (!isInactive && isSend) {
          hasActiveRemoteMedia = true;
        }
        if (isInactive) {
          hasInactiveRemoteMedia = true;
        }
        if (/^video\b/i.test(block) && !isInactive && isSend) {
          hasActiveVideoMedia = true;
        }
      }

      const sdpHasVideo = /(?:^|\r?\n)m=video\s+\d+\s+[^0]/i.test(sdpString);
      const isVideoDeactivated = Boolean(
        options?.isVideo === false ||
        options?.is_video === false ||
        options?.callType === 'voice' ||
        options?.call_type === 'voice' ||
        !hasActiveVideoMedia
      );

      // If callee is still in INCOMING_RINGING, do NOT answer and do NOT mark connected!
      // Preserve offer for acceptCall() and remain ringing.
      if (this.state === CALL_STATE.INCOMING_RINGING) {
        const isVideoOffer = Boolean(
          (options?.isVideo === true || options?.callType === 'video' || options?.is_video === true || options?.call_type === 'video') ||
          (sdpHasVideo && hasActiveVideoMedia)
        );

        if (isVideoOffer && !this.isVideo) {
          this.isVideo = true;
          this.mode = 'video';
          this._isOriginalVideoCall = true;
          if (this.peerName === 'Incoming Voice Call' || this.peerName === 'Voice Call') {
            this.peerName = 'Incoming Video Call';
          }
          this.emit('modeChange', { mode: 'video', isVideo: true });
        }

        console.log('[VoiceCallManager] Callee still ringing — preserving incoming offer for accept flow');
        this._pendingOffer = { sdp: sdpString, requestId, options };
        return;
      }

      if (!this.peerConnection) {
        this._pendingOffer = { sdp: sdpString, requestId, options };
        return;
      }

      // Handle active connected call renegotiations
      if (!this._isOriginalVideoCall) {
        if (isVideoDeactivated) {
          // Offerer deactivated video (stopped screen sharing in audio call)
          this.setRemoteScreenShareState(false, null);
          this.isVideo = false;
          this.mode = 'voice';
          if (this.remoteVideoElement) {
            this.remoteVideoElement.srcObject = null;
            try { this.remoteVideoElement.load?.(); } catch (_) { }
          }
          this.emit('modeChange', { mode: 'voice', isVideo: false });
        } else if (hasActiveVideoMedia) {
          // Offerer started sending video during an audio call (started screen sharing)
          this.setRemoteScreenShareState(true, null);
        }
      } else {
        // Video call: if video media was deactivated entirely
        if (!hasActiveVideoMedia && this.remoteScreenSharing) {
          this.setRemoteScreenShareState(false, null);
        }
      }

      if (this.state === CALL_STATE.OUTGOING_RINGING && hasActiveRemoteMedia) {
        this._setState(CALL_STATE.CONNECTING);
      }

      const isRemoteDeparture = (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING) &&
        hasInactiveRemoteMedia &&
        !hasActiveRemoteMedia;

      const desc = new this.SessionDescriptionClass({ type: 'offer', sdp: sdpString });
      await this.peerConnection.setRemoteDescription(desc);
      await this._drainQueuedCandidates();

      // Ensure local tracks attached
      this._attachLocalTracks();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      // Transmit answer back via RTC WebSocket
      console.log('[VoiceCallManager] ANSWER_SENT');
      await this.rtcBridge.sendAnswer(answer.sdp, requestId);

      if (isRemoteDeparture) {
        console.log('[VoiceCallManager] Remote participant departed (all remote media renegotiated to inactive by SFU)');
        if (this.ringtone) this.ringtone.stop();
        this.stopCallDurationTimer();
        this._clearIceDisconnectTimer();
        this._clearRingingTimer();
        await this.handleRemoteCallEnded({ roomId: this.roomId });
      } else if (this.state === CALL_STATE.CONNECTING) {
        // SFU offer received + callee answer sent = SDP negotiation complete.
        // Mark connected strictly when in CONNECTING state.
        console.log('[VoiceCallManager] CALLEE_NEGOTIATION_COMPLETE: marking CONNECTED');
        this._markConnected();
      }
    } catch (err) {
      console.error('[VoiceCallManager] Failed to process offer:', err);
      this._setState(CALL_STATE.FAILED, 'Failed to establish call media');
      await this.endCall(false);
    }
  }

  /**
   * Handles explicit acceptance notification from callee.
   * @param {object} params
   * @param {string} [params.roomId]
   */
  handleCallAccepted({ roomId } = {}) {
    if (roomId && this.roomId && String(roomId).trim() !== String(this.roomId).trim()) return;
    console.log('[VoiceCallManager] Callee accepted call invitation', { roomId: this.roomId });
    this._calleeAccepted = true;
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      this._setState(CALL_STATE.CONNECTING);
    }
    if (
      this.state === CALL_STATE.CONNECTING &&
      (this.peerConnection?.connectionState === 'connected' ||
        this.peerConnection?.iceConnectionState === 'connected' ||
        this.peerConnection?.iceConnectionState === 'completed' ||
        this._remoteStream ||
        !this.rtcBridge)
    ) {
      this._markConnected();
    }
  }

  /**
   * Caller processes incoming answer from callee or SFU.
   * @private
   */
  async _handleIncomingAnswer(sdp) {
    if (!this.peerConnection) return;
    try {
      console.log('[VoiceCallManager] ANSWER_RECEIVED');

      // Check if incoming SDP answer contains active remote media sent by the peer
      const mediaBlocks = (typeof sdp === 'string' ? sdp : '').split(/\r?\nm=/).slice(1);
      let hasActiveRemoteMedia = false;
      for (const block of mediaBlocks) {
        const isInactive = /a=inactive/i.test(block);
        const isSend = /a=sendonly|a=sendrecv/i.test(block);
        if (!isInactive && isSend) {
          hasActiveRemoteMedia = true;
          break;
        }
      }

      const desc = new this.SessionDescriptionClass({ type: 'answer', sdp });
      await this.peerConnection.setRemoteDescription(desc);
      await this._drainQueuedCandidates();

      if (hasActiveRemoteMedia && (this._calleeAccepted || !this.sendSignal || this._isIncoming)) {
        // Genuine remote peer answer with active media tracks
        if (this.state === CALL_STATE.OUTGOING_RINGING) {
          this._setState(CALL_STATE.CONNECTING);
        }
        if (this.state === CALL_STATE.CONNECTING) {
          this._markConnected();
        }
      } else {
        // SFU publish uplink acknowledgment (recvonly/inactive or awaiting callee accept).
        // Remote party has not accepted yet.
        // Maintain OUTGOING_RINGING state and keep ringing timer active.
        console.log('[VoiceCallManager] SFU uplink answer processed (no active remote media yet, remaining in OUTGOING_RINGING)');
      }
    } catch (err) {
      console.error('[VoiceCallManager] Failed to process answer:', err);
      this._setState(CALL_STATE.FAILED, 'Failed to process call answer');
      await this.endCall(false);
    }
  }

  /**
   * Processes remote ICE candidate, queuing if remote description is not yet set.
   * @private
   */
  async _handleIncomingCandidate(candidateObj) {
    if (!candidateObj) return;

    console.log('[VoiceCallManager] ICE_RECEIVED');
    if (this.peerConnection?.remoteDescription?.type) {
      try {
        const iceCand = this._toIceCandidate(candidateObj);
        if (iceCand) {
          await this.peerConnection.addIceCandidate(iceCand);
        }
      } catch (err) {
        console.warn('[VoiceCallManager] Failed to add remote candidate:', err);
      }
    } else {
      this._pendingIceCandidates.push(candidateObj);
    }
  }

  /**
   * Toggles microphone mute state locally without destroying PeerConnection.
   * Muting microphone NEVER terminates the call.
   * @returns {boolean} New mute state
   */
  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this._localAudioTrack) {
      this._localAudioTrack.enabled = !this.isMuted;
    }
    this.emit('muteChange', { isMuted: this.isMuted });
    return this.isMuted;
  }

  /**
   * Toggles camera video track locally without destroying PeerConnection.
   * If local video track was not yet acquired (e.g. call accepted as audio or dynamic video upgrade),
   * dynamically acquires camera via enableCamera().
   * Turning camera off NEVER terminates the call.
   * @returns {boolean|Promise<boolean>} New camera off state
   */
  toggleCamera() {
    if (this.isCameraOff) {
      // User is turning camera ON
      if (!this._localVideoTrack) {
        return this.enableCamera().then((enabled) => !enabled).catch((err) => {
          console.warn('[VoiceCallManager] Camera toggle enable failed:', err);
          return true;
        });
      }
      this.isCameraOff = false;
      this._localVideoTrack.enabled = true;
      if (this.peerConnection) {
        const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];
        const videoTc = transceivers.find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1')));
        if (videoTc) {
          if (videoTc.sender && typeof videoTc.sender.replaceTrack === 'function') {
            videoTc.sender.replaceTrack(this._localVideoTrack).catch(() => { });
          }
          if (videoTc.direction !== 'sendrecv') {
            videoTc.direction = 'sendrecv';
          }
        }
      }
      if (this.localVideoElement) {
        this.localVideoElement.srcObject = this._localStream;
        this.localVideoElement.play?.().catch(() => { });
      }
      this.emit('cameraChange', { isCameraOff: false });
      return false;
    } else {
      // User is turning camera OFF
      this.isCameraOff = true;
      if (this._localVideoTrack) {
        this._localVideoTrack.enabled = false;
      }
      this.emit('cameraChange', { isCameraOff: true });
      return true;
    }
  }

  /**
   * Dynamically acquires local camera and attaches it to PeerConnection for voice->video switch.
   * @returns {Promise<boolean>} Whether camera was successfully enabled
   */
  async enableCamera() {
    if (this._localVideoTrack) {
      this.isCameraOff = false;
      this._localVideoTrack.enabled = true;
      this.isVideo = true;
      this.mode = 'video';
      if (this.peerConnection) {
        const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];
        const videoTc = transceivers.find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1')));
        if (videoTc) {
          if (videoTc.sender && typeof videoTc.sender.replaceTrack === 'function') {
            await videoTc.sender.replaceTrack(this._localVideoTrack).catch(() => { });
          }
          if (videoTc.direction !== 'sendrecv') {
            videoTc.direction = 'sendrecv';
          }
        }
      }
      if (this.localVideoElement) {
        this.localVideoElement.srcObject = this._localStream;
        this.localVideoElement.play?.().catch(() => { });
      }
      this.emit('cameraChange', { isCameraOff: false });
      this.emit('modeChange', { mode: 'video', isVideo: true });
      return true;
    }
    if (this.peerConnection && this.mediaDevices?.getUserMedia) {
      try {
        const stream = await this.mediaDevices.getUserMedia({ audio: false, video: true });
        const videoTrack = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
        if (videoTrack) {
          if (typeof videoTrack.applyConstraints === 'function') {
            try {
              await videoTrack.applyConstraints({
                width: { ideal: 3840, max: 3840 },
                height: { ideal: 2160, max: 2160 },
                frameRate: { ideal: 30, max: 60 }
              });
            } catch (_) {}
          }
          this._localVideoTrack = videoTrack;
          this.isCameraOff = false;
          this.isVideo = true;
          this.mode = 'video';
          if (this._localStream && typeof this._localStream.addTrack === 'function') {
            this._localStream.addTrack(videoTrack);
          } else {
            this._localStream = stream;
          }
          if (this.localVideoElement) {
            this.localVideoElement.srcObject = this._localStream || stream;
            this.localVideoElement.play?.().catch(() => { });
          }
          const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];
          const videoTc = transceivers.find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1')));
          if (videoTc) {
            if (videoTc.sender && typeof videoTc.sender.replaceTrack === 'function') {
              await videoTc.sender.replaceTrack(videoTrack).catch(() => { });
            }
            if (videoTc.direction !== 'sendrecv') {
              videoTc.direction = 'sendrecv';
            }
          } else {
            this._attachLocalTracks();
            if (this.peerConnection.createOffer && this.rtcBridge?.sendOffer) {
              const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
              });
              await this.peerConnection.setLocalDescription(offer);
              await this.rtcBridge.sendOffer(offer.sdp, { isVideo: true, callType: 'video' });
            }
          }
          this.emit('cameraChange', { isCameraOff: false });
          this.emit('modeChange', { mode: 'video', isVideo: true });
          return true;
        }
      } catch (err) {
        console.warn('[VoiceCallManager] Failed to dynamically acquire camera:', err);
      }
    }
    return false;
  }

  /**
   * Starts sharing screen or application window during an active call.
   * Replaces outgoing camera video track using sender.replaceTrack() on the existing m-line.
   * Keeps microphone audio completely untouched and requires zero SDP renegotiation.
   *
   * @param {string} sourceId - Electron desktopCapturer source ID (e.g. 'screen:0:0' or 'window:1234:0')
   * @returns {Promise<boolean>}
   */
  async startScreenShare(sourceId) {
    if (!sourceId || typeof sourceId !== 'string') {
      throw new Error('A valid sourceId is required to start screen sharing');
    }
    if (this.state !== CALL_STATE.CONNECTED && this.state !== CALL_STATE.CONNECTING) {
      throw new Error('Screen sharing can only be started during an active call');
    }
    if (this.remoteScreenSharing) {
      throw new Error('Another participant is already sharing their screen');
    }
    if (this.isScreenSharing) {
      console.warn('[VoiceCallManager] Screen sharing is already active');
      return true;
    }

    if (!this.mediaDevices?.getUserMedia) {
      throw new Error('Media access is not supported on this platform');
    }

    try {
      // 1. Preserve current camera state and track
      this._savedCameraTrack = this._localVideoTrack;
      this._savedCameraOff = Boolean(this.isCameraOff);

      // 2. Acquire screen/window display media stream (Strictly audio: false to prevent echo/loopback)
      const displayStream = await this.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId
          }
        }
      });

      const screenTracks = displayStream?.getVideoTracks ? displayStream.getVideoTracks() : [];
      const screenTrack = screenTracks[0] || null;
      if (!screenTrack) {
        throw new Error('No video track returned from screen capture source');
      }

      // Configure detail content hint for crisp desktop text and resolution preservation
      try {
        screenTrack.contentHint = 'detail';
      } catch (_) { }

      this._screenStream = displayStream;
      this._screenTrack = screenTrack;

      // 3. Find existing video RTCRtpSender or transceiver
      let videoSender = null;
      if (this.peerConnection?.getSenders) {
        const senders = this.peerConnection.getSenders() || [];
        const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];
        const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');
        videoSender = videoTc?.sender || senders.find((s) => s.track && s.track.kind === 'video');
        if (!videoSender && this._savedCameraTrack) {
          videoSender = senders.find((s) => s.track === this._savedCameraTrack);
        }
        if (!videoSender && this._screenVideoSender) {
          videoSender = senders.find((s) => s === this._screenVideoSender);
        }
      }

      if (videoSender && typeof videoSender.replaceTrack === 'function') {
        this._screenVideoSender = videoSender;
        await videoSender.replaceTrack(screenTrack);
        if (typeof videoSender.generateKeyFrame === 'function') {
          try {
            await videoSender.generateKeyFrame();
          } catch (err) {
            console.warn('[VoiceCallManager] generateKeyFrame non-fatal:', err?.message || err);
          }
        }

        // If restarting screen share in an audio call, renegotiate SDP to reactivate video
        if (!this._isOriginalVideoCall && this.peerConnection?.createOffer && this.rtcBridge?.sendOffer) {
          try {
            const offer = await this.peerConnection.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true
            });
            await this.peerConnection.setLocalDescription(offer);
            await this.rtcBridge.sendOffer(offer.sdp, { isVideo: true, callType: 'video' });
          } catch (renegErr) {
            console.warn('[VoiceCallManager] SDP renegotiation on screenshare restart non-fatal:', renegErr);
          }
        }
      } else if (this.peerConnection) {
        // Audio call flow (first time): add screen video track and renegotiate SDP with OllaCore / Janus SFU
        if (typeof this.peerConnection.addTrack === 'function') {
          videoSender = this.peerConnection.addTrack(screenTrack, displayStream);
        } else if (typeof this.peerConnection.addTransceiver === 'function') {
          const tx = this.peerConnection.addTransceiver(screenTrack, {
            direction: 'sendrecv',
            streams: [displayStream]
          });
          videoSender = tx?.sender || null;
        }
        this._screenVideoSender = videoSender;

        // Perform OllaCore WebRTC SDP renegotiation for audio -> video/screen upgrade
        if (this.peerConnection.createOffer && this.rtcBridge?.sendOffer) {
          const offer = await this.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
          });
          await this.peerConnection.setLocalDescription(offer);
          await this.rtcBridge.sendOffer(offer.sdp, { isVideo: true, callType: 'video' });
        }

        if (videoSender && typeof videoSender.generateKeyFrame === 'function') {
          try {
            await videoSender.generateKeyFrame();
          } catch (_) { }
        }
      }

      // Update active video track reference
      this._localVideoTrack = screenTrack;
      this.isScreenSharing = true;

      // 4. Update local video preview to display shared screen
      if (this.localVideoElement) {
        this.localVideoElement.srcObject = displayStream;
        this.localVideoElement.play?.().catch(() => { });
      }

      // 5. Handle OS-level termination (user closes window, stops capture via OS bar, etc.)
      screenTrack.onended = () => {
        console.log('[VoiceCallManager] Screen capture track ended at OS/window level');
        this.stopScreenShare().catch((err) => {
          console.warn('[VoiceCallManager] Error restoring camera after OS track end:', err);
        });
      };

      this.emit('screenShareChange', { isScreenSharing: true, sourceId });
      return true;
    } catch (err) {
      console.error('[VoiceCallManager] Failed to start screen sharing:', err);
      if (this._screenStream) {
        try {
          const tracks = this._screenStream.getTracks ? this._screenStream.getTracks() : [];
          tracks.forEach((t) => {
            t.onended = null;
            t.stop?.();
          });
        } catch { }
        this._screenStream = null;
        this._screenTrack = null;
      }
      this.isScreenSharing = false;
      this._localVideoTrack = this._savedCameraTrack;
      throw err;
    }
  }

  /**
   * Stops screen sharing and restores original camera video track.
   * Restores previous camera enabled/disabled state without ending call or renegotiating SDP.
   * Fully idempotent to safely handle concurrent manual stops and OS onended triggers.
   *
   * @returns {Promise<boolean>}
   */
  async stopScreenShare() {
    if (!this.isScreenSharing && !this._screenTrack && !this._screenStream) {
      return false; // Idempotent: already stopped
    }
    if (this._isStoppingScreenShare) {
      return false; // Prevent concurrent re-entry
    }

    this._isStoppingScreenShare = true;
    try {
      const cameraTrack = this._savedCameraTrack;
      const wasCameraOff = Boolean(this._savedCameraOff);
      this._savedCameraTrack = null;
      this._savedCameraOff = false;

      // 1. Restore camera enabled/disabled state before track replacement
      if (cameraTrack) {
        cameraTrack.enabled = !wasCameraOff;
      }

      // 2. Restore camera track on existing video sender (or set null for audio-only calls) before releasing screen capture
      if (this.peerConnection?.getSenders) {
        const senders = this.peerConnection.getSenders() || [];
        const transceivers = this.peerConnection.getTransceivers ? this.peerConnection.getTransceivers() : [];
        const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');
        const videoSender = videoTc?.sender || senders.find((s) => (s.track && s.track.kind === 'video') || s.track === this._screenTrack || (cameraTrack && s.track === cameraTrack) || s === this._screenVideoSender);
        if (videoSender && typeof videoSender.replaceTrack === 'function') {
          await videoSender.replaceTrack(cameraTrack || null);
          if (cameraTrack && typeof videoSender.generateKeyFrame === 'function') {
            try {
              await videoSender.generateKeyFrame();
            } catch (_) { }
          }
        }
      }

      // 3. Release screen capture track and stream
      if (this._screenTrack) {
        this._screenTrack.onended = null;
        try { this._screenTrack.stop?.(); } catch { }
        this._screenTrack = null;
      }
      if (this._screenStream) {
        try {
          const tracks = this._screenStream.getTracks ? this._screenStream.getTracks() : [];
          tracks.forEach((t) => {
            t.onended = null;
            t.stop?.();
          });
        } catch { }
        this._screenStream = null;
      }

      // 4. Restore camera enabled/disabled state exactly as it was before screen sharing
      this._localVideoTrack = cameraTrack;
      this.isCameraOff = cameraTrack ? wasCameraOff : true;
      if (cameraTrack) {
        cameraTrack.enabled = !wasCameraOff;
      }

      this.isScreenSharing = false;

      // 5. Restore local preview element
      if (this.localVideoElement) {
        if (this._localStream && cameraTrack && !this.isCameraOff) {
          this.localVideoElement.srcObject = this._localStream;
          this.localVideoElement.play?.().catch(() => { });
        } else {
          this.localVideoElement.srcObject = null;
        }
      }

      // 6. If original call was audio-only, renegotiate SDP back to audio to ensure viewer drops video cleanly
      if (!this._isOriginalVideoCall && !this.isVideo && this.peerConnection?.createOffer && this.rtcBridge?.sendOffer) {
        try {
          const offer = await this.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
          });
          await this.peerConnection.setLocalDescription(offer);
          await this.rtcBridge.sendOffer(offer.sdp, { isVideo: false, callType: 'voice' });
        } catch (renegErr) {
          console.warn('[VoiceCallManager] SDP renegotiation after screenshare stop non-fatal:', renegErr);
        }
      }

      this.emit('screenShareChange', { isScreenSharing: false });
      this.emit('cameraChange', { isCameraOff: this.isCameraOff });
      return true;
    } finally {
      this._isStoppingScreenShare = false;
    }
  }

  /**
   * Cleans up local media streams, tracks, PeerConnection, and sockets.
   * @private
   */
  _cleanupResources() {
    // 1. Stop microphone and camera tracks
    if (this._localAudioTrack) {
      try { this._localAudioTrack.stop?.(); } catch { }
      this._localAudioTrack = null;
    }
    if (this._localVideoTrack) {
      try { this._localVideoTrack.stop?.(); } catch { }
      this._localVideoTrack = null;
    }
    if (this._savedCameraTrack && this._savedCameraTrack !== this._localVideoTrack) {
      try { this._savedCameraTrack.stop?.(); } catch { }
      this._savedCameraTrack = null;
    }
    if (this._localStream) {
      try {
        const tracks = this._localStream.getTracks ? this._localStream.getTracks() : [];
        tracks.forEach(t => t.stop?.());
      } catch { }
      this._localStream = null;
    }

    // 1b. Stop and release screen sharing tracks and state if active
    if (this._screenTrack) {
      this._screenTrack.onended = null;
      try { this._screenTrack.stop?.(); } catch { }
      this._screenTrack = null;
    }
    if (this._screenStream) {
      try {
        const tracks = this._screenStream.getTracks ? this._screenStream.getTracks() : [];
        tracks.forEach(t => {
          t.onended = null;
          t.stop?.();
        });
      } catch { }
      this._screenStream = null;
    }
    this.isScreenSharing = false;
    this.remoteScreenSharing = false;
    this.activeScreenSharerId = null;
    this._savedCameraTrack = null;
    this._savedCameraOff = false;
    this._isStoppingScreenShare = false;
    this._isOriginalVideoCall = false;
    this._screenVideoSender = null;

    // 2. Close RTCPeerConnection
    if (this.peerConnection) {
      try {
        this.peerConnection.oniceconnectionstatechange = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.close();
      } catch { }
      this.peerConnection = null;
    }

    // 3. Detach local and remote video / audio elements
    if (this.localVideoElement) {
      try { this.localVideoElement.srcObject = null; } catch { }
    }
    if (this.remoteVideoElement) {
      try { this.remoteVideoElement.srcObject = null; } catch { }
    }
    if (this.remoteAudioElement) {
      try { this.remoteAudioElement.srcObject = null; } catch { }
    }
    this._remoteStream = null;
    this._pendingIceCandidates = [];
    this._pendingOffer = null;
    if (this.participants) {
      this.participants.clear();
    }

    // 4. Disconnect RTC WebSocket
    if (this.rtcBridge?.disconnect) {
      try {
        this.rtcBridge.disconnect();
      } catch { }
    }

    if (this._unsubscribeRtcEvents) {
      this._unsubscribeRtcEvents();
      this._unsubscribeRtcEvents = null;
    }
  }

  /**
   * Terminates active call, tears down WebRTC and RTC signaling, and stops all media tracks.
   * Handles caller cancellation, local hangup, and failure teardowns.
   *
   * @param {boolean} [sendLeave=true] - Whether to send RTC "leave" frame
   */
  async endCall(sendLeave = true) {
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();
    if (this.state === CALL_STATE.IDLE || this.isEnded) {
      this._cleanupResources();
      return;
    }

    // Caller cancelling before acceptance
    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      console.log(`[VoiceCallManager] CALL_CANCELLED (caller ${this.mode})`, { roomId: this.roomId });
      this._setState(CALL_STATE.CANCELLED, this.error);

      if (this.sendSignal && this.roomId) {
        try {
          this.sendSignal({ action: 'cancel', roomId: this.roomId });
        } catch (_) { }
      }

      if (sendLeave && this.rtcBridge?.leave) {
        try {
          await this.rtcBridge.leave();
        } catch { }
      }

      this._cleanupResources();
      this._scheduleIdleTransition(CALL_STATE.CANCELLED, 800);
      return;
    }

    console.log(`[VoiceCallManager] CALL_ENDED (${this.mode})`, { roomId: this.roomId });
    this._setState(CALL_STATE.ENDING, this.error);

    // Send leave frame
    if (sendLeave && this.rtcBridge?.leave) {
      try {
        await this.rtcBridge.leave();
      } catch { }
    }

    this._cleanupResources();
    this._setState(CALL_STATE.ENDED, this.error);
    this._scheduleIdleTransition(CALL_STATE.ENDED, 800);
  }
}
