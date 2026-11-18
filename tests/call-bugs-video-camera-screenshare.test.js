import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockTrack {
  constructor(kind = 'audio') {
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
    this.muted = false;
    this.readyState = 'live';
    this.onended = null;
    this.onmute = null;
  }

  stop() {
    this.stopped = true;
    this.readyState = 'ended';
    if (typeof this.onended === 'function') {
      this.onended();
    }
  }

  simulateOsTermination() {
    this.stop();
  }

  simulateMute() {
    this.muted = true;
    if (typeof this.onmute === 'function') {
      this.onmute();
    }
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
  constructor({ failVideo = false, failAll = false } = {}) {
    this.failVideo = failVideo;
    this.failAll = failAll;
    this.getUserMediaCalls = [];
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    if (this.failAll) {
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    }
    if (this.failVideo && constraints.video) {
      const err = new Error('Camera not found or denied');
      err.name = 'NotFoundError';
      throw err;
    }

    const tracks = [];
    if (constraints.audio !== false) {
      tracks.push(new MockTrack('audio'));
    }
    if (constraints.video) {
      tracks.push(new MockTrack('video'));
    }
    return new MockMediaStream(tracks);
  }
}

class MockRTCRtpSender {
  constructor(track = null) {
    this.track = track;
    this.replaceTrackCalls = [];
  }

  async replaceTrack(newTrack) {
    this.replaceTrackCalls.push(newTrack);
    this.track = newTrack;
  }

  async generateKeyFrame() { }
}

class MockRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.senders = [];
    this.transceivers = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = 'stable';
    this.isClosed = false;
    this.ontrack = null;
    this.onicecandidate = null;
  }

  addTrack(track, stream) {
    const sender = new MockRTCRtpSender(track);
    this.senders.push(sender);
    this.transceivers.push({
      sender,
      receiver: { track: null },
      direction: 'sendrecv'
    });
    return sender;
  }

  getSenders() {
    return this.senders;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async createOffer(options = {}) {
    const isVideo = Boolean(options.offerToReceiveVideo);
    const mLines = isVideo
      ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv'
      : 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=inactive';
    return {
      type: 'offer',
      sdp: `v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n${mLines}\r\n`
    };
  }

  async createAnswer() {
    return {
      type: 'answer',
      sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'
    };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-local-offer';
    if (desc.type === 'answer') this.signalingState = 'stable';
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    if (desc.type === 'offer') this.signalingState = 'have-remote-offer';
    if (desc.type === 'answer') this.signalingState = 'stable';
  }

  async addIceCandidate() { }

  close() {
    this.isClosed = true;
  }
}

class MockRtcBridge {
  constructor() {
    this.offersSent = [];
    this.answersSent = [];
    this.candidatesSent = [];
  }

  async connect() {
    return { ok: true, iceServers: [] };
  }

  async getState() {
    return 'connected';
  }

  async sendOffer(sdp, options = {}) {
    this.offersSent.push({ sdp, options });
  }

  async sendAnswer(sdp, requestId = 0) {
    this.answersSent.push({ sdp, requestId });
  }

  async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
    this.candidatesSent.push({ candidate, sdpMid, sdpMLineIndex });
  }

  leave() { }
}

class MockVideoElement {
  constructor() {
    this.srcObject = null;
    this.playCalled = false;
  }

  async play() {
    this.playCalled = true;
  }
}

function createTestHarness(options = {}) {
  const mediaDevices = new MockMediaDevices(options);
  const rtcBridge = new MockRtcBridge();
  const localVideoElement = new MockVideoElement();
  const remoteVideoElement = new MockVideoElement();
  const remoteAudioElement = new MockVideoElement();
  const signalsSent = [];

  const manager = new VoiceCallManager({
    rtcBridge,
    mediaDevices,
    PeerConnectionClass: MockRTCPeerConnection,
    SessionDescriptionClass: class {
      constructor({ type, sdp }) {
        this.type = type;
        this.sdp = sdp;
      }
    },
    IceCandidateClass: class {
      constructor(cand) {
        Object.assign(this, cand);
      }
    },
    localVideoElement,
    remoteVideoElement,
    remoteAudioElement,
    sendSignal: (sig) => signalsSent.push(sig)
  });

  return {
    manager,
    mediaDevices,
    rtcBridge,
    localVideoElement,
    remoteVideoElement,
    remoteAudioElement,
    signalsSent
  };
}

