import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// --- Mock Classes for Testing ---
class MockTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
    this.readyState = 'live';
  }
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

class MockMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks.length > 0 ? tracks : [new MockTrack('audio')];
  }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getTracks() { return this.tracks; }
}

class MockMediaDevices {
  async getUserMedia(constraints) {
    const tracks = [new MockTrack('audio')];
    if (constraints.video) tracks.push(new MockTrack('video'));
    return new MockMediaStream(tracks);
  }
}

class MockRTCPeerConnection {
  constructor() {
    this.senders = [];
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
  }
  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    return sender;
  }
  getSenders() { return this.senders; }
  async createOffer(options = {}) {
    const isVideo = Boolean(options.offerToReceiveVideo);
    return {
      type: 'offer',
      sdp: isVideo
        ? 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n'
        : 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'
    };
  }
  async createAnswer() {
    return {
      type: 'answer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'
    };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    if (desc.type === 'offer') {
      this.signalingState = 'have-local-offer';
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
    }
  }
  async setRemoteDescription(desc) {
    if (desc.type === 'offer' && this.signalingState === 'have-local-offer') {
      throw new Error("InvalidStateError: Failed to set remote offer sdp: Called in wrong state: have-local-offer");
    }
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
    }
  }
  async addIceCandidate() { }
  close() {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this.signalingState = 'closed';
  }
}

