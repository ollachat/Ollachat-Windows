import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockAudioTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }
}

class MockMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks.length > 0 ? tracks : [new MockAudioTrack('audio')];
  }

  getAudioTracks() {
    return this.tracks.filter(t => t.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video');
  }

  getTracks() {
    return this.tracks;
  }
}

class MockMediaDevices {
  constructor({ shouldDeny = false } = {}) {
    this.shouldDeny = shouldDeny;
    this.getUserMediaCalls = [];
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    if (this.shouldDeny) {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    }
    // If video was requested, fail invariant
    if (constraints.video) {
      throw new Error('Video requested in voice-only call!');
    }
    return new MockMediaStream();
  }
}

class MockRTCPeerConnection {
  static instances = [];

  constructor(config = {}) {
    this.config = config;
    this.iceServers = config.iceServers || [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.senders = [];
    this.addedIceCandidates = [];
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.isClosed = false;

    MockRTCPeerConnection.instances.push(this);
  }

  addTrack(track, stream) {
    const sender = { track, stream };
    this.senders.push(sender);
    return sender;
  }

  getSenders() {
    return this.senders;
  }

  async createOffer(options = {}) {
    return {
      type: 'offer',
      sdp: 'v=0\r\no=mock-caller-offer\r\n'
    };
  }

  async createAnswer(options = {}) {
    return {
      type: 'answer',
      sdp: 'v=0\r\no=mock-callee-answer\r\n'
    };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate) {
    this.addedIceCandidates.push(candidate);
  }

  close() {
    this.isClosed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }

  simulateTrack(stream = new MockMediaStream()) {
    if (this.ontrack) {
      this.ontrack({
        streams: [stream],
        track: stream.getAudioTracks()[0]
      });
    }
  }

  simulateConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }

  simulateIceConnectionState(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

class MockRtcBridge {
  constructor({ connectOk = true, iceServers = [{ urls: ['stun:stun.ollacore.com:3478'] }] } = {}) {
    this.connectOk = connectOk;
    this.iceServers = iceServers;
    this.connectCalls = [];
    this.sentOffers = [];
    this.sentAnswers = [];
    this.sentCandidates = [];
    this.leavesSent = 0;
    this.disconnectCalls = 0;
    this._eventListeners = new Set();
  }

  async connect(roomId) {
    this.connectCalls.push(roomId);
    if (!this.connectOk) {
      return { ok: false, error: 'RTC connect failed' };
    }
    return {
      ok: true,
      state: 'connected',
      roomId,
      iceServers: this.iceServers
    };
  }

  async sendOffer(sdp) {
    this.sentOffers.push(sdp);
    return { ok: true };
  }

  async sendAnswer(sdp, requestId) {
    this.sentAnswers.push({ sdp, requestId });
    return { ok: true };
  }

  async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
    this.sentCandidates.push({ candidate, sdpMid, sdpMLineIndex });
    return { ok: true };
  }

  async leave() {
    this.leavesSent++;
    return { ok: true };
  }

  async disconnect() {
    this.disconnectCalls++;
    return { ok: true };
  }

  onEvent(callback) {
    this._eventListeners.add(callback);
    return () => this._eventListeners.delete(callback);
  }

  async simulateEvent(eventData) {
    for (const cb of Array.from(this._eventListeners)) {
      await cb(eventData);
    }
  }
}

class MockAudioElement {
  constructor() {
    this.srcObject = null;
    this.played = false;
  }

