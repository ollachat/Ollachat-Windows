import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';
import { IncomingCallRingtone } from '../src/call/ringtone.js';

class MockOscillatorNode {
  constructor() {
    this.type = 'sine';
    this.frequency = {
      setValueAtTime: (val) => { this.freqVal = val; }
    };
    this.started = false;
    this.stopped = false;
    this.target = null;
  }
  connect(dest) { this.target = dest; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  disconnect() {}
}

class MockGainNode {
  constructor() {
    this.gain = {
      setValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {}
    };
    this.target = null;
  }
  connect(dest) { this.target = dest; }
  disconnect() {}
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.createdOscillators = [];
  }
  createOscillator() {
    const osc = new MockOscillatorNode();
    this.createdOscillators.push(osc);
    return osc;
  }
  createGain() {
    return new MockGainNode();
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

class MockAudioTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
  }
  stop() { this.stopped = true; }
}

class MockMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks.length > 0 ? tracks : [new MockAudioTrack('audio')];
  }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getTracks() { return this.tracks; }
}

class MockMediaDevices {
  async getUserMedia(constraints) {
    if (constraints?.video) throw new Error('Video requested in voice-only call');
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

  getSenders() { return this.senders; }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=caller-offer\r\n' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=callee-answer\r\n' };
  }

  async setLocalDescription(desc) { this.localDescription = desc; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate() {}

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
  constructor() {
    this.connectCalls = [];
    this.sentOffers = [];
    this.sentAnswers = [];
    this.leavesSent = 0;
    this.disconnectCalls = 0;
    this._eventListeners = new Set();
  }

  async connect(roomId) {
    this.connectCalls.push(roomId);
    return { ok: true, state: 'connected', roomId, iceServers: [] };
  }

  async sendOffer(sdp) {
    this.sentOffers.push(sdp);
    return { ok: true };
  }

  async sendAnswer(sdp, requestId) {
    this.sentAnswers.push({ sdp, requestId });
    return { ok: true };
  }

  async sendCandidate() { return { ok: true }; }
  async leave() { this.leavesSent++; return { ok: true }; }
  async disconnect() { this.disconnectCalls++; return { ok: true }; }

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

function createTestManager(opts = {}) {
  const rtcBridge = opts.rtcBridge || new MockRtcBridge();
  const mediaDevices = opts.mediaDevices || new MockMediaDevices();
  const ringtone = opts.ringtone || new IncomingCallRingtone({ AudioContextClass: MockAudioContext });
  const manager = new VoiceCallManager({
    rtcBridge,
    mediaDevices,
    PeerConnectionClass: MockRTCPeerConnection,
    ringtone,
    ...opts
  });
  return { manager, rtcBridge, mediaDevices, ringtone };
}

describe('Voice Call Lifecycle, Duration Timer & Ringtone Tests (A through R)', () => {

  test('A. Outgoing call does not start timer', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-101', 'Alice');

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.getFormattedDuration(), '00:00');

    await manager.endCall();
  });

  test('B. Incoming ringing does not start timer', () => {
    const { manager } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-102', callId: 'c-102', initiator: 'Bob' });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.getFormattedDuration(), '00:00');
  });

  test('C. Connecting does not start timer', async () => {
    const { manager } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-103', callId: 'c-103', initiator: 'Charlie' });
    await manager.acceptCall();

    assert.equal(manager.state, CALL_STATE.CONNECTING);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);

    await manager.endCall();
  });

  test('D. Connected starts timer at 00:00', async () => {
    const { manager } = createTestManager();
    let ticks = [];
    manager.on('timerTick', (tick) => ticks.push(tick));

    await manager.startCall('room-104', 'David');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];

    assert.equal(manager.durationSec, 0);
    assert.equal(manager.callConnectedAt, null);

    // Callee connects and media track arrives
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt !== null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager.getFormattedDuration(), '00:00');
    assert.ok(ticks.some(t => t.durationSec === 0 && t.formatted === '00:00'));

    await manager.endCall();
  });

  test('E. Timer increments after connection', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-105', 'Eva');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    // Simulate 3 seconds elapsed
    manager.callConnectedAt = Date.now() - 3000;
    manager.durationSec = 3;

    assert.equal(manager.getFormattedDuration(), '00:03');

    // Simulate 65 seconds elapsed
    manager.durationSec = 65;
    assert.equal(manager.getFormattedDuration(), '01:05');

    // Simulate 3665 seconds elapsed (1 hr 1 min 5 sec)
    manager.durationSec = 3665;
    assert.equal(manager.getFormattedDuration(), '01:01:05');

    await manager.endCall();
  });

  test('F. Ended stops timer', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-106', 'Frank');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt !== null);
    assert.ok(manager._timerInterval !== null);

    await manager.endCall();

    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.getFormattedDuration(), '00:00');
  });

  test('G. Remote hangup stops timer', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-107', 'Grace');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager._timerInterval !== null);

    await manager.handleRemoteCallEnded({ roomId: 'room-107' });

    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.getFormattedDuration(), '00:00');
  });

  test('H. Failed call stops timer', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-108', 'Heidi');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    pc.simulateTrack();

    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // Connection failure occurs
    pc.simulateConnectionState('failed');
    await new Promise(r => setTimeout(r, 10));

    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.equal(manager.isEnded, true);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  test('I. Declined call never starts duration timer', () => {
    const { manager } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-109', callId: 'c-109', initiator: 'Ivan' });
    assert.equal(manager.state, CALL_STATE.RINGING);

    manager.declineCall();
    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(manager.isEnded, true);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  test('J. Cancelled call never starts duration timer', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-110', 'Judy');
    assert.equal(manager.state, CALL_STATE.CALLING);

    // Caller hangs up before callee answers
    await manager.endCall();

    assert.equal(manager.state, CALL_STATE.CANCELLED);
    assert.equal(manager.isEnded, true);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  test('K. Repeated CONNECTED events do not create multiple timers', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-111', 'Kevin');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];

    pc.simulateTrack();
    const firstConnectedAt = manager.callConnectedAt;
    const firstTimer = manager._timerInterval;

    assert.ok(firstConnectedAt !== null);
    assert.ok(firstTimer !== null);

    // Duplicate track or state transition
    manager._markConnected();
    manager.startCallDurationTimer();

    assert.equal(manager.callConnectedAt, firstConnectedAt);
    assert.equal(manager._timerInterval, firstTimer);

    await manager.endCall();
  });

  test('L. Cleanup is idempotent', async () => {
    const { manager } = createTestManager();
    await manager.startCall('room-112', 'Leo');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    pc.simulateTrack();

    assert.doesNotThrow(() => {
      manager.stopCallDurationTimer();
      manager.stopCallDurationTimer();
      manager.stopCallDurationTimer();
    });

    await manager.endCall();
    await manager.endCall();
    await manager.endCall();

    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  test('M. Incoming call starts ringtone', () => {
    const { manager, ringtone } = createTestManager();
    assert.equal(ringtone.isPlaying, false);

    manager.handleIncomingCall({ roomId: 'room-113', callId: 'c-113', initiator: 'Mia' });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(ringtone.isPlaying, true);

    manager.declineCall();
  });

  test('N. Accept stops ringtone', async () => {
    const { manager, ringtone } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-114', callId: 'c-114', initiator: 'Noah' });
    assert.equal(ringtone.isPlaying, true);

    await manager.acceptCall();

    assert.equal(manager.state, CALL_STATE.CONNECTING);
    assert.equal(ringtone.isPlaying, false);

    await manager.endCall();
  });

  test('O. Decline stops ringtone', () => {
    const { manager, ringtone } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-115', callId: 'c-115', initiator: 'Olivia' });
    assert.equal(ringtone.isPlaying, true);

    manager.declineCall();

    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(manager.isEnded, true);
    assert.equal(ringtone.isPlaying, false);
  });

  test('P. Caller cancellation stops ringtone', async () => {
    const { manager, ringtone } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-116', callId: 'c-116', initiator: 'Paul' });
    assert.equal(ringtone.isPlaying, true);

    // Remote caller hangs up while ringing
    await manager.handleRemoteCallEnded({ roomId: 'room-116' });

    assert.equal(ringtone.isPlaying, false);
    assert.equal(manager.state, CALL_STATE.REMOTE_CANCELLED);
    assert.equal(manager.isEnded, true);
  });

  test('Q. Remote hangup stops ringtone', async () => {
    const { manager, ringtone } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-117', callId: 'c-117', initiator: 'Quinn' });
    assert.equal(ringtone.isPlaying, true);

    await manager.handleRemoteCallEnded({ roomId: 'room-117' });

    assert.equal(ringtone.isPlaying, false);
    assert.equal(manager.state, CALL_STATE.REMOTE_CANCELLED);
    assert.equal(manager.isEnded, true);
  });

  test('R. Connected stops ringtone', async () => {
    const { manager, ringtone } = createTestManager();
    manager.handleIncomingCall({ roomId: 'room-118', callId: 'c-118', initiator: 'Ruby' });
    assert.equal(ringtone.isPlaying, true);

    // Receiver accepts call: INCOMING_RINGING -> CONNECTING
    await manager.acceptCall();

    // Call reaches CONNECTED
    manager._markConnected();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(ringtone.isPlaying, false);

    await manager.endCall();
  });

});
