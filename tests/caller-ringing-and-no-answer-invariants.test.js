import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

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
  constructor() {
    this.getUserMediaCalls = [];
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    const tracks = [new MockTrack('audio')];
    if (constraints.video) {
      tracks.push(new MockTrack('video'));
    }
    return new MockMediaStream(tracks);
  }
}

class MockRTCPeerConnection {
  static instances = [];

  constructor(config = {}) {
    this.config = config;
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
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n'
    };
  }

  async createAnswer(options = {}) {
    return {
      type: 'answer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n'
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
        track: stream.getVideoTracks()[0] || stream.getAudioTracks()[0]
      });
    }
  }

  simulateState(connState, iceState) {
    if (connState) this.connectionState = connState;
    if (iceState) this.iceConnectionState = iceState;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

class MockRtcBridge {
  constructor() {
    this.connectCalls = [];
    this.sendOfferCalls = [];
    this.sendAnswerCalls = [];
    this.leaveCalls = 0;
    this.disconnectCalls = 0;
    this._eventListeners = [];
  }

  async connect(roomId, options = {}) {
    this.connectCalls.push({ roomId, options });
    return {
      ok: true,
      state: 'connected',
      roomId,
      callType: options.callType || (options.isVideo ? 'video' : 'voice'),
      iceServers: []
    };
  }

  async sendOffer(sdp, options = {}) {
    this.sendOfferCalls.push({ sdp, options });
    return { ok: true };
  }

  async sendAnswer(sdp, requestId) {
    this.sendAnswerCalls.push({ sdp, requestId });
    return { ok: true };
  }

  async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
    return { ok: true };
  }

  async leave() {
    this.leaveCalls++;
    return { ok: true };
  }

  async disconnect() {
    this.disconnectCalls++;
    return { ok: true };
  }

  onEvents(handler) {
    this._eventListeners.push(handler);
    return () => {
      this._eventListeners = this._eventListeners.filter(l => l !== handler);
    };
  }

  emitEvent(event) {
    for (const l of this._eventListeners) {
      l(event);
    }
  }
}

function computeCallUiState(manager) {
  const isVideo = Boolean(manager.isVideo || manager.mode === 'video');
  const state = manager.state;

  const ui = {
    overlayHidden: state === CALL_STATE.IDLE,
    title: '',
    statusText: '',
    avatarIcon: isVideo ? '📹' : '📞',
    cardClass: '',
    showMute: false,
    showCamera: false,
    showEnd: false,
    showAccept: false,
    showDecline: false,
    timerHidden: true,
    timerText: '00:00',
    peerPhoneShown: Boolean(manager.peerPhone && manager.peerPhone !== manager.peerName)
  };

  if (state === CALL_STATE.IDLE) return ui;

  if (isVideo) {
    if (state === CALL_STATE.CONNECTED) ui.cardClass = 'is-video-call';
    else if (state === CALL_STATE.INCOMING_RINGING) ui.cardClass = 'is-incoming-video';
  } else {
    if (state === CALL_STATE.INCOMING_RINGING) ui.cardClass = 'is-incoming-voice';
  }

  switch (state) {
    case CALL_STATE.OUTGOING_RINGING:
      ui.statusText = isVideo ? 'Calling (video)...' : 'Calling...';
      ui.showEnd = true;
      break;
    case CALL_STATE.INCOMING_RINGING:
      ui.statusText = isVideo ? 'Incoming video call' : 'Incoming voice call';
      ui.showAccept = true;
      ui.showDecline = true;
      break;
    case CALL_STATE.CONNECTING:
      ui.statusText = 'Connecting...';
      ui.showEnd = true;
      break;
    case CALL_STATE.CONNECTED:
      ui.statusText = 'Connected';
      ui.showMute = true;
      if (isVideo) ui.showCamera = true;
      ui.showEnd = true;
      ui.timerHidden = false;
      ui.timerText = manager.getFormattedDuration();
      break;
    case CALL_STATE.ENDING:
      ui.statusText = 'Ending call...';
      break;
    case CALL_STATE.DECLINED:
    case CALL_STATE.REMOTE_DECLINED:
      ui.statusText = 'Call declined';
      break;
    case CALL_STATE.CANCELLED:
    case CALL_STATE.REMOTE_CANCELLED:
      ui.statusText = 'Call cancelled';
      break;
    case CALL_STATE.NO_ANSWER:
      ui.statusText = 'No answer';
      break;
  }

  return ui;
}

function createCallerManager(options = {}) {
  const mediaDevices = new MockMediaDevices();
  const rtcBridge = new MockRtcBridge();
  const ringtone = {
    start: () => { ringtone.isPlaying = true; },
    stop: () => { ringtone.isPlaying = false; },
    isPlaying: false
  };

  const manager = new VoiceCallManager({
    rtcBridge,
    mediaDevices,
    PeerConnectionClass: MockRTCPeerConnection,
    ringtone,
    ...options
  });

  return { manager, rtcBridge, mediaDevices, ringtone };
}