  async play() {
    this.played = true;
  }
}

describe('Phase 6B: Real Voice Calling WebRTC Contract Tests (A through Z)', () => {

  test('A. VoiceCallManager initializes in idle state with clean defaults', () => {
    const manager = new VoiceCallManager();
    assert.equal(manager.state, CALL_STATE.IDLE);
    assert.equal(manager.roomId, null);
    assert.equal(manager.isMuted, false);
    assert.equal(manager.peerConnection, null);
  });

  test('B. Room token / ICE server configuration applies dynamically from room token', async () => {
    MockRTCPeerConnection.instances = [];
    const customIce = [{ urls: ['turn:custom-turn.ollacore.com:3478'], username: 'u1', credential: 'p1' }];
    const rtcBridge = new MockRtcBridge({ iceServers: customIce });
    const mediaDevices = new MockMediaDevices();

    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-101', 'Alice');

    const pc = MockRTCPeerConnection.instances[0];
    assert.ok(pc);
    assert.equal(pc.iceServers.length, 1);
    assert.deepEqual(pc.iceServers[0].urls, ['turn:custom-turn.ollacore.com:3478']);
    assert.equal(pc.iceServers[0].username, 'u1');
    assert.equal(pc.iceServers[0].credential, 'p1');

    await manager.endCall();
  });

  test('C. Microphone permission request specifies audio: true, video: false', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-102', 'Bob');

    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: false });

    await manager.endCall();
  });

  test('D. Microphone denial handling transitions to FAILED without throwing unhandled rejection', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices({ shouldDeny: true });
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await assert.rejects(
      async () => {
        await manager.startCall('room-103', 'Charlie');
      },
      /microphone permission denied/i
    );

    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.equal(manager.isEnded, true);
  });

  test('E. Local audio track creation obtains audio track', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-104', 'David');
    assert.ok(manager._localAudioTrack);
    assert.equal(manager._localAudioTrack.kind, 'audio');

    await manager.endCall();
  });

  test('F. Audio track is added to RTCPeerConnection', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-105', 'Eva');

    const pc = MockRTCPeerConnection.instances[0];
    assert.equal(pc.senders.length, 1);
    assert.equal(pc.senders[0].track.kind, 'audio');

    await manager.endCall();
  });

  test('G. Caller creates offer', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-106', 'Frank');
    const pc = MockRTCPeerConnection.instances[0];
    assert.ok(pc.localDescription);
    assert.equal(pc.localDescription.type, 'offer');

    await manager.endCall();
  });

  test('H. Local description is set with created offer', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-107', 'Grace');
    const pc = MockRTCPeerConnection.instances[0];
    assert.equal(pc.localDescription.type, 'offer');
    assert.match(pc.localDescription.sdp, /mock-caller-offer/);

    await manager.endCall();
  });

  test('I. Offer is sent through RTC WebSocket signaling bridge', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-108', 'Heidi');
    assert.equal(rtcBridge.sentOffers.length, 1);
    assert.match(rtcBridge.sentOffers[0], /mock-caller-offer/);

    await manager.endCall();
  });

  test('J. Incoming answer processed and sets remote description', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-109', 'Ivan');
    const pc = MockRTCPeerConnection.instances[0];

    // Simulate incoming answer from callee
    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'v=0\r\no=callee-answer-sdp\r\n',
      roomId: 'room-109'
    });

    assert.ok(pc.remoteDescription);
    assert.equal(pc.remoteDescription.type, 'answer');
    assert.match(pc.remoteDescription.sdp, /callee-answer-sdp/);

    await manager.endCall();
  });

  test('K. Remote description is established on answer reception', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-110', 'Judy');
    const pc = MockRTCPeerConnection.instances[0];

    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'v=0\r\nsdp-remote-ok\r\n',
      roomId: 'room-110'
    });

    assert.equal(pc.remoteDescription.type, 'answer');
    await manager.endCall();
  });

  test('L. Local ICE candidate sent through RTC WebSocket', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-111', 'Kevin');
    const pc = MockRTCPeerConnection.instances[0];

    // Trigger local icecandidate
    pc.onicecandidate({
      candidate: {
        candidate: 'candidate:local-ice-1',
        sdpMid: 'audio',
        sdpMLineIndex: 0
      }
    });

    assert.equal(rtcBridge.sentCandidates.length, 1);
    assert.equal(rtcBridge.sentCandidates[0].candidate, 'candidate:local-ice-1');
    assert.equal(rtcBridge.sentCandidates[0].sdpMid, 'audio');

    await manager.endCall();
  });

  test('M. Remote ICE candidate processed and queued if remote description not yet set', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-112', 'Leo');
    const pc = MockRTCPeerConnection.instances[0];

    // Candidate arrives BEFORE answer (remoteDescription is null)
    await rtcBridge.simulateEvent({
      type: 'candidate',
      candidate: { candidate: 'candidate:remote-1', sdpMid: 'audio', sdpMLineIndex: 0 },
      roomId: 'room-112'
    });

    assert.equal(manager._pendingIceCandidates.length, 1);
    assert.equal(pc.addedIceCandidates.length, 0);

    // Answer arrives -> candidates are drained immediately
    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'v=0\r\no=callee-answer\r\n',
      roomId: 'room-112'
    });

    assert.equal(manager._pendingIceCandidates.length, 0);
    assert.equal(pc.addedIceCandidates.length, 1);
    assert.equal(pc.addedIceCandidates[0].candidate, 'candidate:remote-1');

    await manager.endCall();
  });

  test('N. Incoming call enters ringing state on call.started', () => {
    const manager = new VoiceCallManager();
    manager.handleIncomingCall({
      roomId: 'room-113',
      callId: 'call-999',
      initiator: 'Mia'
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(manager.roomId, 'room-113');
    assert.equal(manager.peerName, 'Mia');
  });

  test('O. Receiver publishes locally, queues a colliding SFU offer, then answers it after the publication answer', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    manager.handleIncomingCall({
      roomId: 'room-114',
      callId: 'call-114',
      initiator: 'Noah'
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    await manager.acceptCall();
    assert.equal(manager.state, CALL_STATE.CONNECTING);

    const pc = MockRTCPeerConnection.instances[0];
    assert.ok(pc);
    assert.equal(pc.localDescription.type, 'offer');
    assert.equal(rtcBridge.sentOffers.length, 1, 'receiver sends its own publication offer');

    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: 'v=0\r\no=sfu-offer-sdp\r\n',
      requestId: 77,
      roomId: 'room-114'
    });

    assert.equal(pc.remoteDescription, null, 'SFU offer waits behind the receiver publication offer');
    assert.equal(manager._queuedSfuOffers.length, 1);
    assert.equal(rtcBridge.sentAnswers.length, 0);

    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'v=0\r\no=receiver-publication-answer\r\n',
      roomId: 'room-114'
    });

    assert.equal(pc.remoteDescription.type, 'offer');
    assert.equal(pc.localDescription.type, 'answer');
    assert.equal(manager._queuedSfuOffers.length, 0);
    assert.equal(rtcBridge.sentAnswers.length, 1);
    assert.equal(rtcBridge.sentAnswers[0].requestId, 77);

    await manager.endCall();
  });

  test('P. Connected state reached upon remote track or ICE connection', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const audioEl = new MockAudioElement();

    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection,
      remoteAudioElement: audioEl
    });

    await manager.startCall('room-115', 'Olivia');
    const pc = MockRTCPeerConnection.instances[0];

    assert.equal(manager.state, CALL_STATE.CALLING);

    // Remote audio track arrives
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(audioEl.srcObject);
    assert.equal(audioEl.played, true);

    await manager.endCall();
  });

  test('Q. Mute disables local audio track without destroying PeerConnection', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-116', 'Paul');
    const pcBefore = MockRTCPeerConnection.instances[0];

    const isMuted = manager.toggleMute();
    assert.equal(isMuted, true);
    assert.equal(manager.isMuted, true);
    assert.equal(manager._localAudioTrack.enabled, false);
    assert.equal(manager.peerConnection, pcBefore); // PeerConnection remains intact

    await manager.endCall();
  });

  test('R. Unmute enables local audio track again', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-117', 'Quinn');
    manager.toggleMute(); // mute
    assert.equal(manager._localAudioTrack.enabled, false);

    const isMutedNow = manager.toggleMute(); // unmute
    assert.equal(isMutedNow, false);
    assert.equal(manager._localAudioTrack.enabled, true);

    await manager.endCall();
  });

  test('S. End call performs complete cleanup (stops tracks, closes PC, sends leave)', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const audioEl = new MockAudioElement();

    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection,
      remoteAudioElement: audioEl
    });

    await manager.startCall('room-118', 'Ruby');
    const pc = MockRTCPeerConnection.instances[0];
    const track = manager._localAudioTrack;

    await manager.endCall(true);

    assert.equal(rtcBridge.leavesSent, 1);
    assert.equal(rtcBridge.disconnectCalls, 1);
    assert.equal(pc.isClosed, true);
    assert.equal(track.stopped, true);
    assert.equal(manager._localAudioTrack, null);
    assert.equal(audioEl.srcObject, null);
    assert.equal(manager.state, CALL_STATE.CANCELLED);
    assert.equal(manager.isEnded, true);
  });

  test('T. Decline incoming call terminates ringing and clears state without calling RTC', () => {
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({ rtcBridge });

    manager.handleIncomingCall({ roomId: 'room-119', callId: 'call-119', initiator: 'Sam' });
    assert.equal(manager.state, CALL_STATE.RINGING);

    manager.declineCall();
    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(manager.isEnded, true);
  });

  test('U. WebRTC failure transitions call to failed', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-120', 'Tina');
    const pc = MockRTCPeerConnection.instances[0];

    // Simulate connection failure
    pc.simulateConnectionState('failed');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(manager.error, 'Call connection failed');
    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.equal(manager.isEnded, true);
  });

  test('V. Room switching cannot leak call state (stale room events dropped)', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-A', 'UserA');
    const pc = MockRTCPeerConnection.instances[0];

    // Stale answer from Room B arriving while on Room A call
    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'stale-answer-from-room-B',
      roomId: 'room-B'
    });

    // Remote description should NOT be modified by Room B event
    assert.equal(pc.remoteDescription, null);

    await manager.endCall();
  });

  test('W. Existing active call prevents creating a second PeerConnection', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-121', 'Victor');
    assert.equal(MockRTCPeerConnection.instances.length, 1);

    // Incoming call arrives while already active
    manager.handleIncomingCall({ roomId: 'room-122', callId: 'c-122', initiator: 'Wendy' });
    // State remains in active call, not ringing
    assert.equal(manager.roomId, 'room-121');

    await assert.rejects(
      async () => {
        await manager.startCall('room-123', 'Xavier');
      },
      /existing call active/i
    );

    assert.equal(MockRTCPeerConnection.instances.length, 1);
    await manager.endCall();
  });

  test('X. No camera APIs are called', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-124', 'Yara');
    const calls = mediaDevices.getUserMediaCalls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].video, false); // video is strictly false
    assert.equal(calls[0].audio, true);

    await manager.endCall();
  });

  test('Y. No video tracks are created', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-125', 'Zack');
    const stream = manager._localStream;
    assert.equal(stream.getVideoTracks().length, 0);

    await manager.endCall();
  });

  test('Z. Tokens are never exposed to renderer or call manager', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-126', 'AuthCheck');

    // Confirm manager only holds roomId and peerName, never tokens
    assert.ok(!manager._token);
    assert.ok(!manager.sessionToken);
    assert.ok(!manager.roomToken);
    assert.ok(!JSON.stringify(manager).includes('du_'));
    assert.ok(!JSON.stringify(manager).includes('rt_'));

    await manager.endCall();
  });

  test('AA. Synthetic incoming identity adopts the authoritative server call ID', async () => {
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({ rtcBridge });

    manager.handleIncomingCall({ roomId: 'room-aa', initiator: 'Alice' });
    const epoch = manager.callEpoch;

    assert.equal(manager.callId, 'room-aa');
    assert.equal(manager._callIdIsSynthetic, true);
    assert.equal(manager.adoptAuthoritativeCallId('call-authoritative-aa', {
      roomId: 'room-aa',
      callEpoch: epoch
    }), true);
    assert.equal(manager.callId, 'call-authoritative-aa');
    assert.equal(manager._callIdIsSynthetic, false);

    await manager.endCall(false);
  });

  test('AB. A conflicting authoritative call ID cannot replace the active identity', async () => {
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({ rtcBridge });

    manager.handleIncomingCall({
      roomId: 'room-ab',
      callId: 'call-authoritative-ab',
      initiator: 'Bob'
    });

    assert.equal(manager.adoptAuthoritativeCallId('call-conflict-ab', {
      roomId: 'room-ab',
      callEpoch: manager.callEpoch
    }), false);
    assert.equal(manager.callId, 'call-authoritative-ab');

    await manager.endCall(false);
  });

  test('AC. Stale call ID and stale epoch terminations cannot end the current call', async () => {
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-ac', 'Carol');
    const currentEpoch = manager.callEpoch;
    manager.adoptAuthoritativeCallId('call-current-ac', {
      roomId: 'room-ac',
      callEpoch: currentEpoch
    });

    await manager.handleRemoteCallEnded({
      roomId: 'room-ac',
      callId: 'call-old-ac',
      callEpoch: currentEpoch
    });
    assert.equal(manager.state, CALL_STATE.CALLING);

    await manager.handleRemoteCallEnded({
      roomId: 'room-ac',
      callId: 'call-current-ac',
      callEpoch: currentEpoch - 1
    });
    assert.equal(manager.state, CALL_STATE.CALLING);

    await manager.endCall(false);
  });

  test('AD. Incoming ringing preconnect is reused by acceptance', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    manager.handleIncomingCall({
      roomId: 'room-ad',
      callId: 'call-ad',
      initiator: 'David'
    });
    await Promise.resolve();
    assert.equal(rtcBridge.connectCalls.length, 1);

    await manager.acceptCall();
    assert.equal(rtcBridge.connectCalls.length, 1);
    assert.equal(manager.state, CALL_STATE.CONNECTING);

    await manager.endCall(false);
  });

  test('AE. Delayed cleanup from call one cannot clear a newly started call two', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-ae-one', 'First');
    const firstEpoch = manager.callEpoch;
    await manager.endCall(false);

    await manager.startCall('room-ae-two', 'Second');
    const secondEpoch = manager.callEpoch;
    assert.ok(secondEpoch > firstEpoch);

    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.roomId, 'room-ae-two');
    assert.equal(manager.callEpoch, secondEpoch);

    await manager.endCall(false);
  });

  test('AF. Deferred camera completion from call one cannot attach to call two', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    let resolveCamera;
    let mediaRequestCount = 0;
    const staleCameraTrack = new MockAudioTrack('video');
    const mediaDevices = {
      async getUserMedia(constraints) {
        mediaRequestCount += 1;
        if (mediaRequestCount === 2 && constraints.video === true) {
          return new Promise(resolve => {
            resolveCamera = resolve;
          });
        }
        return new MockMediaStream();
      }
    };
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-af-one', 'First');
    const cameraPromise = manager.enableCamera();
    await Promise.resolve();
    assert.equal(typeof resolveCamera, 'function');

    await manager.endCall(false);
    await manager.startCall('room-af-two', 'Second');
    const secondEpoch = manager.callEpoch;

    resolveCamera(new MockMediaStream([staleCameraTrack]));
    assert.equal(await cameraPromise, false);
    assert.equal(staleCameraTrack.stopped, true);
    assert.equal(manager.roomId, 'room-af-two');
    assert.equal(manager.callEpoch, secondEpoch);
    assert.equal(manager._localVideoTrack, null);

    await manager.endCall(false);
  });

  test('AG. Delayed same-room legacy event without identity cannot end call two', async () => {
    MockRTCPeerConnection.instances = [];
    const manager = new VoiceCallManager({
      rtcBridge: new MockRtcBridge(),
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-ag', 'First');
    manager.adoptAuthoritativeCallId('call-ag-one', {
      roomId: 'room-ag',
      callEpoch: manager.callEpoch
    });
    await manager.endCall(false);

    await manager.startCall('room-ag', 'Second');
    manager.adoptAuthoritativeCallId('call-ag-two', {
      roomId: 'room-ag',
      callEpoch: manager.callEpoch
    });
    const secondEpoch = manager.callEpoch;

    await manager.handleRemoteCallEnded({ roomId: 'room-ag' });

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.callId, 'call-ag-two');
    assert.equal(manager.callEpoch, secondEpoch);
    await manager.endCall(false);
  });

  test('AH. Wrong call ID cannot end call two in the same room', async () => {
    MockRTCPeerConnection.instances = [];
    const manager = new VoiceCallManager({
      rtcBridge: new MockRtcBridge(),
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-ah', 'First');
    manager.adoptAuthoritativeCallId('call-ah-one', {
      roomId: 'room-ah',
      callEpoch: manager.callEpoch
    });
    await manager.endCall(false);

    await manager.startCall('room-ah', 'Second');
    manager.adoptAuthoritativeCallId('call-ah-two', {
      roomId: 'room-ah',
      callEpoch: manager.callEpoch
    });

    await manager.handleRemoteCallEnded({
      roomId: 'room-ah',
      callId: 'call-ah-one'
    });

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.callId, 'call-ah-two');
    await manager.endCall(false);
  });

  test('AI. Current-call legacy hangup with a current source timestamp remains compatible', async () => {
    MockRTCPeerConnection.instances = [];
    const manager = new VoiceCallManager({
      rtcBridge: new MockRtcBridge(),
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-ai', 'First');
    await manager.endCall(false);
    await manager.startCall('room-ai', 'Second');

    await manager.handleRemoteCallEnded({
      roomId: 'room-ai',
      eventTimestamp: manager._callStartEpoch
    });

    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
  });

  test('AJ. Outgoing invitation success is awaited before _inviteSent becomes true', async () => {
    MockRTCPeerConnection.instances = [];
    const signals = [];
    let resolveInvite;
    const inviteGate = new Promise(resolve => {
      resolveInvite = resolve;
    });
    const manager = new VoiceCallManager({
      rtcBridge: new MockRtcBridge(),
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: async signal => {
        signals.push(signal);
        await inviteGate;
        return { ok: true, requestId: 'safe-request' };
      }
    });

    const startup = manager.startCall('room-aj', 'Awaited invite');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(signals[0]?.action, 'invite');
    assert.equal(manager._inviteSent, false);

    resolveInvite();
    await startup;
    assert.equal(manager._inviteSent, true);
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    await manager.endCall(false);
  });

  test('AK. Resolved invitation failure rejects startup, stays unsent, sends no cancel or leave, and cleans resources', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const mediaDevices = new MockMediaDevices();
    const signals = [];
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: async signal => {
        signals.push(signal);
        return { ok: false, code: 'room_socket_absent' };
      }
    });

    await assert.rejects(
      manager.startCall('room-ak', 'Resolved failure'),
      err => err?.code === 'room_socket_absent'
    );

    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.equal(manager._inviteSent, false);
    assert.deepEqual(signals.map(signal => signal.action), ['invite']);
    assert.equal(rtcBridge.leavesSent, 0);
    assert.equal(rtcBridge.disconnectCalls, 1);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager._localStream, null);
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.equal(MockRTCPeerConnection.instances[0].isClosed, true);
  });

  test('AL. Rejected invitation dispatch rethrows the original failure and performs FAILED-to-IDLE cleanup without false cancel', async () => {
    MockRTCPeerConnection.instances = [];
    const rtcBridge = new MockRtcBridge();
    const signals = [];
    const dispatchError = new Error('renderer dispatch rejected');
    dispatchError.code = 'call_signal_ipc_rejected';
    const manager = new VoiceCallManager({
      rtcBridge,
      mediaDevices: new MockMediaDevices(),
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: async signal => {
        signals.push(signal);
        throw dispatchError;
      }
    });

    await assert.rejects(
      manager.startCall('room-al', 'Rejected failure'),
      err => err === dispatchError
    );
    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.equal(manager._inviteSent, false);
    assert.deepEqual(signals.map(signal => signal.action), ['invite']);
    assert.equal(rtcBridge.leavesSent, 0);
    assert.equal(manager.peerConnection, null);

    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(manager.state, CALL_STATE.IDLE);
  });

});
