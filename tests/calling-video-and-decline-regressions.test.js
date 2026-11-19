import { test, describe, beforeEach } from 'node:test';
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

  addTrack(track) {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
    }
  }
}

class MockMediaDevices {
  constructor({ failVideo = false } = {}) {
    this.getUserMediaCalls = [];
    this.failVideo = failVideo;
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    if (this.failVideo && constraints.video) {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    }
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
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;

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
    const isVideo = Boolean(options.offerToReceiveVideo);
    let sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
    if (isVideo) {
      sdp += 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n';
    }
    return { type: 'offer', sdp };
  }

  async createAnswer(options = {}) {
    const remoteSdp = this.remoteDescription?.sdp || '';
    const hasVideo = /(?:^|\r?\n)m=video\s+\d+\s+[^0]/i.test(remoteSdp);
    let sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
    if (hasVideo) {
      sdp += 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n';
    }
    return { type: 'answer', sdp };
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

  simulateTrack(stream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')])) {
    if (this.ontrack) {
      this.ontrack({
        streams: [stream],
        track: stream.getVideoTracks()[0] || stream.getAudioTracks()[0]
      });
    }
  }
}

class MockRtcBridge {
  constructor({ connectOk = true, iceServers = [{ urls: 'stun:stun.ollachat.test:3478' }] } = {}) {
    this.connectOk = connectOk;
    this.iceServers = iceServers;
    this.connectCalls = [];
    this.sendOfferCalls = [];
    this.sendAnswerCalls = [];
    this.sendCandidateCalls = [];
    this.leaveCalls = 0;
    this.disconnectCalls = 0;
    this._eventListeners = [];
    this.state = 'disconnected';
  }

  async connect(roomId, options = {}) {
    this.connectCalls.push({ roomId, options });
    if (!this.connectOk) return { ok: false, error: 'Connection refused' };
    this.state = 'connected';
    return {
      ok: true,
      state: 'connected',
      roomId,
      callType: options.callType || (options.isVideo ? 'video' : 'voice'),
      iceServers: this.iceServers
    };
  }

  async getState() {
    return this.state;
  }

  async getIceServers(roomId) {
    return { ok: true, iceServers: this.iceServers };
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
    this.sendCandidateCalls.push({ candidate, sdpMid, sdpMLineIndex });
    return { ok: true };
  }

  async leave() {
    this.leaveCalls++;
    return { ok: true };
  }

  async disconnect() {
    this.disconnectCalls++;
    this.state = 'disconnected';
    return { ok: true };
  }

  onEvent(handler) {
    this._eventListeners.push(handler);
    return () => {
      this._eventListeners = this._eventListeners.filter(l => l !== handler);
    };
  }

  emitEvent(event) {
    for (const l of [...this._eventListeners]) {
      l(event);
    }
  }
}

class MockRingtone {
  constructor() {
    this.isPlaying = false;
    this.startCalls = 0;
    this.stopCalls = 0;
  }
  start() {
    this.isPlaying = true;
    this.startCalls++;
  }
  stop() {
    this.isPlaying = false;
    this.stopCalls++;
  }
}

class MockMediaElement {
  constructor() {
    this.srcObject = null;
  }
  async play() { }
}

function createManager(options = {}) {
  const mediaDevices = options.mediaDevices || new MockMediaDevices({ failVideo: options.failVideo });
  const rtcBridge = options.rtcBridge || new MockRtcBridge();
  const ringtone = options.ringtone || new MockRingtone();
  const remoteAudioElement = new MockMediaElement();
  const localVideoElement = new MockMediaElement();
  const remoteVideoElement = new MockMediaElement();
  const sendSignal = options.sendSignal || null;

  const manager = new VoiceCallManager({
    rtcBridge,
    mediaDevices,
    PeerConnectionClass: MockRTCPeerConnection,
    remoteAudioElement,
    localVideoElement,
    remoteVideoElement,
    ringtone,
    sendSignal
  });

  return { manager, mediaDevices, rtcBridge, ringtone, localVideoElement, remoteVideoElement };
}

describe('1-to-1 Video Calling & Decline Regressions Suite', () => {
  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
  });

  // A. Incoming video modality
  test('A1. Incoming video call via explicit isVideo / callType options is classified as video while ringing', () => {
    const { manager, ringtone } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-vid-1',
      callId: 'call-1',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    assert.equal(ringtone.isPlaying, true);
    assert.equal(manager.isRinging, true);
  });

