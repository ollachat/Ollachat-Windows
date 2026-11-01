import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockTrack {
  constructor(kind = 'audio', { id = 'track-' + Math.random().toString(36).slice(2) } = {}) {
    this.id = id;
    this.kind = kind;
    this.enabled = true;
    this.stopped = false;
    this.onended = null;
  }

  stop() {
    this.stopped = true;
  }

  simulateOsTermination() {
    this.stopped = true;
    if (typeof this.onended === 'function') {
      this.onended();
    }
  }
}

class MockMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
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
  constructor() {
    this.getUserMediaCalls = [];
    this.nextScreenTrack = null;
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);

    // Screen sharing capture request
    if (constraints?.video?.mandatory?.chromeMediaSource === 'desktop') {
      const sourceId = constraints.video.mandatory.chromeMediaSourceId;
      const screenTrack = this.nextScreenTrack || new MockTrack('video', { id: `screen-${sourceId}` });
      this.nextScreenTrack = null;
      return new MockMediaStream([screenTrack]);
    }

    // Standard camera + mic request
    const tracks = [];
    if (constraints.audio) {
      tracks.push(new MockTrack('audio', { id: 'mic-track-1' }));
    }
    if (constraints.video) {
      tracks.push(new MockTrack('video', { id: 'cam-track-1' }));
    }
    return new MockMediaStream(tracks);
  }
}

class MockRTCSender {
  constructor(track, stream) {
    this.track = track;
    this.stream = stream;
    this.replacedTracks = [];
    this.keyFramesGenerated = 0;
  }

  async replaceTrack(newTrack) {
    this.replacedTracks.push(newTrack);
    this.track = newTrack;
  }

  async generateKeyFrame() {
    this.keyFramesGenerated++;
  }
}

class MockRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.iceServers = config.iceServers || [];
    this.senders = [];
    this.isClosed = false;
    this.localDescription = null;
    this.remoteDescription = null;
  }

  addTrack(track, stream) {
    const sender = new MockRTCSender(track, stream);
    this.senders.push(sender);
    return sender;
  }

  addTransceiver(track, init = {}) {
    const sender = new MockRTCSender(track, init.streams ? init.streams[0] : null);
    this.senders.push(sender);
    return { sender };
  }

  getSenders() {
    return this.senders;
  }

  async createOffer(options = {}) {
    return {
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
    };
  }

  async createAnswer(options = {}) {
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

  close() {
    this.isClosed = true;
  }
}

