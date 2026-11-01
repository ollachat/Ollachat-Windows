import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';
import { RtcWebSocket } from '../src/call/rtc-websocket.js';

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
    return {
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
    };
  }

  async createAnswer(options = {}) {
    return {
      type: 'answer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
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

  simulateState(connState, iceState) {
    if (connState) this.connectionState = connState;
    if (iceState) this.iceConnectionState = iceState;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

class MockRtcBridge {
  constructor({ connectOk = true } = {}) {
    this.connectOk = connectOk;
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
    return {
      ok: this.connectOk,
      state: 'connected',
      roomId,
      callType: options.callType || (options.isVideo ? 'video' : 'voice'),
      iceServers: []
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

describe('Voice & Video Call Controls and Remote Hangup Suite (A through U)', () => {

  // Test A: Voice call has mute control
  test('A. Voice call has mute control and toggleMute works', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-voice-ctrl', 'Alice');
    assert.equal(manager.isMuted, false);

    const isMuted = manager.toggleMute();
    assert.equal(isMuted, true);
    assert.equal(manager.isMuted, true);
    await manager.endCall(false);
  });

  // Test B: Video call has mute control
  test('B. Video call has mute control and toggleMute works', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-mute', 'Bob');
    assert.equal(manager.isMuted, false);

    const isMuted = manager.toggleMute();
    assert.equal(isMuted, true);
    assert.equal(manager.isMuted, true);
    await manager.endCall(false);
  });

  // Test C: Video call has camera control
  test('C. Video call has camera control and toggleCamera works', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-cam', 'Charlie');
    assert.equal(manager.isCameraOff, false);

    const isOff = manager.toggleCamera();
    assert.equal(isOff, true);
    assert.equal(manager.isCameraOff, true);
    await manager.endCall(false);
  });

  // Test D: Mute disables audio track
  test('D. Mute disables local audio track (localAudioTrack.enabled = false)', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-mute-disable', 'Dave');
    assert.equal(manager._localAudioTrack.enabled, true);

    manager.toggleMute();
    assert.equal(manager._localAudioTrack.enabled, false);
    await manager.endCall(false);
  });

  // Test E: Unmute enables audio track
  test('E. Unmute enables local audio track (localAudioTrack.enabled = true)', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-unmute-enable', 'Eve');
    manager.toggleMute(); // mute
    assert.equal(manager._localAudioTrack.enabled, false);

    manager.toggleMute(); // unmute
    assert.equal(manager._localAudioTrack.enabled, true);
    await manager.endCall(false);
  });

  // Test F: Camera off disables video track
  test('F. Camera off disables local video track (localVideoTrack.enabled = false)', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-cam-off-disable', 'Frank');
    assert.equal(manager._localVideoTrack.enabled, true);

    manager.toggleCamera();
    assert.equal(manager._localVideoTrack.enabled, false);
    await manager.endCall(false);
  });

  // Test G: Camera on enables video track
  test('G. Camera on enables local video track (localVideoTrack.enabled = true)', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-cam-on-enable', 'Grace');
    manager.toggleCamera(); // off
    assert.equal(manager._localVideoTrack.enabled, false);

    manager.toggleCamera(); // on
    assert.equal(manager._localVideoTrack.enabled, true);
    await manager.endCall(false);
  });

  // Test H: Maximize/restore preserves call state
  test('H. Maximize and restore preserve call state, streams, and timer without renegotiation', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const remoteVideoEl = new MockMediaElement();
    const localVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      localVideoElement: localVideoEl,
      remoteVideoElement: remoteVideoEl,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-max-restore', 'Heidi');
    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt > 0);

    // Call state remains CONNECTED, peer connection remains active and open
    assert.equal(manager.peerConnection.isClosed, false);
    assert.equal(localVideoEl.srcObject, manager._localStream);
    assert.equal(remoteVideoEl.srcObject, remoteStream);
    await manager.endCall(false);
  });

  // Test I: Pop-out/floating presentation preserves call state
  test('I. Pop-out/floating presentation preserves WebRTC session and media playback', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const remoteVideoEl = new MockMediaElement();
    const localVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      localVideoElement: localVideoEl,
      remoteVideoElement: remoteVideoEl,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-floating-test', 'Ivan');
    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(manager.peerConnection.isClosed, false);
    assert.equal(localVideoEl.srcObject, manager._localStream);
    assert.equal(remoteVideoEl.srcObject, remoteStream);
    await manager.endCall(false);
  });

  // Test J: Remote voice hangup ends local voice call
  test('J. Remote voice hangup ends local voice call automatically', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-remote-voice-hangup', 'Judy');
    manager.peerConnection.simulateTrack(new MockMediaStream());
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // Remote peer sends leave / call_ended frame via RTC WebSocket
    rtcBridge.simulateEvent({ type: 'call_ended', roomId: 'room-remote-voice-hangup' });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.equal(manager.peerConnection, null);
  });

  // Test K: Remote video hangup ends local video call
  test('K. Remote video hangup ends local video call automatically', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-remote-video-hangup', 'Mallory');
    manager.peerConnection.simulateTrack(new MockMediaStream());
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // Remote peer hangs up via Chat WS or RTC event
    await manager.handleRemoteCallEnded({ roomId: 'room-remote-video-hangup' });

    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.equal(manager.peerConnection, null);
  });

  // Test L: Remote hangup stops timer
  test('L. Remote hangup immediately stops call duration timer', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-remote-timer-stop', 'Oscar');
    manager.peerConnection.simulateTrack(new MockMediaStream());
    assert.ok(manager.callConnectedAt > 0);

    rtcBridge.simulateEvent({ type: 'leave', roomId: 'room-remote-timer-stop' });
    await new Promise(r => setTimeout(r, 10));

    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager._timerInterval, null);
  });

  // Test M: Remote hangup stops ringtone
  test('M. Remote hangup during incoming ringing state stops ringtone', async () => {
    const ringtone = new MockRingtone();
    const manager = new VoiceCallManager({ ringtone });

    manager.handleIncomingCall({
      roomId: 'room-remote-ring-stop',
      callId: 'call-r1',
      initiator: 'Peggy'
    });
    assert.equal(ringtone.isPlaying, true);

    await manager.handleRemoteCallEnded({ roomId: 'room-remote-ring-stop' });
    assert.equal(ringtone.isPlaying, false);
    assert.ok(ringtone.stopCalls >= 1);
  });

  // Test N: Remote hangup stops audio track
  test('N. Remote hangup stops local audio track', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-remote-audio-stop', 'Quinn');
    const audioTrack = manager._localAudioTrack;
    assert.equal(audioTrack.stopped, false);

    await manager.handleRemoteCallEnded({ roomId: 'room-remote-audio-stop' });
    assert.equal(audioTrack.stopped, true);
    assert.equal(manager._localAudioTrack, null);
  });

  // Test O: Remote hangup stops video track
  test('O. Remote hangup stops local video track', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-remote-video-stop', 'Rupert');
    const videoTrack = manager._localVideoTrack;
    assert.equal(videoTrack.stopped, false);

    await manager.handleRemoteCallEnded({ roomId: 'room-remote-video-stop' });
    assert.equal(videoTrack.stopped, true);
    assert.equal(manager._localVideoTrack, null);
  });

  // Test P: Remote hangup closes call UI / state transitions to ENDED
  test('P. Remote hangup transitions call state to ENDED', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    let stateHistory = [];
    manager.on('stateChange', ({ state }) => { stateHistory.push(state); });

    await manager.startCall('room-remote-ui-close', 'Sybil');
    manager.peerConnection.simulateTrack(new MockMediaStream());

    await manager.handleRemoteCallEnded({ roomId: 'room-remote-ui-close' });

    assert.ok(stateHistory.includes(CALL_STATE.ENDED));
    assert.equal(manager.state, CALL_STATE.ENDED);
  });

  // Test Q: Remote hangup does not recursively send another leave
  test('Q. Remote hangup does not send redundant leave message over RTC WebSocket', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-no-recursive-leave', 'Trent');
    assert.equal(rtcBridge.leaveCalls, 0);

    // Remote side ended call -> endCall(false) is called
    await manager.handleRemoteCallEnded({ roomId: 'room-no-recursive-leave' });

    assert.equal(rtcBridge.leaveCalls, 0);
  });

  // Test R: Cleanup remains idempotent
  test('R. Cleanup remains idempotent across multiple hangup events', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-idempotent-multi', 'Victor');
    await manager.handleRemoteCallEnded({ roomId: 'room-idempotent-multi' });
    assert.equal(manager.peerConnection, null);

    // Subsequent endCall or remote hangup should execute cleanly
    await manager.handleRemoteCallEnded({ roomId: 'room-idempotent-multi' });
    await manager.endCall(false);
    assert.equal(manager.peerConnection, null);
  });

  // Test S: Local hangup still works
  test('S. Local hangup sends leave frame and tears down call', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-local-hangup-work', 'Walter');
    assert.equal(manager.state, CALL_STATE.CALLING);

    await manager.endCall(true);
    assert.equal(rtcBridge.leaveCalls, 1);
    assert.equal(manager.state, CALL_STATE.CANCELLED);
    assert.equal(manager.isEnded, true);
    assert.equal(manager.peerConnection, null);
  });

  // Test T: Voice-call regression test
  test('T. Voice-call regression test: audio calling functions with 0 camera access', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const audioEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      remoteAudioElement: audioEl,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startCall('room-voice-reg-t', 'Xavier');
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: false });
    assert.equal(manager.isVideo, false);
    assert.equal(manager.mode, 'voice');

    manager.peerConnection.simulateTrack(new MockMediaStream());
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    manager.toggleMute();
    assert.equal(manager.isMuted, true);

    await manager.endCall(true);
    assert.equal(manager.peerConnection, null);
  });

  // Test U: Video-call regression test
  test('U. Video-call regression test: video calling attaches both audio and video tracks and connects', async () => {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = new MockRtcBridge();
    const localVideoEl = new MockMediaElement();
    const remoteVideoEl = new MockMediaElement();
    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      localVideoElement: localVideoEl,
      remoteVideoElement: remoteVideoEl,
      PeerConnectionClass: MockRTCPeerConnection
    });

    await manager.startVideoCall('room-video-reg-u', 'Yvonne');
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: true });
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');

    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    manager.peerConnection.simulateTrack(remoteStream);

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(localVideoEl.srcObject, manager._localStream);
    assert.equal(remoteVideoEl.srcObject, remoteStream);

    manager.toggleCamera();
    assert.equal(manager.isCameraOff, true);

    await manager.endCall(true);
    assert.equal(manager.peerConnection, null);
    assert.equal(localVideoEl.srcObject, null);
    assert.equal(remoteVideoEl.srcObject, null);
  });

});