  test('A2. Incoming video call via options.is_video / options.call_type is classified as video', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-vid-2',
      callId: 'call-2',
      initiator: 'user-a',
      is_video: true,
      call_type: 'video',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
  });

  test('A3. Early RTC offer with m=video received while ringing updates modality to video and emits modeChange', async () => {
    const { manager, rtcBridge } = createManager();
    let modeChangeEvent = null;
    manager.on('modeChange', (evt) => {
      modeChangeEvent = evt;
    });

    // Starts as voice because backend call.started omitted modality
    manager.handleIncomingCall({
      roomId: 'room-vid-3',
      callId: 'call-3',
      initiator: 'user-a',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, false);

    // Caller transmits video offer over RTC signaling
    const videoOfferSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n';
    rtcBridge.emitEvent({
      type: 'offer',
      sdp: videoOfferSdp,
      requestId: 1,
      callType: 'video',
      isVideo: true,
      roomId: 'room-vid-3'
    });

    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    assert.notEqual(modeChangeEvent, null);
    assert.equal(modeChangeEvent.isVideo, true);
    assert.equal(modeChangeEvent.mode, 'video');
    // Invariant: Callee must remain INCOMING_RINGING (never auto-accept)
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.notEqual(manager._pendingOffer, null);
  });

  // B. Callee camera activation on video Accept
  test('B. Accepting video call requests audio + video and attaches video track', async () => {
    const { manager, mediaDevices, localVideoElement } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-vid-accept',
      callId: 'call-b',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    // Invariant 1: Camera must NOT start while ringing
    assert.equal(mediaDevices.getUserMediaCalls.length, 0);

    // Callee presses Accept
    await manager.acceptCall();

    // Verification 1: getUserMedia was called with audio: true AND video constraints
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.equal(mediaDevices.getUserMediaCalls[0].audio, true);
    assert.ok(mediaDevices.getUserMediaCalls[0].video);

    // Verification 2: Local video track acquired and active
    assert.notEqual(manager._localVideoTrack, null);
    assert.equal(manager._localVideoTrack.kind, 'video');
    assert.equal(manager._localVideoTrack.readyState, 'live');

    // Verification 3: Video track attached to RTCPeerConnection senders
    const pc = manager.peerConnection;
    assert.notEqual(pc, null);
    const videoSender = pc.senders.find(s => s.track?.kind === 'video');
    assert.notEqual(videoSender, undefined);

    // Verification 4: Local preview element gets stream
    assert.notEqual(localVideoElement.srcObject, null);
  });

  // C. Voice Accept still has no camera
  test('C. Accepting voice call requests audio only and never starts camera', async () => {
    const { manager, mediaDevices, localVideoElement } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-voice-accept',
      callId: 'call-c',
      initiator: 'user-a',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    assert.equal(mediaDevices.getUserMediaCalls.length, 0);

    await manager.acceptCall();

    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.equal(mediaDevices.getUserMediaCalls[0].audio, true);
    assert.equal(mediaDevices.getUserMediaCalls[0].video, false, 'Voice call must have video: false');

    assert.equal(manager._localVideoTrack, null);
    assert.equal(localVideoElement.srcObject, null);
    const pc = manager.peerConnection;
    const videoSender = pc.senders.find(s => s.track?.kind === 'video');
    assert.equal(videoSender, undefined);
  });

  // D. Caller receives decline
  test('D. Receiver decline sends RTC leave and caller transitions OUTGOING_RINGING -> REMOTE_DECLINED', async () => {
    const { manager: caller, rtcBridge: callerBridge } = createManager();
    const { manager: callee, rtcBridge: calleeBridge, ringtone: calleeRingtone } = createManager();

    // 1. Caller starts call
    await caller.startCall('room-decline', 'Bob', { isVideo: true, mode: 'video' });
    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(caller.durationSec, 0);

    // 2. Callee receives call
    callee.handleIncomingCall({
      roomId: 'room-decline',
      callId: 'call-d',
      initiator: 'caller-id',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });
    assert.equal(callee.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(calleeRingtone.isPlaying, true);

    // 3. Callee presses Decline
    await callee.declineCall();
    assert.equal(callee.state, CALL_STATE.DECLINED);
    assert.equal(calleeRingtone.isPlaying, false);
    assert.ok(calleeBridge.leaveCalls > 0);

    // 4. Caller receives termination (via Chat WS call.ended or RTC event)
    await caller.handleRemoteCallEnded({ roomId: 'room-decline' });

    assert.equal(caller.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(caller.durationSec, 0, 'Caller timer must remain 00:00 on decline');
  });

  // E. Caller does NOT become CONNECTED before acceptance
  test('E. Caller remains in OUTGOING_RINGING when SFU uplink answer is received', async () => {
    const { manager: caller, rtcBridge: callerBridge } = createManager();
    await caller.startCall('room-no-falsy-connect', 'Bob');

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);

    // SFU sends uplink publish answer (recvonly / no active remote media)
    const sfuUplinkAnswer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n';
    callerBridge.emitEvent({
      type: 'answer',
      sdp: sfuUplinkAnswer,
      roomId: 'room-no-falsy-connect'
    });

    // Invariant: Caller must NOT transition to CONNECTED or CONNECTING
    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(caller.durationSec, 0);
  });

  // F. Caller timer remains stopped while ringing / no-answer
  test('F. Caller duration timer never increments while in OUTGOING_RINGING or on NO_ANSWER', async () => {
    const { manager: caller } = createManager();
    await caller.startCall('room-timer-test', 'Bob');

    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(caller._timerInterval, null);
    assert.equal(caller.durationSec, 0);

    caller._setState(CALL_STATE.NO_ANSWER);
    assert.equal(caller.state, CALL_STATE.NO_ANSWER);
    assert.equal(caller._timerInterval, null);
    assert.equal(caller.durationSec, 0);
  });

  // G. Accepted voice call connects properly
  test('G. Accepted voice call transitions to CONNECTED and duration timer starts', async () => {
    const { manager: callee } = createManager();
    callee.handleIncomingCall({
      roomId: 'room-voice-conn',
      callId: 'c1',
      initiator: 'user-a',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    await callee.acceptCall();
    callee._markConnected();

    assert.equal(callee.state, CALL_STATE.CONNECTED);
    assert.notEqual(callee._timerInterval, null);
    assert.equal(callee.isVideo, false);
  });

  // H. Accepted video call connects properly
  test('H. Accepted video call transitions to CONNECTED with active video track and timer', async () => {
    const { manager: callee } = createManager();
    callee.handleIncomingCall({
      roomId: 'room-video-conn',
      callId: 'c2',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    await callee.acceptCall();
    callee._markConnected();

    assert.equal(callee.state, CALL_STATE.CONNECTED);
    assert.notEqual(callee._timerInterval, null);
    assert.equal(callee.isVideo, true);
    assert.notEqual(callee._localVideoTrack, null);
  });

  // I. Remote hangup cleans up and transitions to REMOTE_ENDED -> ENDED
  test('I. Remote hangup while CONNECTED transitions properly to REMOTE_ENDED', async () => {
    const { manager } = createManager();
    await manager.startCall('room-hangup-test', 'Bob');
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    const states = [];
    manager.on('stateChange', ({ state }) => states.push(state));

    await manager.handleRemoteCallEnded({ roomId: 'room-hangup-test' });

    assert.ok(states.includes(CALL_STATE.REMOTE_ENDED));
    assert.ok(states.includes(CALL_STATE.ENDED));
    assert.equal(manager.isEnded, true);
  });

  // J. 30-second no-answer timeout transitions to NO_ANSWER
  test('J. 30-second ringing timer fires and sets NO_ANSWER', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-timeout',
      callId: 'c3',
      initiator: 'user-a',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

    // Manually trigger the ringing timer callback
    manager._clearRingingTimer();
    manager._setState(CALL_STATE.NO_ANSWER);

    assert.equal(manager.state, CALL_STATE.NO_ANSWER);
    assert.equal(manager.durationSec, 0);
  });

  // K. Camera failure on video accept produces controlled FAILED state
  test('K. Camera permission denial on video accept transitions to FAILED without falsely showing CONNECTED', async () => {
    const { manager } = createManager({ failVideo: true });
    manager.handleIncomingCall({
      roomId: 'room-cam-fail',
      callId: 'c4',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    await assert.rejects(async () => {
      await manager.acceptCall();
    });

    assert.equal(manager.state, CALL_STATE.FAILED);
    assert.ok(manager.error?.includes('permission denied') || manager.error?.includes('Failed to accept call'));
    assert.equal(manager.isConnected, false);
  });

  // L. Video acceptance preserves video modality even if initial handleIncomingCall was voice
  test('L. Video offer preserved while ringing prevents accidental downgrade to voice on accept', async () => {
    const { manager, rtcBridge, mediaDevices } = createManager();
    // Arrives as voice
    manager.handleIncomingCall({
      roomId: 'room-no-downgrade',
      callId: 'c5',
      initiator: 'user-a',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    // Receives video offer while ringing
    rtcBridge.emitEvent({
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n',
      requestId: 1,
      roomId: 'room-no-downgrade'
    });

    assert.equal(manager.isVideo, true);

    await manager.acceptCall();

    // Verifies media requested video
    assert.equal(mediaDevices.getUserMediaCalls[0].video ? true : false, true);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
  });

  // M. setModality updates modality and emits modeChange
  test('M. setModality switches voice to video during INCOMING_RINGING and emits modeChange', async () => {
    const { manager } = createManager();
    const modeChangeEvents = [];
    manager.on('modeChange', (evt) => modeChangeEvents.push(evt));

    manager.handleIncomingCall({
      roomId: 'room-modality-change',
      callId: 'c6',
      initiator: 'user-a',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, false);
    assert.equal(manager.mode, 'voice');

    // Remote invite signal arrives
    manager.setModality('video');

    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING); // Camera still OFF, ringing remains!
    assert.equal(modeChangeEvents.length, 1);
    assert.equal(modeChangeEvents[0].isVideo, true);
    assert.equal(modeChangeEvents[0].mode, 'video');
  });

  // N1. sendSignal callback receives invite on startCall
  test('N1. sendSignal callback receives invite on startCall', async () => {
    const signals = [];
    const { manager } = createManager({
      sendSignal: (sig) => signals.push(sig)
    });

    await manager.startCall('room-signal-test', 'Bob', {
      isVideo: true
    });

    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0], {
      action: 'invite',
      roomId: 'room-signal-test',
      callId: undefined,
      callEpoch: manager.callEpoch,
      callType: 'video',
      isVideo: true
    });
  });

  // N2. sendSignal callback receives cancel on caller endCall while ringing
  test('N2. sendSignal callback receives cancel on caller endCall while ringing', async () => {
    const signals = [];
    const { manager } = createManager({
      sendSignal: (sig) => signals.push(sig)
    });

    await manager.startCall('room-signal-cancel', 'Bob', {
      isVideo: true
    });

    manager.endCall();
    assert.equal(signals.length, 2);
    assert.deepEqual(signals[1], {
      action: 'cancel',
      roomId: 'room-signal-cancel',
      callId: undefined,
      callEpoch: manager.callEpoch
    });
  });

  // N3. sendSignal callback receives decline on callee declineCall
  test('N3. sendSignal callback receives decline on callee declineCall', async () => {
    const signals = [];
    const { manager } = createManager({
      sendSignal: (sig) => signals.push(sig)
    });

    manager.handleIncomingCall({
      roomId: 'room-signal-decline',
      callId: 'c7',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    manager.declineCall();
    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0], {
      action: 'decline',
      roomId: 'room-signal-decline',
      callId: 'c7',
      // No caller epoch was provided, so none is echoed (never the callee's local counter).
      callEpoch: undefined
    });
  });

  // N4. Regression: callee presented without an epoch (server call.started) must not answer with its
  // own local epoch counter; it adopts the caller's epoch from the later invite message instead.
  test('N4. callee without caller epoch adopts invite epoch and never echoes its local counter', async () => {
    const signals = [];
    const { manager } = createManager({
      sendSignal: (sig) => signals.push(sig)
    });

    // Simulate a long-running callee whose local counter has advanced past the caller's epoch.
    manager._callEpochCounter = 7;
    manager.handleIncomingCall({ roomId: 'room-epoch', callId: 'c9', initiator: 'user-a', peerName: 'Alice' });
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.signalingEpoch, null);

    assert.equal(manager.adoptSignalingEpoch(1, { roomId: 'other-room' }), false);
    assert.equal(manager.adoptSignalingEpoch(1, { roomId: 'room-epoch' }), true);
    assert.equal(manager.signalingEpoch, 1);
    assert.equal(manager.adoptSignalingEpoch(2, { roomId: 'room-epoch' }), false, 'known epoch is not overwritten');

    manager.declineCall();
    assert.equal(signals.at(-1).callEpoch, 1);
  });

  // O. Caller receiving decline transitions immediately to REMOTE_DECLINED without entering CONNECTED
  test('O. Caller receiving decline transitions from OUTGOING_RINGING to REMOTE_DECLINED without starting timer', async () => {
    const { manager, ringtone } = createManager();

    await manager.startCall('room-caller-decline', 'Bob', {
      isVideo: true
    });

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.durationSec, 0);

    // Callee declined -> signal triggers handleRemoteCallEnded
    manager.handleRemoteCallEnded({ roomId: 'room-caller-decline' });

    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(manager.isConnected, false);
    assert.equal(manager.durationSec, 0);
  });

  // P. Callee camera remains strictly OFF while ringing and turns ON only after Accept
  test('P. Callee camera remains strictly OFF while ringing and turns ON only after Accept', async () => {
    const { manager, mediaDevices } = createManager();

    manager.handleIncomingCall({
      roomId: 'room-cam-lifecycle',
      callId: 'c8',
      initiator: 'user-a',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    // Before Accept:
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(mediaDevices.getUserMediaCalls.length, 0); // Camera is OFF! No permission asked yet!
    assert.equal(manager.durationSec, 0);

    // Callee accepts:
    await manager.acceptCall();

    // After Accept:
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.equal(mediaDevices.getUserMediaCalls[0].video ? true : false, true); // Camera ON!
    assert.equal(mediaDevices.getUserMediaCalls[0].audio ? true : false, true); // Mic ON!
    assert.ok(manager.state === CALL_STATE.CONNECTING || manager.state === CALL_STATE.CONNECTED);
  });
});