describe('Caller Ringing & No-Answer Invariants Test Suite', () => {

  test('1. Caller remains OUTGOING_RINGING while receiver has not accepted', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-1', 'Bob');

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.isCalling, true);
    assert.equal(manager.isConnected, false);

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Calling...');
    assert.equal(ui.timerHidden, true);
    assert.equal(ui.timerText, '00:00');
    assert.equal(ui.showMute, false, 'Mute button must not show during ringing');
    assert.equal(ui.showEnd, true, 'End/Cancel button must show');

    await manager.endCall();
  });

  test('2. Caller does not become CONNECTED from local ICE connection to SFU', async () => {
    MockRTCPeerConnection.instances = [];
    const { manager } = createCallerManager();
    await manager.startCall('room-2', 'Bob');

    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];

    // Simulate ICE completing to SFU while callee has not accepted
    pc.simulateState('connected', 'connected');

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING, 'Must remain OUTGOING_RINGING on ICE connect');
    assert.equal(manager.callConnectedAt, null, 'Timer epoch must remain null');
    assert.equal(manager.durationSec, 0);

    const ui = computeCallUiState(manager);
    assert.equal(ui.timerHidden, true);
    assert.equal(ui.showMute, false);

    await manager.endCall();
  });

  test('3. Caller does not become CONNECTED from RTC WebSocket connection', async () => {
    const { manager, rtcBridge } = createCallerManager();
    await manager.startCall('room-3', 'Bob');

    // Simulate RTC WebSocket connected event
    rtcBridge.emitEvent({ type: 'connected', roomId: 'room-3' });

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.callConnectedAt, null);

    await manager.endCall();
  });

  test('4. Caller does not become CONNECTED from sending the offer or SFU recvonly answer', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-4', 'Bob');

    // Simulate SFU uplink acknowledgment answer (a=recvonly)
    const sfuUplinkAnswerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n';
    await manager._handleIncomingAnswer(sfuUplinkAnswerSdp);

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING, 'Must remain OUTGOING_RINGING after SFU recvonly answer');
    assert.equal(manager.callConnectedAt, null);

    const ui = computeCallUiState(manager);
    assert.equal(ui.timerHidden, true);
    assert.equal(ui.showMute, false);

    await manager.endCall();
  });

  test('5. Caller does not become CONNECTED from local media tracks', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-5', 'Bob');

    assert.ok(manager._localAudioTrack, 'Local audio track attached');
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.callConnectedAt, null);

    await manager.endCall();
  });

  test('6. Caller only becomes CONNECTED after genuine remote answer/accepted negotiation', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-6', 'Bob');
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);

    // Callee accepts: SFU delivers renegotiation offer with active remote media (a=sendrecv)
    const remoteOfferSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
    await manager._handleIncomingOffer(remoteOfferSdp, 42);

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING, 'SDP alone must not transition to CONNECTED');
    assert.equal(manager.callConnectedAt, null, 'SDP alone must not start the duration timer');

    const remoteAudioTrack = new MockTrack('audio');
    manager.peerConnection.simulateTrack(new MockMediaStream([remoteAudioTrack]));

    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Must transition to CONNECTED on live remote media');
    assert.ok(manager.callConnectedAt !== null, 'Duration timer epoch must start on CONNECTED');

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Connected');
    assert.equal(ui.timerHidden, false);
    assert.equal(ui.showMute, true);

    await manager.endCall();
  });

  test('7. Caller timer does not start before CONNECTED', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-7', 'Bob');

    assert.equal(manager.durationSec, 0);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.getFormattedDuration(), '00:00');

    // Simulate 2 seconds while ringing
    await new Promise(r => setTimeout(r, 20));
    assert.equal(manager.durationSec, 0);
    assert.equal(manager.getFormattedDuration(), '00:00');

    await manager.endCall();
  });

  test('8. Voice no-answer scenario terminates after timeout without ever connecting', async () => {
    const { manager } = createCallerManager();
    await manager.startCall('room-8', 'Bob');

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    const states = [];
    manager.on('stateChange', ({ state }) => states.push(state));

    // Force 30s timeout trigger using _startRingingTimer with small duration
    manager._startRingingTimer(30);

    await new Promise(r => setTimeout(r, 60));

    assert.equal(states.includes(CALL_STATE.CONNECTED), false, 'Caller must NEVER enter CONNECTED in no-answer scenario');
    assert.equal(states.includes(CALL_STATE.NO_ANSWER), true, 'Caller transitions to NO_ANSWER');
    assert.equal(manager.callConnectedAt, null, 'Call timer must never have started');
  });

  test('9. Video no-answer scenario terminates after timeout without ever connecting', async () => {
    const { manager } = createCallerManager();
    await manager.startVideoCall('room-9', 'Bob');

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.ok(manager._localVideoTrack);

    const states = [];
    manager.on('stateChange', ({ state }) => states.push(state));

    // Force 30s timeout trigger with small duration
    manager._startRingingTimer(30);

    await new Promise(r => setTimeout(r, 60));

    assert.equal(states.includes(CALL_STATE.CONNECTED), false, 'Video caller must NEVER enter CONNECTED in no-answer scenario');
    assert.equal(states.includes(CALL_STATE.NO_ANSWER), true, 'Video caller transitions to NO_ANSWER');
    assert.equal(manager.callConnectedAt, null, 'Call timer must never have started');
  });

  test('10. Existing accepted voice call transitions OUTGOING_RINGING → CONNECTING → CONNECTED', async () => {
    const { manager: caller } = createCallerManager();
    const { manager: callee } = createCallerManager();

    await caller.startCall('room-10', 'Bob');
    callee.handleIncomingCall({ roomId: 'room-10', callId: 'c10', initiator: 'Alice', isVideo: false, callType: 'voice', peerName: 'Alice' });

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(callee.state, CALL_STATE.INCOMING_RINGING);

    // Callee accepts
    await callee.acceptCall();
    assert.equal(callee.state, CALL_STATE.CONNECTING);

    // Caller receives genuine remote answer with active audio (a=sendrecv)
    const remoteAnswerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
    await caller._handleIncomingAnswer(remoteAnswerSdp);

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING, 'SDP answer alone must leave the caller ringing');
    assert.equal(caller.callConnectedAt, null);

    const remoteAudioTrack = new MockTrack('audio');
    caller.peerConnection.simulateTrack(new MockMediaStream([remoteAudioTrack]));

    assert.equal(caller.state, CALL_STATE.CONNECTED);
    assert.ok(caller.callConnectedAt !== null);

    const callerUi = computeCallUiState(caller);
    assert.equal(callerUi.statusText, 'Connected');
    assert.equal(callerUi.timerHidden, false);
    assert.equal(callerUi.showMute, true);

    await caller.endCall();
    await callee.endCall();
  });

  test('11. Existing accepted video call transitions OUTGOING_RINGING → CONNECTING → CONNECTED', async () => {
    const { manager: caller } = createCallerManager();
    const { manager: callee } = createCallerManager();

    await caller.startVideoCall('room-11', 'Bob');
    callee.handleIncomingCall({ roomId: 'room-11', callId: 'c11', initiator: 'Alice', isVideo: true, callType: 'video', peerName: 'Alice' });

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(caller.isVideo, true);
    assert.equal(callee.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(callee.isVideo, true);

    // Callee accepts
    await callee.acceptCall();
    assert.equal(callee.state, CALL_STATE.CONNECTING);

    // Caller receives remote renegotiation offer with active video
    const remoteVideoOffer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n';
    await caller._handleIncomingOffer(remoteVideoOffer, 99);

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING, 'SDP offer alone must leave the caller ringing');
    assert.equal(caller.callConnectedAt, null);

    const remoteVideoTrack = new MockTrack('video');
    caller.peerConnection.simulateTrack(new MockMediaStream([remoteVideoTrack]));

    assert.equal(caller.state, CALL_STATE.CONNECTED);
    assert.equal(caller.isVideo, true);
    assert.ok(caller.callConnectedAt !== null);

    const callerUi = computeCallUiState(caller);
    assert.equal(callerUi.statusText, 'Connected');
    assert.equal(callerUi.cardClass, 'is-video-call');
    assert.equal(callerUi.showCamera, true);
    assert.equal(callerUi.showMute, true);

    await caller.endCall();
    await callee.endCall();
  });

  test('12. Existing decline/cancel/hangup behavior still works cleanly', async () => {
    // 12a. Caller cancels while ringing
    {
      const { manager } = createCallerManager();
      await manager.startCall('room-12a', 'Bob');
      assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);

      await manager.endCall();
      assert.equal(manager.state, CALL_STATE.CANCELLED);
      assert.equal(manager.callConnectedAt, null);
    }

    // 12b. Callee declines incoming call
    {
      const { manager, rtcBridge } = createCallerManager();
      manager.handleIncomingCall({ roomId: 'room-12b', callId: 'c12b', initiator: 'Alice' });
      assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

      await manager.declineCall();
      assert.equal(manager.state, CALL_STATE.DECLINED);
      assert.equal(manager.callConnectedAt, null);
    }

    // 12c. Normal hangup after connect
    {
      const { manager } = createCallerManager();
      await manager.startCall('room-12c', 'Bob');
      await manager._handleIncomingOffer('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n', 1);
      assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING, 'SDP offer alone must not connect the call');

      const remoteAudioTrack = new MockTrack('audio');
      manager.peerConnection.simulateTrack(new MockMediaStream([remoteAudioTrack]));
      assert.equal(manager.state, CALL_STATE.CONNECTED);

      await manager.endCall();
      assert.equal(manager.state, CALL_STATE.ENDED);
      assert.equal(manager.durationSec, 0);
    }
  });

});