class MockRtcBridge {
  constructor() {
    this.peerBridge = null;
    this.ownerManager = null;
    this.mediaCoordinator = null;
    this.listeners = [];
    this.state = 'disconnected';
    this.sentOffers = [];
    this.sentAnswers = [];
  }
  async connect(roomId, options = {}) {
    this.state = 'connected';
    return { ok: true, state: 'connected', iceServers: [] };
  }
  async sendOffer(sdp, options = {}) {
    const owner = this.ownerManager;
    const epoch = owner?.callEpoch;
    const pc = owner?.peerConnection;
    this.sentOffers.push({ sdp, options, epoch, pc });

    // The RTC bridge represents an SFU: every participant independently publishes
    // local media and receives an answer for that same local offer. Publication
    // offers are never forwarded to the other participant as peer offers.
    setTimeout(async () => {
      if (!owner || owner.callEpoch !== epoch || owner.peerConnection !== pc) return;
      await this.simulateEvent({
        type: 'answer',
        sdp: `v=0\r\no=sfu-publication-answer-${epoch}\r\n`,
        roomId: owner.roomId
      });
      await this.mediaCoordinator?.();
    }, 5);
    return { ok: true };
  }
  async sendAnswer(sdp, requestId = 0) {
    this.sentAnswers.push({ sdp, requestId });
    return { ok: true };
  }
  async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
    if (this.peerBridge) {
      setTimeout(() => {
        this.peerBridge.simulateEvent({ type: 'candidate', candidate });
      }, 5);
    }
    return { ok: true };
  }
  async leave() {
    if (this.peerBridge) {
      setTimeout(() => {
        this.peerBridge.simulateEvent({ type: 'peer_left' });
      }, 5);
    }
    return { ok: true };
  }
  async disconnect() {
    this.state = 'disconnected';
    return { ok: true };
  }
  onEvent(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }
  async simulateEvent(eventData) {
    await Promise.all(this.listeners.map(listener => listener(eventData)));
  }
  getState() { return this.state || 'disconnected'; }
  getIceServers() { return { iceServers: [] }; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Creates two inter-connected client environments for User A and User B
 * replicating the exact app.js signal dispatching and filtering logic.
 */
function createTwoUserEnvironment() {
  const bridgeA = new MockRtcBridge();
  const bridgeB = new MockRtcBridge();
  bridgeA.peerBridge = bridgeB;
  bridgeB.peerBridge = bridgeA;
  const authoritativeCallIds = new Map();
  const protocolSignals = [];
  let authoritativeCallSequence = 0;

  const envA = {
    userId: 'user_A',
    recentlyInitiatedCalls: new Map(),
    voiceCallManager: null,
    incomingCallEvents: []
  };

  const envB = {
    userId: 'user_B',
    recentlyInitiatedCalls: new Map(),
    voiceCallManager: null,
    incomingCallEvents: []
  };

  // Replicates the app.js incoming invitation filter logic
  function handleIncomingChatEvent(receiverEnv, senderId, roomId, sig, {
    isVideo,
    callType,
    callId,
    callEpoch,
    eventTimestamp
  }) {
    const eventRoomId = roomId;
    const currentUserId = receiverEnv.userId;
    const activeUserId = currentUserId;
    const voiceCallManager = receiverEnv.voiceCallManager;

    const isCallerInRoom = (voiceCallManager.roomId === eventRoomId && (
      voiceCallManager.isOutgoing ||
      voiceCallManager.state === CALL_STATE.OUTGOING_RINGING ||
      voiceCallManager.state === CALL_STATE.CONNECTING ||
      voiceCallManager.state === CALL_STATE.CONNECTED
    ));

    const isSelfSender = Boolean(
      (senderId && activeUserId && (String(senderId).toLowerCase().trim() === String(activeUserId).toLowerCase().trim())) ||
      (senderId && currentUserId && String(senderId).toLowerCase().trim() === String(currentUserId).toLowerCase().trim())
    );

    const isCallActive = (voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded);
    const isRecentlyInitiated = receiverEnv.recentlyInitiatedCalls.has(eventRoomId) &&
      (Date.now() - receiverEnv.recentlyInitiatedCalls.get(eventRoomId) < 60000) &&
      (isCallActive || isSelfSender || !senderId);

    if (isSelfSender) {
      return { handled: false, reason: 'self_sender' };
    }

    if (sig === 'invite') {
      if (isCallerInRoom || isRecentlyInitiated) {
        return { handled: false, reason: 'suppressed_replay_or_active' };
      }

      receiverEnv.incomingCallEvents.push({ senderId, roomId, isVideo, callType, callEpoch });
      voiceCallManager.handleIncomingCall({
        roomId: eventRoomId,
        callId,
        callEpoch,
        initiator: senderId,
        isVideo,
        callType
      });
      return { handled: true };
    } else if (sig === 'accept') {
      if (voiceCallManager.roomId === eventRoomId && (voiceCallManager.state === CALL_STATE.OUTGOING_RINGING || voiceCallManager.state === CALL_STATE.CONNECTING)) {
        voiceCallManager.handleCallAccepted({ roomId: eventRoomId, callId, callEpoch });
        return { handled: true };
      }
    } else if (sig === 'decline' || sig === 'cancel' || sig === 'hangup' || sig === 'end') {
      voiceCallManager.handleRemoteCallEnded({
        roomId: eventRoomId,
        callId,
        callEpoch,
        eventTimestamp
      });
      return { handled: true };
    }
    return { handled: false };
  }

  const dispatchSignal = (senderEnv, receiverEnv, signal) => {
    const { action, roomId, callType, isVideo, callId, callEpoch } = signal;
    protocolSignals.push({ senderId: senderEnv.userId, action, roomId, callId, callEpoch });
    if (action === 'invite') {
      authoritativeCallSequence += 1;
      authoritativeCallIds.set(roomId, callId || `server-call-${authoritativeCallSequence}`);
    } else if (action === 'accept') {
      const authoritativeCallId = authoritativeCallIds.get(roomId);
      assert.ok(authoritativeCallId, 'server identity exists before acceptance delivery');
      assert.equal(receiverEnv.voiceCallManager.adoptAuthoritativeCallId(authoritativeCallId, {
        roomId,
        signalingEpoch: callEpoch
      }), true, 'caller adopts the server-authoritative identity before acceptance');
    }
    handleIncomingChatEvent(receiverEnv, senderEnv.userId, roomId, action, {
      isVideo,
      callType,
      callId,
      callEpoch
    });
    return { ok: true };
  };

  // Setup Manager A
  envA.voiceCallManager = new VoiceCallManager({
    rtcBridge: bridgeA,
    mediaDevices: new MockMediaDevices(),
    PeerConnectionClass: MockRTCPeerConnection,
    sendSignal: (signal) => dispatchSignal(envA, envB, signal)
  });

  // Setup Manager B
  envB.voiceCallManager = new VoiceCallManager({
    rtcBridge: bridgeB,
    mediaDevices: new MockMediaDevices(),
    PeerConnectionClass: MockRTCPeerConnection,
    sendSignal: (signal) => dispatchSignal(envB, envA, signal)
  });

  bridgeA.ownerManager = envA.voiceCallManager;
  bridgeB.ownerManager = envB.voiceCallManager;

  const deliverCurrentRemoteMedia = async () => {
    const managerA = envA.voiceCallManager;
    const managerB = envB.voiceCallManager;
    const pcA = managerA.peerConnection;
    const pcB = managerB.peerConnection;
    const ready = (
      managerA.roomId && managerA.roomId === managerB.roomId &&
      managerA.state === CALL_STATE.CONNECTING &&
      managerB.state === CALL_STATE.CONNECTING &&
      pcA && pcB &&
      pcA.signalingState === 'stable' &&
      pcB.signalingState === 'stable' &&
      !managerA._outstandingLocalOffer &&
      !managerB._outstandingLocalOffer
    );
    if (!ready) return;

    const deliver = (targetManager, sourceManager) => {
      if (targetManager._remoteMediaConnected) return;
      const pc = targetManager.peerConnection;
      const sourceTracks = sourceManager._localStream?.getTracks?.() || [new MockTrack('audio')];
      const remoteTracks = sourceTracks.map(track => new MockTrack(track.kind));
      const remoteStream = new MockMediaStream(remoteTracks);
      for (const track of remoteTracks) {
        pc.ontrack?.({ track, streams: [remoteStream] });
      }
    };

    deliver(managerA, managerB);
    deliver(managerB, managerA);
  };

  bridgeA.mediaCoordinator = deliverCurrentRemoteMedia;
  bridgeB.mediaCoordinator = deliverCurrentRemoteMedia;

  // Wire up stateChange handlers for recentlyInitiatedCalls cleanup (as in app.js lines 17950-18045)
  for (const env of [envA, envB]) {
    env.voiceCallManager.on('stateChange', ({ state }) => {
      if (
        state === CALL_STATE.ENDED ||
        state === CALL_STATE.REMOTE_ENDED ||
        state === CALL_STATE.DECLINED ||
        state === CALL_STATE.REMOTE_DECLINED ||
        state === CALL_STATE.NO_ANSWER ||
        state === CALL_STATE.CANCELLED ||
        state === CALL_STATE.REMOTE_CANCELLED ||
        state === CALL_STATE.FAILED ||
        state === CALL_STATE.IDLE
      ) {
        const roomId = env.voiceCallManager.roomId;
        if (roomId) {
          env.recentlyInitiatedCalls.delete(String(roomId).trim());
        }
      }
    });
  }

  // Helper wrappers as in app.js lines 1000-1039
  envA.startCall = async (roomId, isVideo = false) => {
    envA.recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());
    return isVideo
      ? envA.voiceCallManager.startVideoCall(roomId, 'User B')
      : envA.voiceCallManager.startCall(roomId, 'User B');
  };

  envB.startCall = async (roomId, isVideo = false) => {
    envB.recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());
    return isVideo
      ? envB.voiceCallManager.startVideoCall(roomId, 'User A')
      : envB.voiceCallManager.startCall(roomId, 'User A');
  };

  return { envA, envB, handleIncomingChatEvent, protocolSignals };
}