describe('Call Fixes: Video Identification, Camera Controls, Screen-Share Cleanup', () => {

  describe('Bug 1: Incoming video-call identification & late correction', () => {
    test('1. Incoming video call preserves isVideo=true and mode=video', () => {
      const { manager } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-vid-1',
        callId: 'call-1',
        initiator: 'user-alice',
        isVideo: true,
        callType: 'video',
        peerName: 'Alice'
      });

      assert.strictEqual(manager.state, CALL_STATE.INCOMING_RINGING);
      assert.strictEqual(manager.isVideo, true);
      assert.strictEqual(manager.mode, 'video');
      assert.strictEqual(manager.peerName, 'Alice');
    });

    test('2. Late in-band video invite upgrades initially voice call to video without losing call', () => {
      const { manager } = createTestHarness();
      // Initially arrives with voice
      manager.handleIncomingCall({
        roomId: 'room-vid-2',
        callId: 'call-2',
        initiator: 'user-bob',
        isVideo: false,
        callType: 'voice',
        peerName: 'Incoming Voice Call'
      });

      assert.strictEqual(manager.state, CALL_STATE.INCOMING_RINGING);
      assert.strictEqual(manager.isVideo, false);
      assert.strictEqual(manager.mode, 'voice');

      let modeChangeEvent = null;
      manager.on('modeChange', (e) => { modeChangeEvent = e; });

      // Late video invite received while ringing
      manager.setModality('video');

      assert.strictEqual(manager.state, CALL_STATE.INCOMING_RINGING);
      assert.strictEqual(manager.isVideo, true);
      assert.strictEqual(manager.mode, 'video');
      assert.strictEqual(manager.peerName, 'Incoming Video Call');
      assert.deepStrictEqual(modeChangeEvent, { isVideo: true, mode: 'video' });
    });

    test('3. Late incoming SDP offer with m=video corrects modality while live remote media controls connection', async () => {
      const { manager } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-vid-3',
        callId: 'call-3',
        initiator: 'user-charlie',
        isVideo: false,
        callType: 'voice',
        peerName: 'Charlie'
      });

      assert.strictEqual(manager.state, CALL_STATE.INCOMING_RINGING);
      assert.strictEqual(manager.isVideo, false);

      const videoSdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
      await manager._handleIncomingOffer(videoSdp, 101, { isVideo: true, callType: 'video' });

      // Remains ringing, but updated to video
      assert.strictEqual(manager.state, CALL_STATE.INCOMING_RINGING);
      assert.strictEqual(manager.isVideo, true);
      assert.strictEqual(manager.mode, 'video');
      assert.ok(manager._pendingOffer);

      // Acceptance publishes the receiver's own media first and remains connecting.
      await manager.acceptCall();
      assert.strictEqual(manager.state, CALL_STATE.CONNECTING);
      assert.strictEqual(manager.peerConnection.signalingState, 'have-local-offer');

      // The publication answer releases the queued SFU offer, but transport SDP alone still cannot connect.
      await manager._handleIncomingAnswer(
        'v=0\r\no=receiver-publication-answer\r\n',
        manager.callEpoch
      );
      assert.strictEqual(manager.state, CALL_STATE.CONNECTING);
      assert.strictEqual(manager.peerConnection.signalingState, 'stable');

      const remoteAudioTrack = new MockTrack('audio');
      manager.peerConnection.ontrack({
        track: remoteAudioTrack,
        streams: [new MockMediaStream([remoteAudioTrack])]
      });

      assert.strictEqual(manager.state, CALL_STATE.CONNECTED);
      assert.strictEqual(manager.isVideo, true);
      assert.strictEqual(manager.mode, 'video');
    });
  });

  describe('Bug 2: Camera controls & toggling', () => {
    test('1. Recipient of video call acquires and attaches video tracks correctly', async () => {
      const { manager, localVideoElement, mediaDevices } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-cam-1',
        callId: 'call-c1',
        initiator: 'user-dave',
        isVideo: true,
        callType: 'video',
        peerName: 'Dave'
      });

      await manager.acceptCall();

      assert.strictEqual(manager.isVideo, true);
      assert.strictEqual(manager.isCameraOff, false);
      assert.ok(manager._localVideoTrack);
      assert.strictEqual(manager._localVideoTrack.kind, 'video');
      assert.strictEqual(manager._localVideoTrack.enabled, true);
      assert.strictEqual(localVideoElement.srcObject, manager._localStream);
      assert.strictEqual(mediaDevices.getUserMediaCalls[0].video, true);
    });

    test('2. Camera toggling off disables local video track without ending call', async () => {
      const { manager } = createTestHarness();
      await manager.startVideoCall('room-cam-2', 'Eve');

      assert.strictEqual(manager.isCameraOff, false);
      assert.strictEqual(manager._localVideoTrack.enabled, true);

      let cameraChangeEvents = [];
      manager.on('cameraChange', (e) => cameraChangeEvents.push(e));

      // Toggle camera off (synchronous boolean return)
      const offResult = manager.toggleCamera();
      assert.strictEqual(offResult, true);
      assert.strictEqual(manager.isCameraOff, true);
      assert.strictEqual(manager._localVideoTrack.enabled, false);
      assert.strictEqual(manager.state, CALL_STATE.OUTGOING_RINGING); // Call not ended!

      // Toggle camera on
      const onResult = manager.toggleCamera();
      assert.strictEqual(onResult, false);
      assert.strictEqual(manager.isCameraOff, false);
      assert.strictEqual(manager._localVideoTrack.enabled, true);
      assert.strictEqual(manager.state, CALL_STATE.OUTGOING_RINGING); // Call still active!

      assert.strictEqual(cameraChangeEvents.length, 2);
      assert.deepStrictEqual(cameraChangeEvents[0], { isCameraOff: true });
      assert.deepStrictEqual(cameraChangeEvents[1], { isCameraOff: false });
    });

    test('3. Dynamic camera upgrade error does not end audio call or destroy audio track', async () => {
      const { manager } = createTestHarness({ failVideo: true });
      await manager.startCall('room-audio-upg', 'Frank');

      // Audio call active
      assert.strictEqual(manager.isVideo, false);
      assert.strictEqual(manager._localVideoTrack, null);
      assert.ok(manager._localAudioTrack);
      assert.strictEqual(manager._localAudioTrack.enabled, true);

      // User attempts to turn on camera in audio call, but camera device fails
      const togglePromise = manager.toggleCamera();
      const res = await togglePromise;

      // Returns true (camera stays off)
      assert.strictEqual(res, true);
      assert.strictEqual(manager.isCameraOff, true);
      // Audio call is completely preserved!
      assert.strictEqual(manager.state, CALL_STATE.OUTGOING_RINGING);
      assert.ok(manager._localAudioTrack);
      assert.strictEqual(manager._localAudioTrack.enabled, true);
    });

    test('4. Preserves audio-only call behavior when starting voice call', async () => {
      const { manager, mediaDevices } = createTestHarness();
      await manager.startCall('room-audio-only', 'Grace');

      assert.strictEqual(manager.isVideo, false);
      assert.strictEqual(manager.mode, 'voice');
      assert.strictEqual(manager._localVideoTrack, null);
      assert.strictEqual(mediaDevices.getUserMediaCalls[0].video, false);
      assert.strictEqual(mediaDevices.getUserMediaCalls[0].audio, true);
    });
  });

  describe('Bug 3: Screen-share cleanup & restart', () => {
    test('1. Stop button path stops screen capture and restores camera state', async () => {
      const { manager, localVideoElement } = createTestHarness();
      await manager.startVideoCall('room-ss-1', 'Heidi');
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      const originalCameraTrack = manager._localVideoTrack;

      // Start screen sharing
      await manager.startScreenShare('screen:0:0');
      assert.strictEqual(manager.isScreenSharing, true);
      assert.notStrictEqual(manager._localVideoTrack, originalCameraTrack);

      // Stop screen sharing via in-app stop
      let screenShareEvents = [];
      manager.on('screenShareChange', (e) => screenShareEvents.push(e));

      const stopped = await manager.stopScreenShare();
      assert.strictEqual(stopped, true);
      assert.strictEqual(manager.isScreenSharing, false);
      assert.strictEqual(manager._localVideoTrack, originalCameraTrack);
      assert.strictEqual(manager._screenTrack, null);
      assert.strictEqual(manager._screenStream, null);
      assert.strictEqual(manager.state, CALL_STATE.CONNECTED); // Audio call active!
      assert.deepStrictEqual(screenShareEvents[0], { isScreenSharing: false });
    });

    test('2. OS track-ended path automatically invokes stopScreenShare and restores camera', async () => {
      const { manager } = createTestHarness();
      await manager.startVideoCall('room-ss-2', 'Ivan');
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      const originalCameraTrack = manager._localVideoTrack;
      await manager.startScreenShare('window:100:0');
      assert.strictEqual(manager.isScreenSharing, true);

      // Simulate OS-level window close / track stop
      manager._screenTrack.stop();

      // Allow microtask resolution
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.strictEqual(manager.isScreenSharing, false);
      assert.strictEqual(manager._localVideoTrack, originalCameraTrack);
      assert.strictEqual(manager._screenTrack, null);
      assert.strictEqual(manager.state, CALL_STATE.CONNECTED);
    });

    test('3. Viewer clears remote screen share state and resets srcObject on audio call', () => {
      const { manager, remoteVideoElement } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-ss-3',
        callId: 'call-ss3',
        initiator: 'user-judy',
        isVideo: false,
        callType: 'voice',
        peerName: 'Judy'
      });

      // Peer shares screen in audio call
      manager._remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
      manager.setRemoteScreenShareState(true, 'user-judy');

      assert.strictEqual(manager.remoteScreenSharing, true);
      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream);

      // Remote user stops screen sharing
      manager.setRemoteScreenShareState(false, null);

      assert.strictEqual(manager.remoteScreenSharing, false);
      // Remote video element must be null to eliminate frozen frame!
      assert.strictEqual(remoteVideoElement.srcObject, null);
    });

    test('4. Remote video track onended/onmute triggers cleanup on viewer', () => {
      const { manager, remoteVideoElement } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-ss-4',
        callId: 'call-ss4',
        initiator: 'user-kyle',
        isVideo: false,
        callType: 'voice',
        peerName: 'Kyle'
      });

      manager._createPeerConnection();
      const videoTrack = new MockTrack('video');
      const stream = new MockMediaStream([new MockTrack('audio'), videoTrack]);

      manager.peerConnection.ontrack({
        track: videoTrack,
        streams: [stream]
      });

      assert.strictEqual(manager.remoteScreenSharing, true);

      // Track ends when remote participant stops screen sharing
      videoTrack.stop();

      assert.strictEqual(manager.remoteScreenSharing, false);
      assert.strictEqual(remoteVideoElement.srcObject, null);
    });

    test('5. Screen share can be started again during the same active call', async () => {
      const { manager } = createTestHarness();
      await manager.startVideoCall('room-ss-5', 'Leo');
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      // First screen share session
      await manager.startScreenShare('screen:0:0');
      assert.strictEqual(manager.isScreenSharing, true);
      await manager.stopScreenShare();
      assert.strictEqual(manager.isScreenSharing, false);

      // Second screen share session in the same active call
      await manager.startScreenShare('screen:0:0');
      assert.strictEqual(manager.isScreenSharing, true);
      await manager.stopScreenShare();
      assert.strictEqual(manager.isScreenSharing, false);
      assert.strictEqual(manager.state, CALL_STATE.CONNECTED);
    });

    test('6. In-app stopping in audio call: caller stopScreenShare initiates SDP renegotiation and receiver cleanly drops video to restore audio-only UI', async () => {
      const { manager, remoteVideoElement } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-ss-6',
        callId: 'call-ss6',
        initiator: 'user-charlie',
        isVideo: false,
        callType: 'voice',
        peerName: 'Charlie'
      });
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();
      manager._createPeerConnection();

      // 1. Offerer starts screen sharing during audio call -> sends offer with active video media
      const remoteVideoTrack = new MockTrack('video');
      const stream = new MockMediaStream([new MockTrack('audio'), remoteVideoTrack]);
      await manager._handleIncomingOffer(
        'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n',
        101,
        { isVideo: true, callType: 'video' }
      );
      manager.peerConnection.ontrack({
        track: remoteVideoTrack,
        streams: [stream]
      });

      assert.strictEqual(manager.remoteScreenSharing, true);
      assert.strictEqual(manager.isVideo, false, 'Audio call modality remains audio during remote screen share');
      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream);

      // 2. Offerer stops screen sharing via in-app Stop button -> sends renegotiation offer deactivating video
      let modeChangeEvents = [];
      let remoteShareEvents = [];
      manager.on('modeChange', (e) => modeChangeEvents.push(e));
      manager.on('remoteScreenShareChange', (e) => remoteShareEvents.push(e));

      await manager._handleIncomingOffer(
        'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\n',
        102,
        { isVideo: false, callType: 'voice' }
      );

      // Verify remote screen share state cleared and stale frame removed
      assert.strictEqual(manager.remoteScreenSharing, false);
      assert.strictEqual(manager.activeScreenSharerId, null);
      assert.strictEqual(manager.isVideo, false);
      assert.strictEqual(manager.mode, 'voice');
      assert.strictEqual(remoteVideoElement.srcObject, null, 'Stale preview frame must be immediately cleared on audio call');
      assert.strictEqual(manager.state, CALL_STATE.CONNECTED, 'Audio call remains fully connected');
      assert.strictEqual(manager.canStartScreenShare(), true, 'Screen sharing can be started again');
      assert.deepStrictEqual(remoteShareEvents[0], { remoteScreenSharing: false, activeScreenSharerId: null });
      assert.deepStrictEqual(modeChangeEvents[0], { mode: 'voice', isVideo: false });
    });

    test('7. OS-level stopping in audio call: capture track ended initiates renegotiation and receiver resets screen-share state', async () => {
      const { manager, rtcBridge } = createTestHarness();
      await manager.startCall('room-ss-7', 'David', { isVideo: false, mode: 'voice' });
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      // Caller starts sharing screen
      await manager.startScreenShare('screen:0:0');
      assert.strictEqual(manager.isScreenSharing, true);
      const screenTrack = manager._screenTrack;
      assert.ok(screenTrack);

      // User stops sharing via OS toolbar / closes captured window
      screenTrack.simulateOsTermination();

      // Wait microtask resolution for async stopScreenShare
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(manager.isScreenSharing, false);
      assert.strictEqual(manager.state, CALL_STATE.CONNECTED);
      assert.strictEqual(manager._screenTrack, null);

      // Verify renegotiation offer with isVideo: false was sent to SFU
      const lastOffer = rtcBridge.offersSent.at(-1);
      assert.ok(lastOffer);
      assert.strictEqual(lastOffer.options.isVideo, false);
      assert.strictEqual(lastOffer.options.callType, 'voice');
    });

    test('8. In-app stopping in video call: restores camera feed and removes screen-share active indicators without clearing camera feed', async () => {
      const { manager, remoteVideoElement } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-ss-8',
        callId: 'call-ss8',
        initiator: 'user-frank',
        isVideo: true,
        callType: 'video',
        peerName: 'Frank'
      });
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      const cameraTrack = new MockTrack('video', { id: 'remote-camera-track-1' });
      manager._remoteStream = new MockMediaStream([new MockTrack('audio'), cameraTrack]);

      // Initially viewing camera
      manager.setRemoteScreenShareState(false, null);
      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream);
      assert.strictEqual(manager.remoteScreenSharing, false);

      // Remote peer shares screen
      manager.setRemoteScreenShareState(true, 'user-frank');
      assert.strictEqual(manager.remoteScreenSharing, true);
      assert.strictEqual(manager.canStartScreenShare(), false, 'One-sharer rule: cannot start while remote is sharing');

      // Remote peer stops screen sharing
      manager.setRemoteScreenShareState(false, null);
      assert.strictEqual(manager.remoteScreenSharing, false);
      assert.strictEqual(manager.activeScreenSharerId, null);
      assert.strictEqual(manager.isVideo, true, 'Video call modality preserved');
      // Crucial: camera feed MUST NOT be cleared to null on video call!
      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream);
      assert.strictEqual(remoteVideoElement.playCalled, true);
      assert.strictEqual(manager.canStartScreenShare(), true, 'Can start screen share again');
    });

    test('9. Transient track mute does NOT falsely clear valid camera feed or reset screen share state', () => {
      const { manager, remoteVideoElement } = createTestHarness();
      manager.handleIncomingCall({
        roomId: 'room-ss-9',
        callId: 'call-ss9',
        initiator: 'user-grace',
        isVideo: true,
        callType: 'video',
        peerName: 'Grace'
      });
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();
      manager._createPeerConnection();

      const liveCameraTrack = new MockTrack('video');
      const stream = new MockMediaStream([new MockTrack('audio'), liveCameraTrack]);

      manager.peerConnection.ontrack({
        track: liveCameraTrack,
        streams: [stream]
      });

      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream);

      // Transient mute due to network packet drop
      liveCameraTrack.muted = true;
      if (typeof liveCameraTrack.onmute === 'function') {
        liveCameraTrack.onmute();
      }

      // Camera feed must remain attached and intact
      assert.strictEqual(remoteVideoElement.srcObject, manager._remoteStream, 'Transient mute must NOT clear valid camera feed');
    });

    test('10. Audio call restart screen sharing: multiple cycles of start/stop preserve clean state, reuse sender, and keep audio active', async () => {
      const { manager, rtcBridge } = createTestHarness();
      await manager.startCall('room-ss-10', 'Heidi', { isVideo: false, mode: 'voice' });
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      for (let cycle = 1; cycle <= 3; cycle++) {
        // Start screen share
        const started = await manager.startScreenShare(`screen:${cycle}:0`);
        assert.strictEqual(started, true);
        assert.strictEqual(manager.isScreenSharing, true);
        assert.strictEqual(manager.isVideo, false, 'Modality remains voice throughout');

        // Stop screen share
        const stopped = await manager.stopScreenShare();
        assert.strictEqual(stopped, true);
        assert.strictEqual(manager.isScreenSharing, false);
        assert.strictEqual(manager.isCameraOff, true);
        assert.strictEqual(manager.state, CALL_STATE.CONNECTED, 'Audio call remains active');
      }

      // Senders count should not have multiplied unboundedly
      const senders = manager.peerConnection.getSenders();
      const videoSenders = senders.filter((s) => s.track?.kind === 'video' || s === manager._screenVideoSender);
      assert.strictEqual(videoSenders.length, 1, 'Video sender must be reused across screen share cycles');
    });

    test('11. Idempotent cleanup: repeated calls to stopScreenShare or setRemoteScreenShareState are safe', async () => {
      const { manager } = createTestHarness();
      await manager.startVideoCall('room-ss-11', 'Ian');
      manager._setState(CALL_STATE.CONNECTING);
      manager._markConnected();

      await manager.startScreenShare('screen:0:0');
      const stop1 = await manager.stopScreenShare();
      assert.strictEqual(stop1, true);

      // Subsequent duplicate stops
      const stop2 = await manager.stopScreenShare();
      assert.strictEqual(stop2, false);
      const stop3 = await manager.stopScreenShare();
      assert.strictEqual(stop3, false);

      // Repeated remote screen share state resets
      manager.setRemoteScreenShareState(false, null);
      manager.setRemoteScreenShareState(false, null);
      assert.strictEqual(manager.remoteScreenSharing, false);
      assert.strictEqual(manager.activeScreenSharerId, null);
    });
  });
});
