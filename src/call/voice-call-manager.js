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
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.DECLINED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.CANCELLED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_DECLINED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_CANCELLED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.REMOTE_ENDED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.NO_ANSWER]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
    CALL_STATE.ENDING,
    CALL_STATE.ENDED,
    CALL_STATE.IDLE
  ],
  [CALL_STATE.FAILED]: [
    CALL_STATE.OUTGOING_RINGING,
    CALL_STATE.INCOMING_RINGING,
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
    // Peer-local monotonic ownership generation. Never shared as chat correlation.
    this.callEpoch = 0;
    this._callEpochCounter = 0;
    // Invitation-scoped chat signaling correlation copied by both peers.
    this.signalingEpoch = null;
    this._callIdIsSynthetic = false;
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
    this._rtcConnectPromise = null;
    this._rtcConnectEpoch = 0;
    this._negotiationChain = Promise.resolve();
    this._queuedSfuOffers = [];
    this._outstandingLocalOffer = null;
    this._earlyRemoteMedia = false;
    this._firstRemoteMediaAt = null;
    this._remoteMediaConnected = false;
    this._candidateCounts = { sent: 0, received: 0 };
    this._playbackDiagnostics = new Set();
    this._mediaDiagnosticOnce = new Set();
    this._statsTimer = null;
    this._statsSamples = 0;

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

  _beginCallInstance({ callId = null, syntheticCallId = false, signalingEpoch = undefined } = {}) {
    this._callEpochCounter += 1;
    this.callEpoch = this._callEpochCounter;
    this.signalingEpoch = signalingEpoch === undefined
      ? this.callEpoch
      : this._normalizeSignalingEpoch(signalingEpoch);
    this.callId = callId ? String(callId) : null;
    this._callIdIsSynthetic = Boolean(this.callId && syntheticCallId);
    this._callStartEpoch = Date.now();
    this._connectedEpoch = 0;
    this.callConnectedAt = null;
    this.durationSec = 0;
    this._rtcConnectPromise = null;
    this._rtcConnectEpoch = 0;
    this._resetMediaLifecycleState();
    return this.callEpoch;
  }

  _resetMediaLifecycleState() {
    if (this._statsTimer) {
      clearTimeout(this._statsTimer);
      this._statsTimer = null;
    }
    this._negotiationChain = Promise.resolve();
    this._queuedSfuOffers = [];
    this._outstandingLocalOffer = null;
    this._deferredLocalOffer = null;
    this._earlyRemoteMedia = false;
    this._firstRemoteMediaAt = null;
    this._remoteMediaConnected = false;
    this._candidateCounts = { sent: 0, received: 0 };
    this._playbackDiagnostics = new Set();
    this._mediaDiagnosticOnce = new Set();
    this._statsSamples = 0;
    this._localPublicationPending = false;
    this._pendingOffer = null;
  }

  _mediaLog(event, details = {}) {
    console.log('[VoiceCallManager] MEDIA_LIFECYCLE', {
      event,
      callEpoch: this.callEpoch,
      state: this.state,
      ...details
    });
  }

  _normalizeSignalingEpoch(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }

  _signalingCorrelation(value) {
    const provided = value !== undefined && value !== null && String(value).trim() !== '';
    if (!provided) {
      return { matches: true, result: 'legacy_missing' };
    }
    const received = this._normalizeSignalingEpoch(value);
    if (received === null) {
      return { matches: false, result: 'invalid' };
    }
    if (this.signalingEpoch === null) {
      return { matches: true, result: 'expected_unavailable' };
    }
    return {
      matches: received === this.signalingEpoch,
      result: received === this.signalingEpoch ? 'matched' : 'stale'
    };
  }

  _lifecycleLog(event, details = {}) {
    console.info('[VoiceCallManager] CALL_LIFECYCLE', {
      event,
      direction: this._isIncoming ? 'incoming' : 'outgoing',
      state: this.state,
      localOwnershipEpoch: this.callEpoch,
      signalingCorrelation: 'not_applicable',
      ...details
    });
  }

  _mediaLogOnce(key, event, details = {}) {
    if (this._mediaDiagnosticOnce.has(key)) return;
    this._mediaDiagnosticOnce.add(key);
    this._mediaLog(event, details);
  }

  _isCurrentPeer(epoch, pc) {
    return this._isCurrentEpoch(epoch) && Boolean(pc) && this.peerConnection === pc;
  }

  _serializeNegotiation(label, epoch, pc, operation) {
    const run = async () => {
      if (!this._isCurrentPeer(epoch, pc)) return undefined;
      this._mediaLog('negotiation_started', { stage: label, signalingState: pc.signalingState || 'unknown' });
      const result = await operation();
      if (!this._isCurrentPeer(epoch, pc)) return undefined;
      this._mediaLog('negotiation_completed', { stage: label, signalingState: pc.signalingState || 'unknown' });
      return result;
    };
    const result = this._negotiationChain.then(run, run);
    this._negotiationChain = result.catch((error) => {
      if (this._isCurrentPeer(epoch, pc)) {
        this._mediaLog('negotiation_failed', { stage: label, errorName: error?.name || 'Error' });
      }
    });
    return result;
  }

  _safeTrackSummary(track) {
    if (!track) return null;
    let settings = {};
    try {
      const raw = track.getSettings?.() || {};
      const allowed = ['width', 'height', 'frameRate', 'sampleRate', 'sampleSize', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl', 'resizeMode'];
      settings = allowed.reduce((summary, key) => {
        if (raw[key] !== undefined) summary[key] = raw[key];
        return summary;
      }, {});
    } catch { }
    return {
      kind: track.kind || 'unknown',
      readyState: track.readyState || 'unknown',
      enabled: track.enabled !== false,
      muted: Boolean(track.muted),
      settings
    };
  }

  _isCurrentEpoch(epoch) {
    return Boolean(epoch && epoch === this.callEpoch);
  }

  _identityLog() {
    return {
      hasRoomId: Boolean(this.roomId),
      hasCallId: Boolean(this.callId),
      callEpoch: this.callEpoch,
      hasSignalingEpoch: this.signalingEpoch !== null
    };
  }

  /**
   * Adopts the caller-issued signaling epoch for an incoming call whose epoch was unknown
   * (presented from server call.started before the caller's invite message arrived).
   * @returns {boolean} true if adopted
   */
  adoptSignalingEpoch(value, { roomId = null } = {}) {
    if (this.signalingEpoch !== null) return false;
    if (this.state !== CALL_STATE.INCOMING_RINGING) return false;
    if (roomId && this.roomId && String(roomId).trim() !== String(this.roomId).trim()) return false;
    const normalized = this._normalizeSignalingEpoch(value);
    if (normalized === null) return false;
    this.signalingEpoch = normalized;
    return true;
  }

  adoptAuthoritativeCallId(callId, {
    roomId = null,
    callEpoch = null,
    signalingEpoch = undefined,
    ownershipEpoch = null,
    trustedCurrentTransport = false
  } = {}) {
    if (callId === undefined || callId === null || String(callId).trim() === '') return false;
    const authoritativeId = String(callId).trim();
    if (roomId && this.roomId && String(roomId).trim() !== String(this.roomId).trim()) return false;
    const effectiveOwnershipEpoch = ownershipEpoch ?? (trustedCurrentTransport ? callEpoch : null);
    if (effectiveOwnershipEpoch != null && Number(effectiveOwnershipEpoch) !== this.callEpoch) return false;
    const effectiveSignalingEpoch = signalingEpoch !== undefined
      ? signalingEpoch
      : (!trustedCurrentTransport && ownershipEpoch == null ? callEpoch : undefined);
    if (effectiveSignalingEpoch !== undefined && !this._signalingCorrelation(effectiveSignalingEpoch).matches) return false;
    if (this.state === CALL_STATE.IDLE || this.isEnded) return false;
    if (this.callId && !this._callIdIsSynthetic && this.callId !== authoritativeId) {
      console.warn('[VoiceCallManager] Ignored conflicting authoritative call identity', {
        ...this._identityLog(),
        hasIncomingCallId: true
      });
      return false;
    }
    this.callId = authoritativeId;
    this._callIdIsSynthetic = false;
    console.log('[VoiceCallManager] Adopted authoritative call identity', this._identityLog());
    return true;
  }

  _signalPayload(action, extra = {}) {
    return {
      action,
      roomId: this.roomId,
      callEpoch: this.signalingEpoch ?? undefined,
      ...extra,
      callId: this.callId && !this._callIdIsSynthetic ? this.callId : undefined
    };
  }

  _connectRtcForEpoch(epoch) {
    if (!this._isCurrentEpoch(epoch) || !this.roomId || !this.rtcBridge?.connect) {
      return Promise.reject(new Error('Stale or unavailable RTC connection owner'));
    }
    if (this._rtcConnectPromise && this._rtcConnectEpoch === epoch) {
      return this._rtcConnectPromise;
    }
    const roomId = this.roomId;
    const options = {
      isVideo: this.isVideo,
      callType: this.mode,
      callId: this.callId || undefined,
      callEpoch: epoch,
      ownerId: `call-${epoch}`
    };
    this._rtcConnectEpoch = epoch;
    const connectPromise = Promise.resolve(this.rtcBridge.connect(roomId, options)).then((result) => {
      if (!this._isCurrentEpoch(epoch)) {
        throw new Error('RTC connection completed for a stale call owner');
      }
      return result;
    });
    this._rtcConnectPromise = connectPromise;
    connectPromise.catch(() => {
      if (this._rtcConnectPromise === connectPromise && this._rtcConnectEpoch === epoch) {
        this._rtcConnectPromise = null;
      }
    });
    return connectPromise;
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
          this._playRemoteElement(this.remoteVideoElement, 'video');
        }
      } else if (this.isVideo) {
        const remoteVideoTracks = this._remoteStream?.getVideoTracks ? this._remoteStream.getVideoTracks() : [];
        const hasLiveTrack = remoteVideoTracks.some(t => t.readyState === 'live');
        if (hasLiveTrack && this._remoteStream) {
          this._playRemoteElement(this.remoteVideoElement, 'video');
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
      callEpoch: this.callEpoch,
      signalingEpoch: this.signalingEpoch,
      callIdIsSynthetic: this._callIdIsSynthetic,
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
    if (this._remoteStream && this.remoteAudioElement && this.peerConnection) {
      this._playRemoteElement(this.remoteAudioElement, 'audio');
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
    if (this._remoteStream && this.remoteVideoElement && this.peerConnection && (this.isVideo || this.remoteScreenSharing)) {
      this._playRemoteElement(this.remoteVideoElement, 'video');
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
    console.log('[VoiceCallManager] State transition', {
      state: newState,
      ...this._identityLog()
    });
    this.emit('stateChange', {
      state: newState,
      roomId: this.roomId,
      callId: this.callId,
      callEpoch: this.callEpoch,
      peerName: this.peerName,
      peerPhone: this.peerPhone,
      error
    });
  }

  /**
   * Starts 30-second ringing timeout.
   * @private
   */
  _startRingingTimer(durationMs = 30000, epoch = this.callEpoch) {
    this._clearRingingTimer();
    this._ringingTimer = setTimeout(async () => {
      this._ringingTimer = null;
      if (!this._isCurrentEpoch(epoch)) return;
      if (this.state === CALL_STATE.OUTGOING_RINGING) {
        console.log('[VoiceCallManager] Outgoing ringing timeout (no answer, 30s)');
        this._setState(CALL_STATE.NO_ANSWER);
        if (this.rtcBridge?.leave) {
          try {
            await this.rtcBridge.leave({
              callEpoch: epoch,
              ownerId: `call-${epoch}`,
              roomId: this.roomId
            });
          } catch { }
        }
        this._cleanupResources(epoch);
        this._scheduleIdleTransition(CALL_STATE.NO_ANSWER, 800, epoch);
      } else if (this.state === CALL_STATE.INCOMING_RINGING) {
        console.log('[VoiceCallManager] Incoming ringing timeout (no answer, 30s)');
        this._setState(CALL_STATE.NO_ANSWER);
        if (this.ringtone) this.ringtone.stop();
        this._cleanupResources(epoch);
        this._scheduleIdleTransition(CALL_STATE.NO_ANSWER, 800, epoch);
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
  _scheduleIdleTransition(fromState, delayMs = 800, epoch = this.callEpoch) {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._cleanupTimer = setTimeout(() => {
      this._cleanupTimer = null;
      if (this._isCurrentEpoch(epoch) && this.state === fromState) {
        this.roomId = null;
        this.callId = null;
        this.signalingEpoch = null;
        this._callIdIsSynthetic = false;
        this.peerName = '';
        this.peerPhone = '';
        this.error = null;
        this.isMuted = false;
        this.isCameraOff = false;
        this.isScreenSharing = false;
        this.isVideo = false;
        this.mode = 'voice';
        this._setState(CALL_STATE.IDLE);
        this._connectedEpoch = 0;
        this.callConnectedAt = null;
        this.durationSec = 0;
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
  startCallDurationTimer(epoch = this.callEpoch) {
    const ownsCall = this._isCurrentEpoch(epoch);
    if (!ownsCall || !this._connectedEpoch) {
      this._lifecycleLog('timer_initialization', {
        result: 'skipped',
        signalingCorrelation: 'not_applicable',
        ownsCall,
        hasConnectedEpoch: Boolean(this._connectedEpoch),
        timerAlreadyRunning: Boolean(this._timerInterval)
      });
      return;
    }
    if (this._timerInterval) {
      this._lifecycleLog('timer_initialization', {
        result: 'skipped_duplicate',
        signalingCorrelation: 'not_applicable',
        ownsCall: true,
        hasConnectedEpoch: true,
        timerAlreadyRunning: true
      });
      return; // Prevent duplicate timers
    }
    if (!this.callConnectedAt) {
      this.callConnectedAt = this._connectedEpoch;
    }
    this.durationSec = Math.max(0, Math.floor((Date.now() - this.callConnectedAt) / 1000));
    this.emit('timerTick', {
      durationSec: this.durationSec,
      formatted: this.getFormattedDuration()
    });

    this._lifecycleLog('timer_initialization', {
      result: 'started',
      signalingCorrelation: 'not_applicable',
      ownsCall: true,
      hasConnectedEpoch: true,
      timerAlreadyRunning: false
    });
    this._timerInterval = setInterval(() => {
      if (!this._isCurrentEpoch(epoch) || !this.callConnectedAt) return;
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
    if (this.callConnectedAt) {
      this.durationSec = Math.max(0, Math.floor((Date.now() - this.callConnectedAt) / 1000));
    } else {
      this.durationSec = 0;
    }
    this.emit('timerTick', {
      durationSec: this.durationSec,
      formatted: this.getFormattedDuration()
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
  _startIceDisconnectTimer(epoch = this.callEpoch) {
    if (this._iceDisconnectTimer) return;
    this._iceDisconnectTimer = setTimeout(async () => {
      this._iceDisconnectTimer = null;
      if (!this._isCurrentEpoch(epoch)) return;
      if (this.state === CALL_STATE.CONNECTED) {
        console.log('[VoiceCallManager] ICE disconnected timeout reached. Terminating call.');
        this._setState(CALL_STATE.ENDED);
        await this.endCall(false, epoch);
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
  _setupRtcListener(epoch = this.callEpoch) {
    if (this._unsubscribeRtcEvents) {
      this._unsubscribeRtcEvents();
      this._unsubscribeRtcEvents = null;
    }
    const subscribe = this.rtcBridge?.onEvent || this.rtcBridge?.onEvents;
    if (!subscribe) return;

    this._unsubscribeRtcEvents = subscribe.call(this.rtcBridge, (eventData) => {
      if (!this._isCurrentEpoch(epoch)) return;
      return this._handleRtcEvent(eventData, epoch);
    });
  }

  /**
   * Dispatches incoming RTC events.
   * @private
   */
  async _handleRtcEvent(event, epoch = this.callEpoch) {
    if (!event || typeof event !== 'object' || !this._isCurrentEpoch(epoch)) return;
    if (event.callEpoch != null && Number(event.callEpoch) !== epoch) return;
    const targetRoomId = event.roomId || this.roomId;

    // Reject stale room/call RTC events and adopt an authoritative identity when available.
    if (this.roomId && targetRoomId && String(targetRoomId).trim() !== String(this.roomId).trim()) {
      return;
    }
    if (event.callId != null && String(event.callId).trim()) {
      const incomingCallId = String(event.callId).trim();
      if (this.callId && !this._callIdIsSynthetic && incomingCallId !== this.callId) return;
      if (this._callIdIsSynthetic) {
        this.adoptAuthoritativeCallId(incomingCallId, {
          roomId: targetRoomId,
          ownershipEpoch: epoch,
          trustedCurrentTransport: true
        });
      }
    }

    switch (event.type) {
      case 'offer':
        await this._handleIncomingOffer(event.sdp, event.requestId, {
          isVideo: event.isVideo,
          callType: event.callType,
          callEpoch: epoch
        });
        break;

      case 'answer':
        await this._handleIncomingAnswer(event.sdp, epoch);
        break;

      case 'candidate':
        await this._handleIncomingCandidate(event.candidate, epoch);
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
        await this.handleRemoteCallEnded({
          roomId: targetRoomId,
          callId: event.callId,
          callEpoch: event.callEpoch,
          eventTimestamp: event.eventTimestamp ?? event.timestamp ?? event.createdAt ?? event.created_at,
          allowLegacy: true,
          trustedCurrentTransport: true
        });
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
          await this.endCall(false, epoch);
        }
        break;

      case 'error':
        if (this.ringtone) this.ringtone.stop();
        this.stopCallDurationTimer();
        this._clearIceDisconnectTimer();
        this._clearRingingTimer();
        if (this.state !== CALL_STATE.IDLE && this.state !== CALL_STATE.ENDED) {
          this._setState(CALL_STATE.FAILED, event.error || 'Signaling error');
          await this.endCall(false, epoch);
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
  async _acquireMedia(isVideo = false, epoch = this.callEpoch) {
    if (!this.mediaDevices?.getUserMedia) {
      throw new Error('Media access is not supported on this platform');
    }
    try {
      const stream = await this.mediaDevices.getUserMedia({
        audio: true,
        video: Boolean(isVideo)
      });
      if (!this._isCurrentEpoch(epoch)) {
        const tracks = stream?.getTracks ? stream.getTracks() : [];
        tracks.forEach((track) => track.stop?.());
        const staleError = new Error('Media acquisition completed for a stale call');
        staleError.code = 'STALE_CALL';
        throw staleError;
      }
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
          } catch (_) { }
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
          } catch (_) { }
        }
      }

      this._mediaLog('local_media_acquired', {
        audioTrackCount: audioTracks.length,
        videoTrackCount: videoTracks.length,
        tracks: [this._safeTrackSummary(this._localAudioTrack), this._safeTrackSummary(this._localVideoTrack)].filter(Boolean)
      });

      if (isVideo && this.localVideoElement) {
        this.localVideoElement.srcObject = this._localStream;
        this.localVideoElement.play?.().catch(() => { });
      }

      return stream;
    } catch (err) {
      if (err?.code === 'STALE_CALL') throw err;
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

  _playRemoteElement(element, kind, epoch = this.callEpoch, pc = this.peerConnection) {
    const isCurrentOwner = () => this._isCurrentEpoch(epoch) && (!pc || this.peerConnection === pc);
    if (!element || !this._remoteStream || !isCurrentOwner()) return;
    element.srcObject = this._remoteStream;
    this._mediaLogOnce(`remote-${kind}-attached`, 'remote_stream_attached', { kind });
    const playback = element.play?.();
    if (!playback || typeof playback.then !== 'function') return;
    playback.then(() => {
      if (isCurrentOwner()) {
        this._mediaLogOnce(`remote-${kind}-playing`, 'remote_playback_started', { kind });
      }
    }).catch((error) => {
      if (!isCurrentOwner()) return;
      const key = `remote-${kind}-playback-rejected`;
      if (this._playbackDiagnostics.has(key)) return;
      this._playbackDiagnostics.add(key);
      this._mediaLog('remote_playback_rejected', { kind, errorName: error?.name || 'Error' });
    });
  }

  _attachRemoteMediaElements(epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentPeer(epoch, pc) || !this._remoteStream) return;
    if ((this._remoteStream.getAudioTracks?.() || []).length > 0) {
      this._playRemoteElement(this.remoteAudioElement, 'audio', epoch, pc);
    }
    if ((this._remoteStream.getVideoTracks?.() || []).length > 0 && (this.isVideo || this.remoteScreenSharing || !this._isOriginalVideoCall)) {
      this._playRemoteElement(this.remoteVideoElement, 'video', epoch, pc);
    }
  }

  _stopStatsSampling() {
    if (this._statsTimer) {
      clearTimeout(this._statsTimer);
      this._statsTimer = null;
    }
  }

  _startStatsSampling(epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentPeer(epoch, pc) || typeof pc.getStats !== 'function' || this._remoteMediaConnected || this._statsTimer || this._statsSamples >= 3) return;
    const sample = async () => {
      this._statsTimer = null;
      if (!this._isCurrentPeer(epoch, pc) || this._remoteMediaConnected || this._statsSamples >= 3 ||
        (this.state !== CALL_STATE.CONNECTING && this.state !== CALL_STATE.OUTGOING_RINGING)) return;
      try {
        const report = await pc.getStats();
        if (!this._isCurrentPeer(epoch, pc) || this._remoteMediaConnected) return;
        const aggregate = {
          inboundAudioPackets: 0,
          inboundAudioBytes: 0,
          inboundVideoPackets: 0,
          inboundVideoBytes: 0,
          decodedFrames: 0,
          audioEnergy: 0,
          selectedPairState: null,
          localCandidateType: null,
          remoteCandidateType: null
        };
        const entries = [];
        report?.forEach?.((entry) => entries.push(entry));
        for (const entry of entries) {
          if (entry.type === 'inbound-rtp' && !entry.isRemote) {
            if (entry.kind === 'audio' || entry.mediaType === 'audio') {
              aggregate.inboundAudioPackets += Number(entry.packetsReceived || 0);
              aggregate.inboundAudioBytes += Number(entry.bytesReceived || 0);
              aggregate.audioEnergy += Number(entry.totalAudioEnergy || 0);
            } else if (entry.kind === 'video' || entry.mediaType === 'video') {
              aggregate.inboundVideoPackets += Number(entry.packetsReceived || 0);
              aggregate.inboundVideoBytes += Number(entry.bytesReceived || 0);
              aggregate.decodedFrames += Number(entry.framesDecoded || 0);
            }
          } else if (entry.type === 'candidate-pair' && (entry.selected || entry.nominated) && entry.state) {
            aggregate.selectedPairState = entry.state;
            const local = report.get?.(entry.localCandidateId);
            const remote = report.get?.(entry.remoteCandidateId);
            aggregate.localCandidateType = local?.candidateType || null;
            aggregate.remoteCandidateType = remote?.candidateType || null;
          }
        }
        this._statsSamples += 1;
        this._mediaLog('stats_sample', { sample: this._statsSamples, ...aggregate });
      } catch (error) {
        if (this._isCurrentPeer(epoch, pc)) {
          this._mediaLogOnce('stats-sample-failed', 'stats_sample_failed', { errorName: error?.name || 'Error' });
        }
      }
      if (this._isCurrentPeer(epoch, pc) && !this._remoteMediaConnected && this._statsSamples < 3) {
        this._statsTimer = setTimeout(sample, 10000);
        this._statsTimer?.unref?.();
      }
    };
    this._statsTimer = setTimeout(sample, 10000);
    this._statsTimer?.unref?.();
  }

  _noteRemoteMedia(event, epoch = this.callEpoch, pc = this.peerConnection) {
    const track = event?.track;
    const ownsEpoch = this._isCurrentEpoch(epoch);
    const ownsPeer = Boolean(pc) && this.peerConnection === pc;
    const isLive = Boolean(track && track.readyState !== 'ended');
    this._lifecycleLog('remote_track_observed', {
      result: ownsEpoch && ownsPeer && isLive ? 'current' : 'stale',
      signalingCorrelation: 'not_applicable',
      ownershipResult: ownsEpoch && ownsPeer ? 'current' : 'stale',
      trackKind: track?.kind || 'unknown',
      trackReadyState: track?.readyState || 'missing',
      ownsEpoch,
      ownsPeer,
      isLive
    });
    if (!track || !isLive || !ownsEpoch || !ownsPeer) return;
    if (!this._firstRemoteMediaAt) this._firstRemoteMediaAt = Date.now();
    this._earlyRemoteMedia = true;
    this._mediaLogOnce('first-remote-media', 'first_remote_media', {
      kind: track.kind || 'unknown',
      readyState: track.readyState || 'unknown'
    });
    const isAccepted = this._calleeAccepted || !this.sendSignal;
    if (this.state === CALL_STATE.OUTGOING_RINGING && !isAccepted) {
      this._lifecycleLog('acceptance_not_received', {
        result: 'transition_skipped',
        reason: 'acceptance_missing',
        signalingCorrelation: this.signalingEpoch === null ? 'expected_unavailable' : 'pending',
        ownershipResult: 'current',
        acceptanceRecorded: false,
        trackKind: track.kind || 'unknown',
        trackReadyState: track.readyState || 'unknown',
        ownsEpoch,
        ownsPeer
      });
    }
    if (this.state === CALL_STATE.OUTGOING_RINGING && isAccepted) {
      this._setState(CALL_STATE.CONNECTING);
    }
    if (this.state === CALL_STATE.CONNECTING && isAccepted && !this._remoteMediaConnected) {
      this._remoteMediaConnected = true;
      this._stopStatsSampling();
      this._markConnected(epoch, this._firstRemoteMediaAt);
    }
  }

  /**
   * Initializes RTCPeerConnection with ice_servers from OllaCore room-token response.
   * @private
   */
  _createPeerConnection(iceServers = [], epoch = this.callEpoch) {
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

    if (!this._isCurrentEpoch(epoch)) {
      throw new Error('Cannot create PeerConnection for a stale call');
    }
    const pc = new this.PeerConnectionClass({ iceServers: configs });
    this.peerConnection = pc;

    // 1. ICE Candidate generation -> send via RTC WebSocket
    pc.onicecandidate = (event) => {
      if (!this._isCurrentPeer(epoch, pc)) return;
      const candidate = event?.candidate;
      if (candidate && this.rtcBridge?.sendCandidate) {
        const candStr = candidate.candidate || candidate.sdp || '';
        const sdpMid = candidate.sdpMid || '';
        const sdpMLineIndex = candidate.sdpMLineIndex ?? 0;
        if (candStr) {
          this._candidateCounts.sent += 1;
          this._mediaLog('ice_candidate_sent', { count: this._candidateCounts.sent });
          Promise.resolve(this.rtcBridge.sendCandidate(candStr, sdpMid, sdpMLineIndex)).catch((error) => {
            if (this._isCurrentPeer(epoch, pc)) {
              this._mediaLogOnce('ice-candidate-send-failed', 'ice_candidate_send_failed', {
                errorName: error?.name || 'Error'
              });
            }
          });
        }
      }
    };
    pc.onicegatheringstatechange = () => {
      if (!this._isCurrentPeer(epoch, pc)) return;
      this._mediaLog('ice_gathering_state', { iceGatheringState: pc.iceGatheringState || 'unknown' });
    };

    // 2. Remote audio / video track reception
    pc.ontrack = (event) => {
      const ownsEpoch = this._isCurrentEpoch(epoch);
      const ownsPeer = this.peerConnection === pc;
      const track = event?.track;
      const isLive = Boolean(track && track.readyState !== 'ended');
      if (!ownsEpoch || !ownsPeer || !isLive) {
        this._lifecycleLog('remote_track_observed', {
          result: 'stale',
          signalingCorrelation: 'not_applicable',
          trackKind: track?.kind || 'unknown',
          trackReadyState: track?.readyState || 'missing',
          ownsEpoch,
          ownsPeer,
          isLive
        });
        return;
      }
      const incomingStream = event.streams?.[0] || null;
      if (!this._remoteStream) {
        this._remoteStream = typeof globalThis.MediaStream !== 'undefined'
          ? new globalThis.MediaStream()
          : incomingStream;
      }
      const incomingTracks = incomingStream?.getTracks?.() || [event.track];
      if (this._remoteStream && typeof this._remoteStream.addTrack === 'function') {
        for (const track of incomingTracks) {
          const existing = this._remoteStream.getTracks?.() || [];
          if (track && track.readyState !== 'ended' && !existing.includes(track)) {
            this._remoteStream.addTrack(track);
          }
        }
      }

      if (event.track && event.track.kind === 'video') {
        const remoteVideoTrack = event.track;
        const handleRemoteVideoEnded = () => {
          if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) return;
          if (this.remoteScreenSharing) {
            this.setRemoteScreenShareState(false, null);
          }
        };
        remoteVideoTrack.onended = handleRemoteVideoEnded;
        // Note: Do NOT bind handleRemoteVideoEnded to onmute. Transient network drops trigger
        // onmute events and must not falsely tear down active video feeds.
      }

      const hasRemoteVideo = Boolean(
        (event.track && event.track.kind === 'video') ||
        (this._remoteStream?.getVideoTracks && this._remoteStream.getVideoTracks().length > 0)
      );

      if (!this._isOriginalVideoCall && !this.isVideo && hasRemoteVideo && !this.remoteScreenSharing) {
        this.setRemoteScreenShareState(true, null);
      }

      if (!this._isOriginalVideoCall && !this.remoteScreenSharing && !this.isVideo && this.remoteVideoElement) {
        this.remoteVideoElement.srcObject = null;
      }
      this._attachRemoteMediaElements(epoch, pc);
      this.emit('remoteStream', { stream: this._remoteStream, track: event.track, kind: event.track?.kind });
      this._noteRemoteMedia(event, epoch, pc);
    };

    // 3. ICE / Connection state monitoring
    const handleStateChange = () => {
      if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) return;
      const iceState = pc.iceConnectionState;
      const connState = pc.connectionState;

      this._mediaLog('transport_state', {
        iceConnectionState: iceState || 'unknown',
        connectionState: connState || 'unknown'
      });

      if (iceState === 'connected' || iceState === 'completed' || connState === 'connected') {
        this._clearIceDisconnectTimer();
      } else if (iceState === 'failed' || connState === 'failed') {
        this._clearIceDisconnectTimer();
        if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING ||
          this.state === CALL_STATE.OUTGOING_RINGING || this.state === CALL_STATE.INCOMING_RINGING) {
          this._setState(CALL_STATE.FAILED, 'Call connection failed');
          this.endCall(false, epoch);
        }
      } else if (connState === 'closed') {
        this._clearIceDisconnectTimer();
        if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING ||
          this.state === CALL_STATE.OUTGOING_RINGING) {
          this._setState(CALL_STATE.ENDED);
          this.endCall(false, epoch);
        }
      } else if (iceState === 'disconnected' || connState === 'disconnected') {
        this._startIceDisconnectTimer(epoch);
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
  async _attachLocalTracks(epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentPeer(epoch, pc) || !this._localStream) return;
    const senders = pc.getSenders ? pc.getSenders() : [];
    const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];

    if (this._localAudioTrack) {
      const audioTc = transceivers.find(t => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio');
      if (audioTc && audioTc.sender?.track !== this._localAudioTrack && typeof audioTc.sender?.replaceTrack === 'function') {
        await audioTc.sender.replaceTrack(this._localAudioTrack);
        if (!this._isCurrentPeer(epoch, pc)) return;
        if (audioTc.direction !== 'sendrecv') audioTc.direction = 'sendrecv';
      } else if (!senders.some(s => s.track === this._localAudioTrack)) {
        pc.addTrack(this._localAudioTrack, this._localStream);
      }
    }

    if (this._localVideoTrack) {
      const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1'));
      if (videoTc && videoTc.sender?.track !== this._localVideoTrack && typeof videoTc.sender?.replaceTrack === 'function') {
        await videoTc.sender.replaceTrack(this._localVideoTrack);
        if (!this._isCurrentPeer(epoch, pc)) return;
        if (videoTc.direction !== 'sendrecv') videoTc.direction = 'sendrecv';
      } else if (!senders.some(s => s.track === this._localVideoTrack)) {
        pc.addTrack(this._localVideoTrack, this._localStream);
      }
    }

    const currentSenders = pc.getSenders ? pc.getSenders() : [];
    for (const sender of currentSenders) {
      if (!this._isCurrentPeer(epoch, pc)) return;
      if (sender?.track?.kind === 'video' && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
        const params = sender.getParameters();
        if (params?.encodings?.[0]) {
          params.encodings[0].maxBitrate = 10000000;
          params.encodings[0].maxFramerate = 60;
          params.encodings[0].networkPriority = 'high';
          try {
            await sender.setParameters(params);
          } catch (error) {
            if (this._isCurrentPeer(epoch, pc)) {
              this._mediaLogOnce('video-sender-parameters-failed', 'sender_parameters_failed', {
                kind: 'video',
                errorName: error?.name || 'Error'
              });
            }
          }
        }
      } else if (sender?.track?.kind === 'audio' && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
        const params = sender.getParameters();
        if (params?.encodings?.[0]) {
          params.encodings[0].maxBitrate = 128000;
          try {
            await sender.setParameters(params);
          } catch (error) {
            if (this._isCurrentPeer(epoch, pc)) {
              this._mediaLogOnce('audio-sender-parameters-failed', 'sender_parameters_failed', {
                kind: 'audio',
                errorName: error?.name || 'Error'
              });
            }
          }
        }
      }
    }
  }

  async _createAndSendLocalOfferNow({
    purpose = 'renegotiation',
    isVideo = this.isVideo,
    callType = this.mode,
    offerToReceiveVideo = this.isVideo
  } = {}, epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentPeer(epoch, pc)) return false;
    if (this._outstandingLocalOffer || (pc.signalingState && pc.signalingState !== 'stable')) {
      this._deferredLocalOffer = { purpose, isVideo, callType, offerToReceiveVideo };
      this._mediaLog('local_offer_deferred', {
        purpose,
        signalingState: pc.signalingState || 'unknown',
        hasOutstandingOffer: Boolean(this._outstandingLocalOffer)
      });
      return false;
    }

    await this._attachLocalTracks(epoch, pc);
    if (!this._isCurrentPeer(epoch, pc)) return false;
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: Boolean(offerToReceiveVideo)
    });
    if (!this._isCurrentPeer(epoch, pc)) return false;
    await pc.setLocalDescription(offer);
    if (!this._isCurrentPeer(epoch, pc)) return false;

    this._outstandingLocalOffer = {
      purpose,
      epoch,
      pc,
      createdAt: Date.now()
    };
    this._localPublicationPending = purpose === 'initial-publication';
    try {
      await this.rtcBridge.sendOffer(offer.sdp, {
        isVideo: Boolean(isVideo),
        callType: callType || (isVideo ? 'video' : 'voice')
      });
    } catch (error) {
      if (this._isCurrentPeer(epoch, pc)) {
        this._outstandingLocalOffer = null;
        this._localPublicationPending = false;
      }
      throw error;
    }
    if (!this._isCurrentPeer(epoch, pc)) return false;
    this._mediaLog('local_offer_sent', { purpose });
    this._startStatsSampling(epoch, pc);
    return true;
  }

  _createAndSendLocalOffer(options = {}, epoch = this.callEpoch, pc = this.peerConnection) {
    return this._serializeNegotiation(
      `local-offer:${options.purpose || 'renegotiation'}`,
      epoch,
      pc,
      () => this._createAndSendLocalOfferNow(options, epoch, pc)
    );
  }

  async _processQueuedSfuOffersNow(epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentPeer(epoch, pc) || this._outstandingLocalOffer || (pc.signalingState && pc.signalingState !== 'stable')) return;
    while (this._queuedSfuOffers.length > 0) {
      if (!this._isCurrentPeer(epoch, pc) || this._outstandingLocalOffer || (pc.signalingState && pc.signalingState !== 'stable')) return;
      const queued = this._queuedSfuOffers.shift();
      const desc = new this.SessionDescriptionClass({ type: 'offer', sdp: queued.sdp });
      await pc.setRemoteDescription(desc);
      if (!this._isCurrentPeer(epoch, pc)) return;
      await this._drainQueuedCandidates(epoch, pc);
      if (!this._isCurrentPeer(epoch, pc)) return;
      await this._attachLocalTracks(epoch, pc);
      if (!this._isCurrentPeer(epoch, pc)) return;
      const answer = await pc.createAnswer();
      if (!this._isCurrentPeer(epoch, pc)) return;
      await pc.setLocalDescription(answer);
      if (!this._isCurrentPeer(epoch, pc)) return;
      await this.rtcBridge.sendAnswer(answer.sdp, queued.requestId);
      if (!this._isCurrentPeer(epoch, pc)) return;
      this._mediaLog('sfu_offer_answered', {
        queuedRemaining: this._queuedSfuOffers.length,
        signalingState: pc.signalingState || 'unknown'
      });
      if (queued.isRemoteDeparture) {
        await this.handleRemoteCallEnded({
          roomId: this.roomId,
          callId: this.callId,
          callEpoch: epoch,
          trustedCurrentTransport: true
        });
        return;
      }
    }
  }

  async _resumeDeferredNegotiationNow(epoch = this.callEpoch, pc = this.peerConnection) {
    await this._processQueuedSfuOffersNow(epoch, pc);
    if (!this._isCurrentPeer(epoch, pc) || this._outstandingLocalOffer || (pc.signalingState && pc.signalingState !== 'stable')) return;
    const deferred = this._deferredLocalOffer;
    this._deferredLocalOffer = null;
    if (deferred) {
      await this._createAndSendLocalOfferNow(deferred, epoch, pc);
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
  async _drainQueuedCandidates(epoch = this.callEpoch, pc = this.peerConnection) {
    if (!this._isCurrentEpoch(epoch) || !pc || this.peerConnection !== pc || !pc.remoteDescription) return;
    while (this._pendingIceCandidates.length > 0) {
      if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) return;
      const rawCand = this._pendingIceCandidates.shift();
      try {
        const iceCand = this._toIceCandidate(rawCand);
        if (iceCand) {
          await pc.addIceCandidate(iceCand);
        }
      } catch (err) {
        if (this._isCurrentEpoch(epoch) && this.peerConnection === pc) {
          console.warn('[VoiceCallManager] Error draining ICE candidate:', err);
        }
      }
    }
  }

  /**
   * Transitions to CONNECTED from a live current-call remote track only.
   * The first remote-media timestamp is immutable for the lifetime of the call.
   * @private
   */
  _markConnected(epoch = this.callEpoch, connectedAt = this._firstRemoteMediaAt) {
    const ownsEpoch = this._isCurrentEpoch(epoch);
    const stateAllowsConnection = this.state === CALL_STATE.CONNECTING;
    this._lifecycleLog('mark_connected', {
      result: ownsEpoch && stateAllowsConnection ? 'invoked' : 'skipped',
      signalingCorrelation: 'not_applicable',
      ownershipResult: ownsEpoch ? 'current' : 'stale',
      ownsEpoch,
      ownsPeer: Boolean(this.peerConnection),
      stateAllowsConnection,
      hasRemoteMediaTimestamp: Boolean(connectedAt)
    });
    if (!ownsEpoch || !stateAllowsConnection) return;
    if (!this._connectedEpoch) {
      this._connectedEpoch = Number(connectedAt) || Date.now();
    }
    this._remoteMediaConnected = true;
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    console.log(`[VoiceCallManager] CALL_CONNECTED (${this.mode})`, this._identityLog());
    this._setState(CALL_STATE.CONNECTED);
    this.startCallDurationTimer(epoch);
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
    if (this.state !== CALL_STATE.IDLE && !this.isEnded) {
      throw new Error(`Cannot start call: existing call active in state "${this.state}"`);
    }
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    this.roomId = roomId.trim();
    const epoch = this._beginCallInstance();
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
    this._pendingIceCandidates = [];
    this._inviteSent = false;
    this.stopCallDurationTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }

    console.log(`[VoiceCallManager] CALL_STARTED (caller ${this.mode})`, this._identityLog());
    this._setState(CALL_STATE.OUTGOING_RINGING);
    this._startRingingTimer(30000, epoch);
    this._setupRtcListener(epoch);

    try {
      // 1. Acquire media (audio for voice, audio + video for video)
      await this._acquireMedia(this.isVideo, epoch);
      if (!this._isCurrentEpoch(epoch)) return;

      // 2. Connect RTC WebSocket and fetch iceServers
      const rtcRes = await this._connectRtcForEpoch(epoch);
      if (!this._isCurrentEpoch(epoch)) return;
      if (!rtcRes?.ok) {
        throw new Error(rtcRes?.error || 'Failed to connect RTC WebSocket');
      }
      console.log('[VoiceCallManager] RTC_CONNECTED', this._identityLog());
      const iceServers = rtcRes.iceServers || [];

      // 3. Create the single PeerConnection and publish local media through serialized negotiation.
      const pc = this._createPeerConnection(iceServers, epoch);
      await this._createAndSendLocalOffer({
        purpose: 'initial-publication',
        isVideo: this.isVideo,
        callType: this.mode,
        offerToReceiveVideo: this.isVideo
      }, epoch, pc);
      if (!this._isCurrentPeer(epoch, pc)) return;

      // 4. Transmit invite signal only after the local publication offer is sent.
      if (this.sendSignal && this.roomId) {
        const inviteResult = await this.sendSignal(this._signalPayload('invite', {
          callType: this.mode,
          isVideo: this.isVideo
        }));
        if (!this._isCurrentPeer(epoch, pc)) return;
        if (inviteResult && typeof inviteResult === 'object' && inviteResult.ok !== true) {
          const inviteError = new Error('Call invitation dispatch failed');
          inviteError.code = inviteResult.code || 'call_invite_send_failed';
          throw inviteError;
        }
        this._inviteSent = true;
      }
    } catch (err) {
      if (!this._isCurrentEpoch(epoch)) return;
      if (this._inviteSent && this.sendSignal && this.roomId) {
        try {
          await this.sendSignal(this._signalPayload('cancel'));
        } catch (_) { }
      }
      this._setState(CALL_STATE.FAILED, err.message || 'Call failed');
      await this.endCall(false, epoch);
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
  handleIncomingCall({ roomId, callId, callEpoch, initiator, isVideo = false, callType = 'voice', peerName = '', peerPhone = '', ...options } = {}) {
    // If already in a call, ignore incoming call to prevent duplicate connections
    if (this.state !== CALL_STATE.IDLE && !this.isEnded) {
      return;
    }
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (!roomId) return;

    this.stopCallDurationTimer();
    this.roomId = String(roomId).trim();
    const hasAuthoritativeCallId = callId != null && String(callId).trim() && String(callId).trim() !== this.roomId;
    const epoch = this._beginCallInstance({
      callId: hasAuthoritativeCallId ? String(callId).trim() : this.roomId,
      syntheticCallId: !hasAuthoritativeCallId,
      // Unknown epoch (e.g. server call.started has none) must stay null; defaulting to the
      // local counter makes our accept carry an epoch the caller never issued -> rejected as stale.
      signalingEpoch: callEpoch ?? null
    });
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
    this._pendingIceCandidates = [];
    this._pendingOffer = null;

    console.log(`[VoiceCallManager] CALL_STARTED (callee incoming ${this.mode})`, this._identityLog());
    this._setState(CALL_STATE.INCOMING_RINGING);
    this._startRingingTimer(30000, epoch);
    if (this.ringtone) {
      this.ringtone.start();
    }

    // Set up RTC listener synchronously to receive early offer metadata and remote cancel
    this._setupRtcListener(epoch);
    if (this.roomId && this.rtcBridge?.connect) {
      this._connectRtcForEpoch(epoch).catch((err) => {
        if (this._isCurrentEpoch(epoch)) {
          console.warn('[VoiceCallManager] Non-fatal: RTC signaling connect while ringing failed:', err?.message || err, this._identityLog());
        }
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

    const epoch = this.callEpoch;
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
    this._setupRtcListener(epoch);

    if (this.sendSignal && this.roomId) {
      try {
        this.sendSignal(this._signalPayload('accept', {
          callType: this.mode,
          isVideo: this.isVideo
        }));
      } catch (_) { }
    }

    try {
      // 1. Acquire media (audio for voice, audio + video for video)
      await this._acquireMedia(this.isVideo, epoch);
      if (!this._isCurrentEpoch(epoch)) return;

      // 2. Reuse the single incoming preconnect promise for this call owner.
      const rtcRes = await this._connectRtcForEpoch(epoch);
      if (!this._isCurrentEpoch(epoch)) return;
      if (!rtcRes?.ok) {
        throw new Error(rtcRes?.error || 'Failed to connect RTC WebSocket');
      }
      console.log('[VoiceCallManager] RTC_CONNECTED', this._identityLog());
      const iceServers = rtcRes.iceServers || [];

      // 3. Every participant publishes its own local media offer after acceptance.
      const pc = this._createPeerConnection(iceServers, epoch);
      this._pendingOffer = null;
      await this._createAndSendLocalOffer({
        purpose: 'initial-publication',
        isVideo: this.isVideo,
        callType: this.mode,
        offerToReceiveVideo: this.isVideo
      }, epoch, pc);
      if (!this._isCurrentPeer(epoch, pc)) return;
      this._startStatsSampling(epoch, pc);
      if (this._earlyRemoteMedia && !this._remoteMediaConnected) {
        this._remoteMediaConnected = true;
        this._markConnected(epoch, this._firstRemoteMediaAt);
      }
    } catch (err) {
      if (!this._isCurrentEpoch(epoch)) return;
      this._setState(CALL_STATE.FAILED, err.message || 'Failed to accept call');
      await this.endCall(false, epoch);
      throw err;
    }
  }

  /**
   * Declines an incoming ringing call without joining media.
   * Stops ringtone immediately.
   * Sends minimal RTC {"cmd":"leave"} to inform backend/caller of decline, then tears down RTC cleanly.
   */
  async declineCall() {
    const epoch = this.callEpoch;
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.state !== CALL_STATE.INCOMING_RINGING) return;

    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();

    const targetRoomId = this.roomId;
    console.log('[VoiceCallManager] CALL_DECLINED (callee)', { hasRoomId: Boolean(targetRoomId) });
    this._setState(CALL_STATE.DECLINED);

    if (this.sendSignal && targetRoomId) {
      try {
        this.sendSignal(this._signalPayload('decline'));
      } catch (_) { }
    }

    // Send minimal RTC leave to notify backend/caller without joining audio/video or active UI
    if (targetRoomId && this.rtcBridge?.leave) {
      try {
        await this._connectRtcForEpoch(epoch);
        if (!this._isCurrentEpoch(epoch)) return;
        await this.rtcBridge.leave({
          callEpoch: epoch,
          ownerId: `call-${epoch}`,
          roomId: this.roomId
        });
        await new Promise((r) => setTimeout(r, 150));
      } catch (err) {
        console.warn('[VoiceCallManager] Error sending decline leave over RTC:', err?.message || err);
      }
    }

    this._cleanupResources(epoch);
    this._scheduleIdleTransition(CALL_STATE.DECLINED, 800, epoch);
  }

  /**
   * Handles remote call termination event announced over RTC or Chat WebSocket.
   * Distinguishes Caller Cancellation, Callee Decline, and Connected Remote Departure.
   *
   * @param {object} [params]
   * @param {string} [params.roomId]
   */
  async handleRemoteCallEnded({
    roomId,
    callId,
    callEpoch,
    eventTimestamp,
    allowLegacy = true,
    trustedCurrentTransport = false
  } = {}) {
    if (this.roomId && roomId && String(this.roomId).trim() !== String(roomId).trim()) return;
    const correlation = trustedCurrentTransport
      ? {
        matches: callEpoch == null || Number(callEpoch) === this.callEpoch,
        result: callEpoch == null ? 'trusted_transport' : (Number(callEpoch) === this.callEpoch ? 'ownership_matched' : 'ownership_stale')
      }
      : this._signalingCorrelation(callEpoch);
    if (!correlation.matches) {
      this._lifecycleLog('remote_end_signal', {
        result: 'rejected',
        signalingCorrelation: correlation.result,
        trustedCurrentTransport,
        ownsEpoch: trustedCurrentTransport ? Number(callEpoch) === this.callEpoch : true
      });
      return;
    }
    const hasCallId = callId != null && String(callId).trim();
    const hasCallEpoch = callEpoch != null;
    if (hasCallId) {
      const incomingCallId = String(callId).trim();
      if (this.callId && !this._callIdIsSynthetic && incomingCallId !== this.callId) return;
      if (this._callIdIsSynthetic) {
        this.adoptAuthoritativeCallId(incomingCallId, trustedCurrentTransport
          ? { roomId, ownershipEpoch: callEpoch, trustedCurrentTransport: true }
          : { roomId, signalingEpoch: callEpoch });
      }
    } else {
      if (!allowLegacy || !roomId || !this.roomId) return;

      // A room-only event cannot distinguish consecutive calls in the same room. Accept it
      // only when it is correlated by an epoch-bound RTC listener, has a source timestamp
      // from the current call, or this is the first call instance (there is no prior call
      // from which such an event could be delayed).
      if (!hasCallEpoch && !trustedCurrentTransport) {
        const parsedTimestamp = eventTimestamp == null ? NaN : Date.parse(eventTimestamp);
        const numericTimestamp = Number.isFinite(Number(eventTimestamp))
          ? Number(eventTimestamp)
          : parsedTimestamp;
        const isCurrentTimestamp = Number.isFinite(numericTimestamp) && numericTimestamp >= this._callStartEpoch;
        const cannotBeFromPriorCall = this.callEpoch === 1;
        if (!isCurrentTimestamp && !cannotBeFromPriorCall) return;
      }
    }
    const epoch = this.callEpoch;
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();

    if (this.state === CALL_STATE.IDLE || this.isEnded) {
      return;
    }

    this._lifecycleLog('remote_end_signal', {
      result: 'accepted',
      signalingCorrelation: correlation.result,
      trustedCurrentTransport,
      ownsEpoch: true
    });
    console.log(`[VoiceCallManager] Remote call ended while in state "${this.state}"`, this._identityLog());

    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      // Caller receives decline from callee
      this._setState(CALL_STATE.REMOTE_DECLINED);
      this._cleanupResources(epoch);
      this._scheduleIdleTransition(CALL_STATE.REMOTE_DECLINED, 800, epoch);
      return;
    }

    if (this.state === CALL_STATE.INCOMING_RINGING) {
      // Callee receives cancellation from caller
      this._setState(CALL_STATE.REMOTE_CANCELLED);
      this._cleanupResources(epoch);
      this._scheduleIdleTransition(CALL_STATE.REMOTE_CANCELLED, 800, epoch);
      return;
    }

    if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING) {
      // Connected remote participant left: CONNECTED -> REMOTE_ENDED -> ENDED -> IDLE
      this._setState(CALL_STATE.REMOTE_ENDED);
      this._setState(CALL_STATE.ENDED);
      this._cleanupResources(epoch);
      this._scheduleIdleTransition(CALL_STATE.ENDED, 800, epoch);
      return;
    }

    await this.endCall(false, epoch);
  }

  /**
   * Callee processes incoming offer from caller or SFU renegotiation.
   * @private
   */
  async _handleIncomingOffer(sdp, requestId = 0, options = {}) {
    const epoch = options.callEpoch ?? this.callEpoch;
    if (!this._isCurrentEpoch(epoch)) return;
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
        const preservedOffer = { sdp: sdpString, requestId, options, isRemoteDeparture: false };
        this._pendingOffer = preservedOffer;
        this._queuedSfuOffers.push(preservedOffer);
        return;
      }

      if (!this.peerConnection) {
        const preservedOffer = { sdp: sdpString, requestId, options, isRemoteDeparture: false };
        this._pendingOffer = preservedOffer;
        this._queuedSfuOffers.push(preservedOffer);
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

      const isRemoteDeparture = (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING) &&
        hasInactiveRemoteMedia &&
        !hasActiveRemoteMedia;

      const pc = this.peerConnection;
      this._queuedSfuOffers.push({
        sdp: sdpString,
        requestId,
        options,
        isRemoteDeparture
      });
      this._mediaLog('sfu_offer_queued', {
        queuedCount: this._queuedSfuOffers.length,
        signalingState: pc.signalingState || 'unknown',
        hasOutstandingOffer: Boolean(this._outstandingLocalOffer)
      });
      await this._serializeNegotiation('sfu-offer', epoch, pc, async () => {
        if (!this._isCurrentPeer(epoch, pc)) return;
        await this._processQueuedSfuOffersNow(epoch, pc);
      });
    } catch (err) {
      if (!this._isCurrentEpoch(epoch)) return;
      console.error('[VoiceCallManager] Failed to process offer:', err);
      this._setState(CALL_STATE.FAILED, 'Failed to establish call media');
      await this.endCall(false, epoch);
    }
  }

  /**
   * Handles explicit acceptance notification from callee.
   * @param {object} params
   * @param {string} [params.roomId]
   */
  handleCallAccepted({ roomId, callId, callEpoch } = {}) {
    const roomMatches = !(roomId && this.roomId && String(roomId).trim() !== String(this.roomId).trim());
    const correlation = this._signalingCorrelation(callEpoch);
    if (!roomMatches || !correlation.matches) {
      this._lifecycleLog('acceptance_received', {
        result: 'rejected',
        signalingCorrelation: roomMatches ? correlation.result : 'room_mismatch',
        identityCorrelation: 'not_evaluated',
        acceptanceRecorded: false,
        roomMatches,
        ownsEpoch: true,
        ownsPeer: Boolean(this.peerConnection)
      });
      return;
    }
    if (callId && !this.adoptAuthoritativeCallId(callId, { roomId, signalingEpoch: callEpoch })) {
      if (this.callId && !this._callIdIsSynthetic && String(callId).trim() !== this.callId) {
        this._lifecycleLog('acceptance_received', {
          result: 'rejected',
          signalingCorrelation: 'call_identity_conflict',
          identityCorrelation: 'authoritative_conflict',
          acceptanceRecorded: false,
          roomMatches: true,
          ownsEpoch: true,
          ownsPeer: Boolean(this.peerConnection)
        });
        return;
      }
    }
    const epoch = this.callEpoch;
    this._lifecycleLog('acceptance_received', {
      result: 'accepted',
      signalingCorrelation: correlation.result,
      identityCorrelation: callId ? 'authoritative_matched_or_adopted' : 'not_provided',
      acceptanceRecorded: true,
      roomMatches: true,
      ownsEpoch: true,
      ownsPeer: Boolean(this.peerConnection)
    });
    console.log('[VoiceCallManager] Callee accepted call invitation', this._identityLog());
    this._calleeAccepted = true;
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      this._setState(CALL_STATE.CONNECTING);
    }
    const pc = this.peerConnection;
    if (pc) {
      this._startStatsSampling(epoch, pc);
    }
    if (this.state === CALL_STATE.CONNECTING && this._earlyRemoteMedia && !this._remoteMediaConnected) {
      this._remoteMediaConnected = true;
      this._markConnected(epoch, this._firstRemoteMediaAt);
    }
  }

  /**
   * Caller processes incoming answer from callee or SFU.
   * @private
   */
  async _handleIncomingAnswer(sdp, epoch = this.callEpoch) {
    if (!this.peerConnection || !this._isCurrentEpoch(epoch)) return;
    const pc = this.peerConnection;
    const transaction = this._outstandingLocalOffer;
    if (!transaction || transaction.epoch !== epoch || transaction.pc !== pc) {
      this._mediaLog('unexpected_answer_ignored', {
        signalingState: pc.signalingState || 'unknown'
      });
      return;
    }

    try {
      await this._serializeNegotiation('remote-answer', epoch, pc, async () => {
        if (!this._isCurrentPeer(epoch, pc) || this._outstandingLocalOffer !== transaction) return;
        if (pc.signalingState && pc.signalingState !== 'have-local-offer') {
          this._mediaLog('unexpected_answer_ignored', {
            signalingState: pc.signalingState,
            purpose: transaction.purpose
          });
          this._outstandingLocalOffer = null;
          this._localPublicationPending = false;
          await this._resumeDeferredNegotiationNow(epoch, pc);
          return;
        }
        const desc = new this.SessionDescriptionClass({ type: 'answer', sdp });
        await pc.setRemoteDescription(desc);
        if (!this._isCurrentPeer(epoch, pc)) return;
        this._outstandingLocalOffer = null;
        this._localPublicationPending = false;
        this._mediaLog('remote_answer_applied', { purpose: transaction.purpose });
        await this._drainQueuedCandidates(epoch, pc);
        if (!this._isCurrentPeer(epoch, pc)) return;
        await this._resumeDeferredNegotiationNow(epoch, pc);
      });
    } catch (error) {
      if (!this._isCurrentPeer(epoch, pc)) return;
      this._mediaLog('remote_answer_rejected', {
        purpose: transaction.purpose,
        errorName: error?.name || 'Error'
      });
      if (this._outstandingLocalOffer === transaction) {
        this._outstandingLocalOffer = null;
        this._localPublicationPending = false;
      }
    }
  }

  /**
   * Processes remote ICE candidate, queuing if remote description is not yet set.
   * @private
   */
  async _handleIncomingCandidate(candidateObj, epoch = this.callEpoch) {
    if (!candidateObj || !this._isCurrentEpoch(epoch)) return;
    const pc = this.peerConnection;
    this._candidateCounts.received += 1;
    this._mediaLog('ice_candidate_received', { count: this._candidateCounts.received });
    if (pc?.remoteDescription?.type) {
      try {
        const iceCand = this._toIceCandidate(candidateObj);
        if (iceCand) {
          await pc.addIceCandidate(iceCand);
          if (!this._isCurrentPeer(epoch, pc)) return;
        }
      } catch (error) {
        if (this._isCurrentPeer(epoch, pc)) {
          this._mediaLogOnce('ice-candidate-add-failed', 'ice_candidate_add_failed', {
            errorName: error?.name || 'Error'
          });
        }
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
    const epoch = this.callEpoch;
    const pc = this.peerConnection;
    if (!this._isCurrentEpoch(epoch) || !pc) return false;
    if (this._localVideoTrack) {
      this.isCameraOff = false;
      this._localVideoTrack.enabled = true;
      this.isVideo = true;
      this.mode = 'video';
      if (pc) {
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        const videoTc = transceivers.find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1')));
        if (videoTc) {
          if (videoTc.sender && typeof videoTc.sender.replaceTrack === 'function') {
            await videoTc.sender.replaceTrack(this._localVideoTrack).catch(() => { });
            if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) return false;
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
    if (pc && this.mediaDevices?.getUserMedia) {
      try {
        const stream = await this.mediaDevices.getUserMedia({ audio: false, video: true });
        if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) {
          stream?.getTracks?.().forEach(track => track.stop?.());
          return false;
        }
        const videoTrack = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
        if (videoTrack) {
          if (typeof videoTrack.applyConstraints === 'function') {
            try {
              await videoTrack.applyConstraints({
                width: { ideal: 3840, max: 3840 },
                height: { ideal: 2160, max: 2160 },
                frameRate: { ideal: 30, max: 60 }
              });
            } catch (_) { }
          }
          if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) {
            stream?.getTracks?.().forEach(track => track.stop?.());
            return false;
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
          const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
          const videoTc = transceivers.find(t => (t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video' || (!t.sender?.track && t.mid === '1')));
          if (videoTc) {
            if (videoTc.sender && typeof videoTc.sender.replaceTrack === 'function') {
              await videoTc.sender.replaceTrack(videoTrack).catch(() => { });
              if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc) {
                videoTrack.stop?.();
                return false;
              }
            }
            if (videoTc.direction !== 'sendrecv') {
              videoTc.direction = 'sendrecv';
            }
          } else {
            await this._createAndSendLocalOffer({
              purpose: 'camera-enabled',
              isVideo: true,
              callType: 'video',
              offerToReceiveVideo: true
            }, epoch, pc);
            if (!this._isCurrentPeer(epoch, pc)) return false;
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
   * Replaces outgoing camera video on the existing sender and serializes SDP renegotiation when required.
   * Keeps microphone audio completely untouched.
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
    const epoch = this.callEpoch;
    const pc = this.peerConnection;
    if (!this._isCurrentEpoch(epoch) || !pc) {
      throw new Error('Screen sharing owner is no longer active');
    }
    const isCurrentOwner = () => this._isCurrentEpoch(epoch) && this.peerConnection === pc;
    const priorVideoTrack = this._localVideoTrack;
    let screenSender = null;

    try {
      // 1. Preserve current camera state and track
      this._savedCameraTrack = priorVideoTrack;
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
      if (!isCurrentOwner()) {
        displayStream?.getTracks?.().forEach(track => track.stop?.());
        return false;
      }

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
      // The centralized offer helper re-attaches this authoritative track before
      // creating SDP, so update it before any serialized renegotiation begins.
      this._localVideoTrack = screenTrack;

      // 3. Find existing video RTCRtpSender or transceiver
      let videoSender = null;
      if (pc.getSenders) {
        const senders = pc.getSenders() || [];
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');
        videoSender = videoTc?.sender || senders.find((s) => s.track && s.track.kind === 'video');
        if (!videoSender && this._savedCameraTrack) {
          videoSender = senders.find((s) => s.track === this._savedCameraTrack);
        }
        if (!videoSender && this._screenVideoSender) {
          videoSender = senders.find((s) => s === this._screenVideoSender);
        }
      }
      screenSender = videoSender;

      if (videoSender && typeof videoSender.replaceTrack === 'function') {
        this._screenVideoSender = videoSender;
        await videoSender.replaceTrack(screenTrack);
        if (!isCurrentOwner()) {
          screenTrack.stop?.();
          return false;
        }
        if (typeof videoSender.generateKeyFrame === 'function') {
          try {
            await videoSender.generateKeyFrame();
          } catch (err) {
            console.warn('[VoiceCallManager] generateKeyFrame non-fatal:', err?.message || err);
          }
          if (!isCurrentOwner()) return false;
        }

        // If restarting screen share in an audio call, reactivate video through serialized negotiation.
        if (!this._isOriginalVideoCall && pc.createOffer && this.rtcBridge?.sendOffer) {
          try {
            await this._createAndSendLocalOffer({
              purpose: 'screen-share-restarted',
              isVideo: true,
              callType: 'video',
              offerToReceiveVideo: true
            }, epoch, pc);
            if (!isCurrentOwner()) return false;
          } catch (renegErr) {
            console.warn('[VoiceCallManager] SDP renegotiation on screenshare restart non-fatal:', renegErr);
          }
        }
      } else if (pc) {
        // Audio call flow (first time): add screen video track and renegotiate SDP with OllaCore / Janus SFU
        if (typeof pc.addTrack === 'function') {
          videoSender = pc.addTrack(screenTrack, displayStream);
        } else if (typeof pc.addTransceiver === 'function') {
          const tx = pc.addTransceiver(screenTrack, {
            direction: 'sendrecv',
            streams: [displayStream]
          });
          videoSender = tx?.sender || null;
        }
        screenSender = videoSender;
        this._screenVideoSender = videoSender;

        // Perform OllaCore WebRTC SDP renegotiation for audio -> video/screen upgrade.
        if (pc.createOffer && this.rtcBridge?.sendOffer) {
          await this._createAndSendLocalOffer({
            purpose: 'screen-share-started',
            isVideo: true,
            callType: 'video',
            offerToReceiveVideo: true
          }, epoch, pc);
          if (!isCurrentOwner()) return false;
        }

        if (videoSender && typeof videoSender.generateKeyFrame === 'function') {
          try {
            await videoSender.generateKeyFrame();
          } catch (_) { }
          if (!isCurrentOwner()) return false;
        }
      }

      if (!isCurrentOwner()) {
        screenTrack.stop?.();
        return false;
      }
      this.isScreenSharing = true;

      // 4. Update local video preview to display shared screen
      if (this.localVideoElement) {
        this.localVideoElement.srcObject = displayStream;
        this.localVideoElement.play?.().catch(() => { });
      }

      // 5. Handle OS-level termination (user closes window, stops capture via OS bar, etc.)
      screenTrack.onended = () => {
        if (!isCurrentOwner() || this._screenTrack !== screenTrack) return;
        console.log('[VoiceCallManager] Screen capture track ended at OS/window level');
        this.stopScreenShare(epoch, screenTrack).catch((err) => {
          console.warn('[VoiceCallManager] Error restoring camera after OS track end:', err);
        });
      };

      this.emit('screenShareChange', { isScreenSharing: true, sourceId });
      return true;
    } catch (err) {
      if (!isCurrentOwner()) return false;
      console.error('[VoiceCallManager] Failed to start screen sharing:', err);
      if (screenSender && typeof screenSender.replaceTrack === 'function') {
        try {
          await screenSender.replaceTrack(priorVideoTrack || null);
        } catch (rollbackError) {
          this._mediaLogOnce('screen-share-rollback-failed', 'sender_track_rollback_failed', {
            kind: 'video',
            errorName: rollbackError?.name || 'Error'
          });
        }
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
        this._screenTrack = null;
      }
      this._screenVideoSender = null;
      this.isScreenSharing = false;
      this._localVideoTrack = priorVideoTrack;
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
  async stopScreenShare(epoch = this.callEpoch, expectedScreenTrack = this._screenTrack) {
    if (!this._isCurrentEpoch(epoch)) return false;
    if (expectedScreenTrack && this._screenTrack !== expectedScreenTrack) return false;
    const pc = this.peerConnection;
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
      if (pc?.getSenders) {
        const senders = pc.getSenders() || [];
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        const videoTc = transceivers.find(t => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video');
        const videoSender = videoTc?.sender || senders.find((s) => (s.track && s.track.kind === 'video') || s.track === this._screenTrack || (cameraTrack && s.track === cameraTrack) || s === this._screenVideoSender);
        if (videoSender && typeof videoSender.replaceTrack === 'function') {
          await videoSender.replaceTrack(cameraTrack || null);
          if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc || this._screenTrack !== expectedScreenTrack) return false;
          if (cameraTrack && typeof videoSender.generateKeyFrame === 'function') {
            try {
              await videoSender.generateKeyFrame();
            } catch (_) { }
            if (!this._isCurrentEpoch(epoch) || this.peerConnection !== pc || this._screenTrack !== expectedScreenTrack) return false;
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

      // 6. If original call was audio-only, renegotiate back to audio through the same serializer.
      if (!this._isOriginalVideoCall && !this.isVideo && pc?.createOffer && this.rtcBridge?.sendOffer) {
        try {
          await this._createAndSendLocalOffer({
            purpose: 'screen-share-stopped',
            isVideo: false,
            callType: 'voice',
            offerToReceiveVideo: false
          }, epoch, pc);
          if (!this._isCurrentPeer(epoch, pc)) return false;
        } catch (renegErr) {
          console.warn('[VoiceCallManager] SDP renegotiation after screenshare stop non-fatal:', renegErr);
        }
      }

      this.emit('screenShareChange', { isScreenSharing: false });
      this.emit('cameraChange', { isCameraOff: this.isCameraOff });
      return true;
    } finally {
      if (this._isCurrentEpoch(epoch)) {
        this._isStoppingScreenShare = false;
      }
    }
  }

  /**
   * Cleans up local media streams, tracks, PeerConnection, and sockets.
   * @private
   */
  _cleanupResources(epoch = this.callEpoch) {
    if (!this._isCurrentEpoch(epoch)) return false;
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
    this._stopStatsSampling();
    if (this.peerConnection) {
      try {
        this.peerConnection.onicecandidate = null;
        this.peerConnection.onicegatheringstatechange = null;
        this.peerConnection.ontrack = null;
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
    this._resetMediaLifecycleState();
    // Terminal state listeners run synchronously before teardown and capture
    // these values for history; clear them now to avoid stale post-call state.
    this._connectedEpoch = 0;
    this.callConnectedAt = null;
    this.durationSec = 0;
    if (this.participants) {
      this.participants.clear();
    }

    // 4. Disconnect RTC WebSocket
    if (this.rtcBridge?.disconnect) {
      try {
        this.rtcBridge.disconnect({
          callEpoch: epoch,
          ownerId: `call-${epoch}`,
          roomId: this.roomId
        });
      } catch { }
    }
    this._rtcConnectPromise = null;
    this._rtcConnectEpoch = 0;

    if (this._unsubscribeRtcEvents) {
      this._unsubscribeRtcEvents();
      this._unsubscribeRtcEvents = null;
    }
    return true;
  }

  /**
   * Terminates active call, tears down WebRTC and RTC signaling, and stops all media tracks.
   * Handles caller cancellation, local hangup, and failure teardowns.
   *
   * @param {boolean} [sendLeave=true] - Whether to send RTC "leave" frame
   */
  async endCall(sendLeave = true, epoch = this.callEpoch) {
    if (!this._isCurrentEpoch(epoch)) return;
    this._clearIceDisconnectTimer();
    this._clearRingingTimer();
    if (this.ringtone) {
      this.ringtone.stop();
    }
    this.stopCallDurationTimer();
    if (this.state === CALL_STATE.IDLE) {
      this._cleanupResources(epoch);
      return;
    }
    if (this.isEnded) {
      const terminalState = this.state;
      this._cleanupResources(epoch);
      this._scheduleIdleTransition(terminalState, 800, epoch);
      return;
    }

    // Caller cancelling before acceptance
    if (this.state === CALL_STATE.OUTGOING_RINGING) {
      console.log(`[VoiceCallManager] CALL_CANCELLED (caller ${this.mode})`, this._identityLog());
      this._setState(CALL_STATE.CANCELLED, this.error);

      if (this._inviteSent && this.sendSignal && this.roomId) {
        try {
          await this.sendSignal(this._signalPayload('cancel'));
        } catch (_) { }
      }

      if (sendLeave && this.rtcBridge?.leave) {
        try {
          await this.rtcBridge.leave({
            callEpoch: epoch,
            ownerId: `call-${epoch}`,
            roomId: this.roomId
          });
        } catch { }
      }

      this._cleanupResources(epoch);
      this._scheduleIdleTransition(CALL_STATE.CANCELLED, 800, epoch);
      return;
    }

    console.log(`[VoiceCallManager] CALL_ENDED (${this.mode})`, this._identityLog());
    this._setState(CALL_STATE.ENDING, this.error);

    if (this.sendSignal && this.roomId) {
      try {
        this.sendSignal(this._signalPayload('hangup'));
      } catch (_) { }
    }

    // Send leave frame
    if (sendLeave && this.rtcBridge?.leave) {
      try {
        await this.rtcBridge.leave({
          callEpoch: epoch,
          ownerId: `call-${epoch}`,
          roomId: this.roomId
        });
      } catch { }
    }

    this._setState(CALL_STATE.ENDED, this.error);
    this._cleanupResources(epoch);
    this._scheduleIdleTransition(CALL_STATE.ENDED, 800, epoch);
  }
}