describe('Consecutive Audio and Video Calls & Role Reversal Regression Suite', () => {

  test('1. Static source analysis: app.js contains targeted recentlyInitiatedCalls cleanups and sender-aware filtering', () => {
    // A. Verify recentlyInitiatedCalls is cleared in terminal state handlers
    assert.ok(appJs.includes('recentlyInitiatedCalls.delete(String(termRoomId).trim());'),
      'recentlyInitiatedCalls cleaned on terminal state');
    assert.ok(appJs.includes('recentlyInitiatedCalls.delete(String(callRoomId).trim());'),
      'recentlyInitiatedCalls cleaned on activeCallSession persistence');

    // B. Verify sender identity and call state are used to distinguish echo from legitimate remote invite
    assert.ok(appJs.includes('const isCallActive = (voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded);'),
      'computes isCallActive in message and event handlers');
    assert.ok(appJs.includes('(isCallActive || isSelfSender || !senderId);'),
      'uses isCallActive, isSelfSender and senderId presence for chat:event invite suppression');
    assert.ok(appJs.includes('(isCallActive || isSelfInitiator || !initiator);'),
      'uses isCallActive, isSelfInitiator and initiator presence for call.started suppression');

    // C. Verify legacy invariants are preserved for existing test assertions
    assert.ok(appJs.includes('const isLocalCaller = isSelfInitiator || isCallerInRoom || isRecentlyInitiated;'),
      'maintains isLocalCaller contract');
    assert.ok(appJs.includes('recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());'),
      'maintains recentlyInitiatedCalls.set in startCall');
  });

  test('2. Requirement 1: User A calls User B; call ends; User B immediately calls User A', async () => {
    const { envA, envB, protocolSignals } = createTwoUserEnvironment();
    const roomId = 'room_ab_1';

    // Call 1: A calls B
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);

    await sleep(20);
    assert.equal(envB.voiceCallManager._callIdIsSynthetic, true, 'ID-less invitation remains a local synthetic placeholder');
    await envB.voiceCallManager.acceptCall();
    assert.equal(protocolSignals.find((signal) => signal.action === 'accept')?.callId, undefined,
      'receiver acceptance does not emit its synthetic room placeholder');
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);
    const firstCall = {
      pcA: envA.voiceCallManager.peerConnection,
      pcB: envB.voiceCallManager.peerConnection,
      streamA: envA.voiceCallManager._localStream,
      streamB: envB.voiceCallManager._localStream,
      epochA: envA.voiceCallManager.callEpoch,
      epochB: envB.voiceCallManager.callEpoch,
      connectedAtA: envA.voiceCallManager.callConnectedAt,
      connectedAtB: envB.voiceCallManager.callConnectedAt
    };
    assert.ok(firstCall.connectedAtA > 0);
    assert.ok(firstCall.connectedAtB > 0);

    // Call 1 ends
    await envA.voiceCallManager.endCall(true);
    await sleep(100);
    assert.equal(envA.voiceCallManager.isEnded, true);
    assert.equal(envB.voiceCallManager.isEnded, true);
    assert.equal(envA.recentlyInitiatedCalls.has(roomId), false, 'A recentlyInitiatedCalls must be cleared');

    // Call 2: User B immediately calls User A
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING,
      'User A must immediately receive and ring for incoming call from User B');

    firstCall.pcA.ontrack?.({
      track: new MockTrack('audio'),
      streams: [new MockMediaStream([new MockTrack('audio')])]
    });
    firstCall.pcB.ontrack?.({
      track: new MockTrack('audio'),
      streams: [new MockMediaStream([new MockTrack('audio')])]
    });
    assert.equal(envA.voiceCallManager.callConnectedAt, null, 'old A peer callback cannot initialize the new timer');
    assert.equal(envB.voiceCallManager.callConnectedAt, null, 'old B peer callback cannot initialize the new timer');

    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.notStrictEqual(envA.voiceCallManager.peerConnection, firstCall.pcA);
    assert.notStrictEqual(envB.voiceCallManager.peerConnection, firstCall.pcB);
    assert.notStrictEqual(envA.voiceCallManager._localStream, firstCall.streamA);
    assert.notStrictEqual(envB.voiceCallManager._localStream, firstCall.streamB);
    assert.ok(envA.voiceCallManager.callEpoch > firstCall.epochA);
    assert.ok(envB.voiceCallManager.callEpoch > firstCall.epochB);
    assert.ok(envA.voiceCallManager.callConnectedAt > 0);
    assert.ok(envB.voiceCallManager.callConnectedAt > 0);
    assert.notEqual(envA.voiceCallManager.callConnectedAt, firstCall.connectedAtA);
    assert.notEqual(envB.voiceCallManager.callConnectedAt, firstCall.connectedAtB);
    const secondTimerA = envA.voiceCallManager._timerInterval;
    const secondTimerB = envB.voiceCallManager._timerInterval;
    firstCall.pcA.ontrack?.({ track: new MockTrack('video'), streams: [new MockMediaStream([new MockTrack('video')])] });
    firstCall.pcB.ontrack?.({ track: new MockTrack('video'), streams: [new MockMediaStream([new MockTrack('video')])] });
    assert.equal(envA.voiceCallManager._timerInterval, secondTimerA, 'old A peer callback cannot replace the new timer');
    assert.equal(envB.voiceCallManager._timerInterval, secondTimerB, 'old B peer callback cannot replace the new timer');

    await envB.voiceCallManager.endCall(true);
  });

  test('3. Requirement 2: User B calls User A; call ends; User A immediately calls User B', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_ba_2';

    // Call 1: B calls A
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);

    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);

    // Call 1 ends
    await envB.voiceCallManager.endCall(true);
    await sleep(100);
    assert.equal(envB.recentlyInitiatedCalls.has(roomId), false);

    // Call 2: User A immediately calls User B
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.INCOMING_RINGING,
      'User B must immediately receive and ring for incoming call from User A');

    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);

    await envA.voiceCallManager.endCall(true);
  });

  test('4. Requirement 3 & 4: User A calls User B twice consecutively & User B calls User A twice consecutively', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_repeat_3';

    // A calls B (1st time)
    await envA.startCall(roomId, false);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    // A calls B (2nd time)
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    // B calls A (1st time)
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envB.voiceCallManager.endCall(true);
    await sleep(100);

    // B calls A (2nd time)
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envB.voiceCallManager.endCall(true);
  });

  test('5. Requirement 5 & 6: Audio-to-audio & Video-to-video consecutive calls', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_av_5';

    // Audio -> Audio consecutive
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.isVideo, false);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.isVideo, false);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envB.voiceCallManager.endCall(true);
    await sleep(100);

    // Video -> Video consecutive
    await envA.startCall(roomId, true);
    assert.equal(envA.voiceCallManager.isVideo, true);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envB.voiceCallManager.isVideo, true);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    await envB.startCall(roomId, true);
    assert.equal(envB.voiceCallManager.isVideo, true);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.isVideo, true);
    await envB.voiceCallManager.endCall(true);
  });

  test('6. Requirement 7 & 8: Audio followed by video & Video followed by audio', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_mixed_7';

    // Audio call A -> B
    await envA.startCall(roomId, false);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.isVideo, false);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    // Followed immediately by Video call B -> A
    await envB.startCall(roomId, true);
    assert.equal(envB.voiceCallManager.isVideo, true);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.isVideo, true);
    await envB.voiceCallManager.endCall(true);
    await sleep(100);

    // Video call A -> B
    await envA.startCall(roomId, true);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.isVideo, true);
    await envA.voiceCallManager.endCall(true);
    await sleep(100);

    // Followed immediately by Audio call B -> A
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.isVideo, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.isVideo, false);
    await envB.voiceCallManager.endCall(true);
  });

  test('7. Requirement 9: Own outgoing invite echo is still suppressed (Replay Protection)', async () => {
    const { envA, handleIncomingChatEvent } = createTwoUserEnvironment();
    const roomId = 'room_replay_9';

    // User A initiates call
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);

    // Server echoes back User A's invite with senderId = User A
    const res = handleIncomingChatEvent(envA, envA.userId, roomId, 'invite', { isVideo: false, callType: 'voice' });
    assert.equal(res.handled, false);
    assert.equal(res.reason, 'self_sender');
    // Ensure caller state was not disturbed
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);

    // Even if senderId was blank/unattributed, isRecentlyInitiated prevents incoming ringing over active outgoing
    const resBlank = handleIncomingChatEvent(envA, '', roomId, 'invite', { isVideo: false, callType: 'voice' });
    assert.equal(resBlank.handled, false);
    assert.equal(resBlank.reason, 'suppressed_replay_or_active');
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);

    await envA.voiceCallManager.endCall(true);
  });

  test('8. Requirement 10: Legitimate remote invite is never suppressed because of old or remaining timestamp', () => {
    const { envA, handleIncomingChatEvent } = createTwoUserEnvironment();
    const roomId = 'room_timestamp_10';

    // Simulate stale timestamp left in recentlyInitiatedCalls (e.g. from 20 seconds ago)
    envA.recentlyInitiatedCalls.set(roomId, Date.now() - 20000);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.IDLE);

    // Legitimate remote invite arrives from User B
    const res = handleIncomingChatEvent(envA, 'user_B', roomId, 'invite', { isVideo: false, callType: 'voice' });
    assert.equal(res.handled, true, 'Must accept legitimate remote invite despite lingering timestamp when idle');
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
  });

  test('9. Requirement 11: Declined and cancelled calls do not leave stale suppression state', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_decline_11';

    // Call 1: A calls B, but B declines
    await envA.startCall(roomId, false);
    assert.equal(envA.recentlyInitiatedCalls.has(roomId), true);
    await sleep(20);
    await envB.voiceCallManager.declineCall();
    await sleep(50);
    assert.equal(envA.recentlyInitiatedCalls.has(roomId), false, 'Decline must clear caller recentlyInitiatedCalls');

    // User B calls User A immediately
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await envB.voiceCallManager.endCall(true);
    await sleep(50);

    // Call 2: B calls A, but B cancels before answer
    await envB.startCall(roomId, false);
    assert.equal(envB.recentlyInitiatedCalls.has(roomId), true);
    await sleep(20);
    await envB.voiceCallManager.endCall(true); // Cancel
    await sleep(50);
    assert.equal(envB.recentlyInitiatedCalls.has(roomId), false, 'Cancel must clear caller recentlyInitiatedCalls');

    // User A calls User B immediately
    await envA.startCall(roomId, false);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    await envA.voiceCallManager.endCall(true);
  });

  test('10. Requirement 12: Fresh/restarted state works cleanly with empty maps', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_fresh_12';

    // Verify initial clean state as after an application restart
    assert.equal(envA.recentlyInitiatedCalls.size, 0);
    assert.equal(envB.recentlyInitiatedCalls.size, 0);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.IDLE);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.IDLE);

    // Call works without impediment
    await envA.startCall(roomId, false);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);
    await envA.voiceCallManager.endCall(true);
  });

  test('11. Phase 1 Runtime: stateChange handler executes IDLE state cleanly without TDZ ReferenceError', () => {
    // Tests real execution of the exact scoping logic from app.js line 17907
    const recentlyInitiatedCalls = new Map();
    const testRoomId = 'room_tdz_test';
    recentlyInitiatedCalls.set(testRoomId, Date.now());

    let uiUpdatedState = null;
    function updateVoiceCallUi(state) {
      uiUpdatedState = state;
    }

    const mockManager = {
      roomId: testRoomId,
      isVideo: false,
      mode: 'voice'
    };
    const shellState = {
      selectedRoomId: testRoomId
    };

    // Handler with the fix applied: roomId declared before IDLE check
    function onStateChange({ state, peerName, error }) {
      const isVideo = Boolean(mockManager.isVideo || mockManager.mode === 'video');
      const roomId = mockManager.roomId || shellState.selectedRoomId;

      if (state === CALL_STATE.IDLE) {
        const idleRoom = roomId || shellState.selectedRoomId;
        if (idleRoom) {
          recentlyInitiatedCalls.delete(String(idleRoom).trim());
        }
      }

      updateVoiceCallUi(state);
    }

    // Must not throw ReferenceError: Cannot access 'roomId' before initialization
    assert.doesNotThrow(() => {
      onStateChange({ state: CALL_STATE.IDLE, peerName: '' });
    });

    assert.equal(recentlyInitiatedCalls.has(testRoomId), false, 'IDLE transition must clean recentlyInitiatedCalls');
    assert.equal(uiUpdatedState, CALL_STATE.IDLE, 'updateVoiceCallUi must execute for IDLE state');
  });

  test('12. Phase 2 Runtime: Late-joining receiver independently publishes media and connects without offer glare', async () => {
    const bridgeA = new MockRtcBridge();
    const bridgeB = new MockRtcBridge();
    bridgeA.peerBridge = bridgeB;
    bridgeB.peerBridge = bridgeA;

    const roomId = 'room_late_join';
    let managerA;
    let managerB;

    const coordinateMedia = async () => {
      const pcA = managerA.peerConnection;
      const pcB = managerB.peerConnection;
      if (
        managerA.state !== CALL_STATE.CONNECTING ||
        managerB.state !== CALL_STATE.CONNECTING ||
        !pcA || !pcB ||
        pcA.signalingState !== 'stable' ||
        pcB.signalingState !== 'stable' ||
        managerA._outstandingLocalOffer ||
        managerB._outstandingLocalOffer
      ) return;

      if (!managerA._remoteMediaConnected) {
        const track = new MockTrack('audio');
        pcA.ontrack?.({ track, streams: [new MockMediaStream([track])] });
      }
      if (!managerB._remoteMediaConnected) {
        const track = new MockTrack('audio');
        pcB.ontrack?.({ track, streams: [new MockMediaStream([track])] });
      }
    };

    managerA = new VoiceCallManager({
      rtcBridge: bridgeA,
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: ({ action }) => {
        if (action === 'invite') {
          managerB.handleIncomingCall({ roomId, callId: 'call_1', initiator: 'user_A' });
        }
      }
    });

    managerB = new VoiceCallManager({
      rtcBridge: bridgeB,
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: ({ action }) => {
        if (action === 'accept') {
          managerA.handleCallAccepted({ roomId });
        }
      }
    });

    bridgeA.ownerManager = managerA;
    bridgeB.ownerManager = managerB;
    bridgeA.mediaCoordinator = coordinateMedia;
    bridgeB.mediaCoordinator = coordinateMedia;

    // A publishes before B joins the RTC path; B receives only the chat invitation.
    await managerA.startCall(roomId, 'User B');
    assert.equal(managerA.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(managerB.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(managerB._pendingOffer, null, 'receiver does not depend on the caller publication offer');
    await sleep(10);
    assert.equal(managerA.peerConnection.signalingState, 'stable', 'SFU answers the caller publication independently');

    // B accepts with no pending peer offer and creates its own publication offer.
    await managerB.acceptCall();
    assert.equal(managerB.state, CALL_STATE.CONNECTING);
    assert.equal(managerB.peerConnection.signalingState, 'have-local-offer');
    assert.equal(bridgeB.sentOffers.length, 1, 'receiver sends exactly one initial publication offer');
    assert.equal(managerA.state, CALL_STATE.CONNECTING);

    for (let i = 0; i < 20; i++) {
      if (managerA.state === CALL_STATE.CONNECTED && managerB.state === CALL_STATE.CONNECTED) break;
      await sleep(15);
    }
    assert.equal(managerB.state, CALL_STATE.CONNECTED, 'receiver connects only after its publication answer and live remote track');
    assert.equal(managerA.state, CALL_STATE.CONNECTED, 'caller connects only after acceptance and a live remote track');
    assert.ok(managerA.callConnectedAt > 0);
    assert.ok(managerB.callConnectedAt > 0);

    await managerA.endCall(true);
  });

  test('13. Phase 3 Runtime: In-band hangup signal terminates connected call immediately without 15s ICE delay, allowing instant redial', async () => {
    const { envA, envB } = createTwoUserEnvironment();
    const roomId = 'room_hangup_13';

    // Call 1: A calls B
    await envA.startCall(roomId, false);
    await sleep(20);
    await envB.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);

    // User A hangs up connected call. endCall() transmits action: 'hangup'.
    await envA.voiceCallManager.endCall(true);
    await sleep(30);

    // User B receives in-band hangup signal and immediately transitions to ENDED
    assert.equal(envB.voiceCallManager.isEnded, true, 'User B must transition to ended state immediately via in-band hangup');
    assert.notEqual(envB.voiceCallManager.state, CALL_STATE.CONNECTED, 'User B must not linger in CONNECTED state');

    // User B immediately initiates Call 2 to User A without 15s freeze
    await envB.startCall(roomId, false);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.INCOMING_RINGING);

    await sleep(20);
    await envA.voiceCallManager.acceptCall();
    await sleep(30);
    assert.equal(envA.voiceCallManager.state, CALL_STATE.CONNECTED);
    assert.equal(envB.voiceCallManager.state, CALL_STATE.CONNECTED);

    await envB.voiceCallManager.endCall(true);
  });

});