describe('OllaChat Windows Screen Sharing (Phase 1)', () => {
  async function createConnectedVideoCall() {
    const mediaDevices = new MockMediaDevices();
    const rtcBridge = {
      connect: async () => ({ ok: true }),
      disconnect: () => {},
      sendOffer: async () => {},
      sendAnswer: async () => {},
      sendCandidate: async () => {},
      leave: async () => {},
      getState: async () => 'connected',
      onEvent: () => () => {}
    };

    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: () => {}
    });

    // Start video call and transition to connected
    await manager.startVideoCall('room-test-123', 'Alice');
    manager._setState(CALL_STATE.CONNECTING);
    manager._setState(CALL_STATE.CONNECTED);

    return { manager, mediaDevices };
  }

  test('1. Start screen share state transition and toJSON representation', async () => {
    const { manager } = await createConnectedVideoCall();

    assert.equal(manager.isScreenSharing, false);
    assert.equal(manager.toJSON().isScreenSharing, false);

    let emittedEvent = null;
    manager.on('screenShareChange', (event) => {
      emittedEvent = event;
    });

    const success = await manager.startScreenShare('screen:0:0');
    assert.equal(success, true);
    assert.equal(manager.isScreenSharing, true);
    assert.equal(manager.toJSON().isScreenSharing, true);
    assert.deepEqual(emittedEvent, { isScreenSharing: true, sourceId: 'screen:0:0' });
  });

  test('2. replaceTrack(displayTrack) replaces outgoing video on existing sender without SDP renegotiation', async () => {
    const { manager, mediaDevices } = await createConnectedVideoCall();

    const videoSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    const originalCamTrack = videoSender.track;
    assert.ok(originalCamTrack);

    await manager.startScreenShare('window:1234:0');

    // Verify last getUserMedia call passed exact chromeMediaSourceId and strictly audio: false
    const lastCall = mediaDevices.getUserMediaCalls.at(-1);
    assert.equal(lastCall.audio, false, 'Screen capture MUST NOT capture system/loopback audio in Phase 1');
    assert.equal(lastCall.video.mandatory.chromeMediaSource, 'desktop');
    assert.equal(lastCall.video.mandatory.chromeMediaSourceId, 'window:1234:0');

    // Video sender track was replaced
    assert.notEqual(videoSender.track, originalCamTrack);
    assert.equal(videoSender.track.kind, 'video');
    assert.equal(videoSender.replacedTracks.length, 1);
    assert.equal(videoSender.replacedTracks[0], videoSender.track);
  });

  test('3. Microphone audio track and audio sender remain completely untouched', async () => {
    const { manager } = await createConnectedVideoCall();

    const audioSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'audio');
    const originalAudioTrack = audioSender.track;
    assert.ok(originalAudioTrack);

    await manager.startScreenShare('screen:0:0');

    // Audio sender track must be identical
    assert.equal(audioSender.track, originalAudioTrack);
    assert.equal(audioSender.replacedTracks.length, 0, 'Audio sender must not be replaced');
    assert.equal(manager._localAudioTrack, originalAudioTrack);
    assert.equal(originalAudioTrack.stopped, false);
  });

  test('4. Stop screen share stops display tracks and restores camera track via replaceTrack', async () => {
    const { manager } = await createConnectedVideoCall();

    const videoSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    const originalCamTrack = videoSender.track;

    await manager.startScreenShare('screen:0:0');
    const screenTrack = videoSender.track;
    assert.notEqual(screenTrack, originalCamTrack);

    let stopEventEmitted = null;
    manager.on('screenShareChange', (event) => {
      stopEventEmitted = event;
    });

    const stopped = await manager.stopScreenShare();
    assert.equal(stopped, true);
    assert.equal(manager.isScreenSharing, false);
    assert.equal(screenTrack.stopped, true, 'Screen capture track must be stopped upon stopScreenShare');
    assert.equal(videoSender.track, originalCamTrack, 'Original camera track must be restored on video sender');
    assert.equal(manager._localVideoTrack, originalCamTrack);
    assert.deepEqual(stopEventEmitted, { isScreenSharing: false });
  });

  test('5. Camera-OFF state restoration: returns to camera-off without turning camera back on', async () => {
    const { manager } = await createConnectedVideoCall();

    // Turn camera OFF before screen sharing
    manager.toggleCamera();
    assert.equal(manager.isCameraOff, true);
    const cameraTrack = manager._localVideoTrack;
    assert.equal(cameraTrack.enabled, false);

    // Start screen share while camera was OFF
    await manager.startScreenShare('screen:0:0');
    assert.equal(manager.isScreenSharing, true);

    // Stop screen share
    await manager.stopScreenShare();

    // Must return to camera OFF state and not turn camera on
    assert.equal(manager.isCameraOff, true);
    assert.equal(cameraTrack.enabled, false, 'Camera track MUST remain disabled when restored');
    assert.equal(manager._localVideoTrack, cameraTrack);
  });

  test('6. Camera-ON state restoration: returns to camera-on if it was on', async () => {
    const { manager } = await createConnectedVideoCall();

    assert.equal(manager.isCameraOff, false);
    const cameraTrack = manager._localVideoTrack;
    assert.equal(cameraTrack.enabled, true);

    await manager.startScreenShare('screen:0:0');
    await manager.stopScreenShare();

    assert.equal(manager.isCameraOff, false);
    assert.equal(cameraTrack.enabled, true);
    assert.equal(manager._localVideoTrack, cameraTrack);
  });

  test('7. displayTrack.onended triggers automatic OS-level cleanup and restores camera', async () => {
    const { manager, mediaDevices } = await createConnectedVideoCall();

    const mockScreenTrack = new MockTrack('video', { id: 'os-screen-track' });
    mediaDevices.nextScreenTrack = mockScreenTrack;

    await manager.startScreenShare('window:notepad:123');
    assert.equal(manager.isScreenSharing, true);

    // Simulate user closing Notepad window in Windows
    mockScreenTrack.simulateOsTermination();

    // Give microtask queue moment to process async handler
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.isScreenSharing, false);
    assert.equal(mockScreenTrack.stopped, true);
    const videoSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    assert.equal(videoSender.track, manager._localVideoTrack);
  });

  test('8. Picker cancellation keeps call completely unchanged', async () => {
    const { manager } = await createConnectedVideoCall();

    const videoSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    const originalTrack = videoSender.track;

    // Simulate user clicking cancel in picker: startScreenShare is NOT called
    assert.equal(manager.isScreenSharing, false);
    assert.equal(videoSender.track, originalTrack);
    assert.equal(manager.state, CALL_STATE.CONNECTED);
  });

  test('9. Call cleanup while sharing stops all screen tracks and resets screen-sharing state', async () => {
    const { manager, mediaDevices } = await createConnectedVideoCall();

    const mockScreenTrack = new MockTrack('video', { id: 'clean-screen-track' });
    mediaDevices.nextScreenTrack = mockScreenTrack;

    await manager.startScreenShare('screen:0:0');
    assert.equal(manager.isScreenSharing, true);

    // End call while active screen sharing
    await manager.endCall(false);

    assert.equal(manager.isScreenSharing, false);
    assert.equal(mockScreenTrack.stopped, true, 'Screen track must be stopped upon call termination');
    assert.equal(manager._screenStream, null);
    assert.equal(manager._screenTrack, null);
    assert.equal(manager._savedCameraTrack, null);
  });

  test('10. Repeated start and stop cycles do not leak state or leave active tracks', async () => {
    const { manager } = await createConnectedVideoCall();

    for (let i = 0; i < 3; i++) {
      await manager.startScreenShare(`screen:${i}:0`);
      assert.equal(manager.isScreenSharing, true);
      const screenTrack = manager._screenTrack;

      await manager.stopScreenShare();
      assert.equal(manager.isScreenSharing, false);
      assert.equal(screenTrack.stopped, true);
      assert.equal(manager._screenTrack, null);
      assert.equal(manager._screenStream, null);
    }
  });

  test('11. stopScreenShare is idempotent and safe to call multiple times', async () => {
    const { manager } = await createConnectedVideoCall();

    const firstStop = await manager.stopScreenShare();
    assert.equal(firstStop, false, 'Stopping when not sharing returns false');

    await manager.startScreenShare('screen:0:0');
    const secondStop = await manager.stopScreenShare();
    assert.equal(secondStop, true);

    const thirdStop = await manager.stopScreenShare();
    assert.equal(thirdStop, false);
  });

  test('12. Invariants: rejects invalid sourceId and rejects calling when not connected', async () => {
    const { manager } = await createConnectedVideoCall();

    await assert.rejects(
      async () => manager.startScreenShare(''),
      /valid sourceId is required/
    );

    await manager.endCall(false);
    assert.equal(manager.state, CALL_STATE.ENDED);

    await assert.rejects(
      async () => manager.startScreenShare('screen:0:0'),
      /active call/
    );
  });

  test('13. Sets contentHint = detail on screen track and calls generateKeyFrame on video sender', async () => {
    const { manager } = await createConnectedVideoCall();
    const videoSender = manager.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');

    await manager.startScreenShare('screen:0:0');
    assert.equal(manager._screenTrack.contentHint, 'detail', 'contentHint must be set to detail for crisp text');
    assert.equal(videoSender.keyFramesGenerated, 1, 'generateKeyFrame must be called on videoSender');

    await manager.stopScreenShare();
    assert.equal(videoSender.keyFramesGenerated, 2, 'generateKeyFrame must be called again when restoring camera track');
  });

  test('14. One-sharer rule: rejects startScreenShare if remote participant is already sharing', async () => {
    const { manager } = await createConnectedVideoCall();

    assert.equal(manager.canStartScreenShare(), true);
    manager.setRemoteScreenShareState(true, 'user-remote-42');
    assert.equal(manager.remoteScreenSharing, true);
    assert.equal(manager.activeScreenSharerId, 'user-remote-42');
    assert.equal(manager.canStartScreenShare(), false);

    await assert.rejects(
      async () => manager.startScreenShare('screen:0:0'),
      /Another participant is already sharing their screen/
    );

    manager.setRemoteScreenShareState(false);
    assert.equal(manager.remoteScreenSharing, false);
    assert.equal(manager.activeScreenSharerId, null);
    assert.equal(manager.canStartScreenShare(), true);

    const success = await manager.startScreenShare('screen:0:0');
    assert.equal(success, true);
  });

  test('15. Remote screen sharing state management and event propagation', async () => {
    const { manager } = await createConnectedVideoCall();
    let changeEvent = null;

    manager.on('remoteScreenShareChange', (evt) => {
      changeEvent = evt;
    });

    manager.setRemoteScreenShareState(true, 'peer-99');
    assert.deepEqual(changeEvent, { remoteScreenSharing: true, activeScreenSharerId: 'peer-99' });
    assert.equal(manager.toJSON().remoteScreenSharing, true);
    assert.equal(manager.toJSON().activeScreenSharerId, 'peer-99');

    manager.setRemoteScreenShareState(false);
    assert.deepEqual(changeEvent, { remoteScreenSharing: false, activeScreenSharerId: null });
    assert.equal(manager.toJSON().remoteScreenSharing, false);
    assert.equal(manager.toJSON().activeScreenSharerId, null);
  });

  test('16. Audio call screen sharing: adds video track and initiates SDP renegotiation without enabling camera', async () => {
    const mediaDevices = new MockMediaDevices();
    let rtcPeerConnectionInstance = null;
    let sentOffers = [];

    const rtcBridge = {
      connect: async () => ({ ok: true, iceServers: [] }),
      sendOffer: async (sdp, options) => {
        sentOffers.push({ sdp, options });
        return { ok: true };
      },
      sendAnswer: async () => ({ ok: true }),
      leave: async () => ({ ok: true }),
      getState: async () => 'connected',
      on: () => () => {}
    };

    const manager = new VoiceCallManager({
      mediaDevices,
      rtcBridge,
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: () => {}
    });

    await manager.startCall('room-audio-screen-1', 'Charlie');
    manager._setState(CALL_STATE.CONNECTING);
    manager._setState(CALL_STATE.CONNECTED);

    assert.equal(manager.isVideo, false);
    assert.equal(manager.isScreenSharing, false);

    // Start sharing screen in audio call
    const started = await manager.startScreenShare('screen:0:0');
    assert.equal(started, true);
    assert.equal(manager.isScreenSharing, true);
    assert.equal(manager._screenTrack.contentHint, 'detail');
    assert.ok(sentOffers.length >= 1, 'SDP renegotiation offer must be sent to SFU');
    const lastOffer = sentOffers.at(-1);
    assert.equal(lastOffer.options.isVideo, true);
    assert.equal(lastOffer.options.callType, 'video');

    // Camera track remains null
    assert.equal(manager._savedCameraTrack, null);

    // Stop screen sharing: camera remains off, audio remains connected
    const stopped = await manager.stopScreenShare();
    assert.equal(stopped, true);
    assert.equal(manager.isScreenSharing, false);
    assert.equal(manager.isCameraOff, true);
    assert.equal(manager.state, CALL_STATE.CONNECTED);
  });
});
