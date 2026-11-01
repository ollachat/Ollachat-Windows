import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockTrack {
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
  constructor({ shouldDeny = false, denyVideoOnly = false } = {}) {
    this.shouldDeny = shouldDeny;
    this.denyVideoOnly = denyVideoOnly;
    this.getUserMediaCalls = [];
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    if (this.shouldDeny || (this.denyVideoOnly && constraints.video)) {
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
    this.lastCreateOfferOptions = options;
    return {
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
    };
  }

  async createAnswer(options = {}) {
    this.lastCreateAnswerOptions = options;
    return {
      type: 'answer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
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

  simulateTrack(stream) {
    if (this.ontrack) {
      this.ontrack({
        streams: [stream],
        track: stream.getVideoTracks()[0] || stream.getAudioTracks()[0]
      });
    }
  }

  simulateIceState(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) {
      this.oniceconnectionstatechange();
    }
  }

  simulateConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
  }
}

class MockRtcBridge {
  constructor({ connectOk = true, connectError = null, iceServers = [{ urls: 'stun:stun.ollachat.test:3478' }] } = {}) {
    this.connectOk = connectOk;
    this.connectError = connectError;
    this.iceServers = iceServers;
    this.connectCalls = [];
    this.sendOfferCalls = [];
    this.sendAnswerCalls = [];
    this.sendCandidateCalls = [];
    this.leaveCalls = 0;
    this.disconnectCalls = 0;
    this._eventListeners = [];
  }

  async connect(roomId, options = {}) {
    this.connectCalls.push({ roomId, options });
    if (!this.connectOk) {
      return { ok: false, error: this.connectError || 'Connection refused' };
    }
    return {
      ok: true,
      state: 'connected',
      roomId,
      callType: options.callType || (options.isVideo ? 'video' : 'voice'),
      iceServers: this.iceServers
    };
  }

  async sendOffer(sdp) {
    this.sendOfferCalls.push(sdp);
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
    return { ok: true };
  }

  onEvent(callback) {
    this._eventListeners.push(callback);
    return () => {
      const idx = this._eventListeners.indexOf(callback);
      if (idx !== -1) this._eventListeners.splice(idx, 1);
    };
  }

  simulateEvent(eventData) {
    for (const cb of this._eventListeners) {
      cb(eventData);
    }
  }
}

class MockRingtone {
  constructor() {
    this.startCalls = 0;
    this.stopCalls = 0;
    this.isPlaying = false;
  }

  start() {
    this.startCalls++;
    this.isPlaying = true;
  }

  stop() {
    this.stopCalls++;
    this.isPlaying = false;
  }
}

class MockMediaElement {
  constructor() {
    this.srcObject = null;
    this.playCalls = 0;
  }

  async play() {
    this.playCalls++;
  }
}

describe('VideoCallManager & Video Calling Architecture', () => {

  // Test 1: Voice call still requests audio only
  test('1. Voice call still requests audio only ({ audio: true, video: false })', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-voice-1', 'Alice');

    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: false });
    assert.equal(manager.isVideo, false);
    assert.equal(manager.mode, 'voice');
    await manager.endCall(false);
  });

  // Test 2: Video call requests audio + video
  test('2. Video call requests audio + video ({ audio: true, video: true })', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-1', 'Bob');

    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: true });
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    await manager.endCall(false);
  });

  // Test 3: Camera permission handling (allowed)
  test('3. Camera permission handling successfully acquires stream with audio and video tracks', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-perm', 'Charlie');

    assert.ok(manager._localStream);
    assert.ok(manager._localAudioTrack);
    assert.ok(manager._localVideoTrack);
    assert.equal(manager._localVideoTrack.kind, 'video');
    await manager.endCall(false);
  });

  // Test 4: Camera denial cleanup
  test('4. Camera denial cleanup sets FAILED state and cleans up partially created call', async () => {
    const mediaDevices = new MockMediaDevices({ shouldDeny: true });
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await assert.rejects(
      async () => manager.startVideoCall('room-video-denied', 'Dave'),
      /Camera \/ microphone permission denied/i
    );

    assert.equal(manager.peerConnection, null);
    assert.equal(manager._localStream, null);
    assert.equal(manager._localAudioTrack, null);
    assert.equal(manager._localVideoTrack, null);
  });

  // Test 5: Local video track creation
  test('5. Local video track creation attaches video track to RTCPeerConnection senders', async () => {
    MockRTCPeerConnection.instances = [];
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-track', 'Eve');

    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
    const senders = pc.getSenders();
    assert.equal(senders.length, 2);
    const hasAudioSender = senders.some(s => s.track.kind === 'audio');
    const hasVideoSender = senders.some(s => s.track.kind === 'video');
    assert.ok(hasAudioSender);
    assert.ok(hasVideoSender);
    await manager.endCall(false);
  });

  // Test 6: Remote video track handling
  test('6. Remote video track handling receives remote stream and marks call connected', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const remoteVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      remoteVideoElement: remoteVideoEl
    });

    await manager.startVideoCall('room-video-remote', 'Frank');
    assert.equal(manager.state, CALL_STATE.CALLING);

    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(manager._remoteStream, remoteStream);
    await manager.endCall(false);
  });

  // Test 7: Local video preview binding
  test('7. Local video preview binding attaches local stream to localVideoElement', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const localVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      localVideoElement: localVideoEl
    });

    await manager.startVideoCall('room-local-preview', 'Grace');

    assert.equal(localVideoEl.srcObject, manager._localStream);
    assert.ok(localVideoEl.playCalls > 0);
    await manager.endCall(false);
  });

  // Test 8: Remote video binding
  test('8. Remote video binding attaches remote stream to remoteVideoElement upon track event', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const remoteVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      remoteVideoElement: remoteVideoEl
    });

    await manager.startVideoCall('room-remote-binding', 'Heidi');
    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(remoteVideoEl.srcObject, remoteStream);
    assert.ok(remoteVideoEl.playCalls > 0);
    await manager.endCall(false);
  });

  // Test 9: Camera toggle OFF
  test('9. Camera toggle OFF disables video track locally without closing PeerConnection', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-cam-off', 'Ivan');
    assert.equal(manager._localVideoTrack.enabled, true);
    assert.equal(manager.isCameraOff, false);

    let emittedEvent = null;
    manager.on('cameraChange', (ev) => { emittedEvent = ev; });

    const isOff = manager.toggleCamera();
    assert.equal(isOff, true);
    assert.equal(manager.isCameraOff, true);
    assert.equal(manager._localVideoTrack.enabled, false);
    assert.deepEqual(emittedEvent, { isCameraOff: true });
    assert.equal(manager.peerConnection.isClosed, false);
    await manager.endCall(false);
  });

  // Test 10: Camera toggle ON
  test('10. Camera toggle ON re-enables video track locally', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-cam-on', 'Judy');
    manager.toggleCamera(); // off
    assert.equal(manager._localVideoTrack.enabled, false);

    const isOffAgain = manager.toggleCamera(); // on
    assert.equal(isOffAgain, false);
    assert.equal(manager.isCameraOff, false);
    assert.equal(manager._localVideoTrack.enabled, true);
    await manager.endCall(false);
  });

  // Test 11: Microphone mute still works in video mode
  test('11. Microphone mute still works during video calls', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-mic-mute-video', 'Mallory');
    assert.equal(manager.isMuted, false);
    assert.equal(manager._localAudioTrack.enabled, true);

    manager.toggleMute();
    assert.equal(manager.isMuted, true);
    assert.equal(manager._localAudioTrack.enabled, false);

    manager.toggleMute();
    assert.equal(manager.isMuted, false);
    assert.equal(manager._localAudioTrack.enabled, true);
    await manager.endCall(false);
  });

  // Test 12: Video call timer does not start during ringing
  test('12. Video call timer does not start during incoming ringing state', () => {
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({ ringtone });

    manager.handleIncomingCall({
      roomId: 'room-vid-timer-ring',
      callId: 'call-1',
      initiator: 'Trent',
      isVideo: true,
      callType: 'video'
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  // Test 13: Video call timer does not start during connecting
  test('13. Video call timer does not start during connecting state', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      ringtone,
      PeerConnectionClass: MockRTCPeerConnection
    });

    manager.handleIncomingCall({
      roomId: 'room-vid-timer-conn',
      callId: 'call-2',
      initiator: 'Peggy',
      isVideo: true
    });

    await manager.acceptCall();
    assert.equal(manager.state, CALL_STATE.CONNECTING);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
    await manager.endCall(false);
  });

  // Test 14: Video call timer starts at 00:00 on connected
  test('14. Video call timer starts at 00:00 strictly upon CONNECTED state', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      ringtone,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-vid-timer-conn2', 'Victor');
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager._timerInterval, null);

    let ticks = [];
    manager.on('timerTick', (ev) => { ticks.push(ev); });

    // Simulate remote video track arrival -> transition to CONNECTED
    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt > 0);
    assert.ok(ticks.length > 0);
    assert.equal(ticks[0].formatted, '00:00');
    assert.equal(ticks[0].durationSec, 0);
    await manager.endCall(false);
  });

  // Test 15: Video call timer stops on hangup
  test('15. Video call timer stops and resets on hangup', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-vid-hangup-timer', 'Walter');
    manager.peerConnection.simulateTrack(new MockMediaStream());
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    await manager.endCall(false);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  // Test 16: Ringtone starts for incoming video call
  test('16. Ringtone starts for incoming video call', () => {
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({ ringtone });

    manager.handleIncomingCall({
      roomId: 'room-ringtone-vid',
      callId: 'call-rt',
      initiator: 'Sybil',
      isVideo: true
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(ringtone.startCalls, 1);
    assert.equal(ringtone.isPlaying, true);
  });

  // Test 17: Ringtone stops on accept
  test('17. Ringtone stops on accepting incoming video call', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      ringtone,
      PeerConnectionClass: MockRTCPeerConnection
    });

    manager.handleIncomingCall({
      roomId: 'room-ringtone-accept',
      callId: 'call-acc',
      initiator: 'Niaj',
      isVideo: true
    });
    assert.equal(ringtone.isPlaying, true);

    await manager.acceptCall();
    assert.equal(ringtone.isPlaying, false);
    assert.ok(ringtone.stopCalls >= 1);
    await manager.endCall(false);
  });

  // Test 18: Ringtone stops on decline
  test('18. Ringtone stops on declining incoming video call', () => {
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({ ringtone });

    manager.handleIncomingCall({
      roomId: 'room-ringtone-decline',
      callId: 'call-dec',
      initiator: 'Olivia',
      isVideo: true
    });
    assert.equal(ringtone.isPlaying, true);

    manager.declineCall();
    assert.equal(ringtone.isPlaying, false);
    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(manager.isEnded, true);
  });

  // Test 19: Ringtone stops on remote hangup during ringing
  test('19. Ringtone stops on remote call ended during ringing', async () => {
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({ ringtone });

    manager.handleIncomingCall({
      roomId: 'room-ringtone-hangup',
      callId: 'call-hup',
      initiator: 'Oscar',
      isVideo: true
    });
    assert.equal(ringtone.isPlaying, true);

    await manager.handleRemoteCallEnded({ roomId: 'room-ringtone-hangup' });
    assert.equal(ringtone.isPlaying, false);
  });

  // Test 20: Cleanup is idempotent
  test('20. Call cleanup is fully idempotent and safe to call multiple times', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const localVideoEl = new MockMediaElement();
    const remoteVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      localVideoElement: localVideoEl,
      remoteVideoElement: remoteVideoEl
    });

    await manager.startVideoCall('room-idempotent-cleanup', 'Paul');
    assert.ok(manager.peerConnection);

    await manager.endCall(true);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager._localStream, null);
    assert.equal(localVideoEl.srcObject, null);
    assert.equal(remoteVideoEl.srcObject, null);

    // Second call to endCall should be a no-op and not throw
    await manager.endCall(true);
    assert.equal(manager.peerConnection, null);
  });

  // Test 21: RTC WebSocket signaling remains correct for video
  test('21. RTC WebSocket signaling passes isVideo and video SDP offers', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-rtc-video-sig', 'Quinn');

    assert.equal(rtcBridge.connectCalls.length, 1);
    assert.deepEqual(rtcBridge.connectCalls[0].options, { isVideo: true, callType: 'video' });
    assert.equal(rtcBridge.sendOfferCalls.length, 1);
    assert.ok(rtcBridge.sendOfferCalls[0].includes('video'));
    await manager.endCall(false);
  });

  // Test 22: Voice calling regression test (full lifecycle)
  test('22. Voice calling regression test: full lifecycle remains completely functional', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const ringtone = new MockRingtone();
    const audioEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      ringtone,
      remoteAudioElement: audioEl,
      PeerConnectionClass: MockRTCPeerConnection
    });

    // Caller initiates voice call
    await manager.startCall('room-voice-reg', 'Rupert');
    assert.equal(manager.mode, 'voice');
    assert.equal(manager.isVideo, false);
    assert.equal(mediaDevices.getUserMediaCalls[0].video, false);

    // Remote audio track arrives
    const remoteStream = new MockMediaStream([new MockTrack('audio')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(audioEl.srcObject, remoteStream);

    // Mute microphone
    manager.toggleMute();
    assert.equal(manager.isMuted, true);

    // Hangup
    await manager.endCall(true);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(audioEl.srcObject, null);
  });

  // Test 23: Voice call still works with video disabled
  test('23. Voice call does not attach or enable video tracks', async () => {
    MockRTCPeerConnection.instances = [];
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-voice-no-video', 'Sam');
    const pc = MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];

    const senders = pc.getSenders();
    assert.equal(senders.length, 1);
    assert.equal(senders[0].track.kind, 'audio');
    assert.equal(manager._localVideoTrack, null);
    await manager.endCall(false);
  });

  // Test 24: Video call cleanup after RTC failure
  test('24. Video call cleanup after RTC failure transitions to FAILED and cleans up', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge({ connectOk: false, connectError: 'ICE gateway unreachable' });
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await assert.rejects(
      async () => manager.startVideoCall('room-video-fail', 'Ted'),
      /ICE gateway unreachable/i
    );

    assert.equal(manager.peerConnection, null);
    assert.equal(manager._localStream, null);
  });

});
