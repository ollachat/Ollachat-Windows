import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';
import { RtcWebSocket } from '../src/call/rtc-websocket.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

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
    this.signalingState = 'stable';
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
    this.senders.push({ track, stream });
    return { track };
  }

  getSenders() {
    return this.senders;
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  }

  async addIceCandidate(candidate) {
    return candidate;
  }

  close() {
    this.isClosed = true;
    this.connectionState = 'closed';
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
    if (!this.connectOk) return { ok: false, error: this.connectError || 'Connection refused' };
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

  async leave(roomId) {
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

/**
 * Helper representing the exact UI mapping logic from app.js updateVoiceCallUi
 */
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

  if (state === CALL_STATE.IDLE) {
    return ui;
  }

  if (isVideo) {
    if (state === CALL_STATE.CONNECTED) {
      ui.cardClass = 'is-video-call';
    } else if (state === CALL_STATE.INCOMING_RINGING) {
      ui.cardClass = 'is-incoming-video';
    }
  } else {
    if (state === CALL_STATE.INCOMING_RINGING) {
      ui.cardClass = 'is-incoming-voice';
    }
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
  }

  return ui;
}

function createManager() {
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
    ringtone
  });

  return { manager, rtcBridge, mediaDevices, ringtone };
}

describe('WhatsApp-style Calling UX & Modality State Machine', () => {

  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
  });

  test('1. Incoming voice call stays INCOMING_RINGING before accept', async () => {
    const { manager, rtcBridge } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-voice-1',
      callId: 'call-1',
      initiator: 'alice-id',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice',
      peerPhone: '+1234567890'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, false);
    assert.equal(manager.mode, 'voice');

    // Simulate RTC offer arriving while receiver is still deciding
    manager._handleIncomingOffer('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', { isVideo: false, callType: 'voice' });
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING, 'Must NOT transition to CONNECTED on offer');

    // Even if ICE connection finishes or tracks arrive, receiver must stay in INCOMING_RINGING
    if (manager.peerConnection?.oniceconnectionstatechange) {
      manager.peerConnection.iceConnectionState = 'connected';
      manager.peerConnection.oniceconnectionstatechange();
    }
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING, 'Must NOT transition to CONNECTED on ICE');

    await manager.endCall();
  });

  test('2. Incoming video call stays INCOMING_RINGING before accept', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-video-1',
      callId: 'call-v-1',
      initiator: 'bob-id',
      isVideo: true,
      callType: 'video',
      peerName: 'Bob',
      peerPhone: '+1987654321'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');

    // Offer arriving carries video modality
    manager._handleIncomingOffer('v=0\r\nm=audio 9\r\nm=video 9\r\n', { isVideo: true, callType: 'video' });
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING, 'Video call must remain INCOMING_RINGING');
    assert.equal(manager.isVideo, true, 'Video modality must be preserved');

    await manager.endCall();
  });

  test('3. Incoming voice UI says "Incoming voice call"', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-1',
      callId: 'c1',
      initiator: 'user-1',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice',
      peerPhone: '+1234567890'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Incoming voice call');
    assert.equal(ui.avatarIcon, '📞');
    assert.equal(ui.cardClass, 'is-incoming-voice');
    assert.equal(ui.showAccept, true);
    assert.equal(ui.showDecline, true);
  });

  test('4. Incoming video UI says "Incoming video call"', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-2',
      callId: 'c2',
      initiator: 'user-2',
      isVideo: true,
      callType: 'video',
      peerName: 'Bob',
      peerPhone: '+1987654321'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Incoming video call');
    assert.equal(ui.avatarIcon, '📹');
    assert.equal(ui.cardClass, 'is-incoming-video');
    assert.equal(ui.showAccept, true);
    assert.equal(ui.showDecline, true);
  });

  test('5. Incoming voice UI has no active-call timer before accept', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-1',
      callId: 'c1',
      initiator: 'user-1',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice',
      peerPhone: '+1234567890'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.timerHidden, true, 'Timer must be hidden during INCOMING_RINGING');
    assert.equal(ui.timerText, '00:00');
    assert.equal(manager.durationSec, 0);
  });

  test('6. Incoming video UI has no active-call timer before accept', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-2',
      callId: 'c2',
      initiator: 'user-2',
      isVideo: true,
      callType: 'video',
      peerName: 'Bob',
      peerPhone: '+1987654321'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.timerHidden, true, 'Timer must be hidden for incoming video before accept');
    assert.equal(ui.timerText, '00:00');
    assert.equal(manager.durationSec, 0);
  });

  test('7. Incoming voice does not show Mute/End before accept', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-1',
      callId: 'c1',
      initiator: 'user-1',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.showMute, false, 'Mute button must NOT be shown before accept');
    assert.equal(ui.showEnd, false, 'End button must NOT be shown before accept (only Decline)');
    assert.equal(ui.showAccept, true);
    assert.equal(ui.showDecline, true);
  });

  test('8. Incoming video does not show active video controls before accept', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-2',
      callId: 'c2',
      initiator: 'user-2',
      isVideo: true,
      callType: 'video',
      peerName: 'Bob'
    });

    const ui = computeCallUiState(manager);
    assert.equal(ui.showMute, false, 'Mute must not show before accept');
    assert.equal(ui.showCamera, false, 'Camera button must not show before accept');
    assert.equal(ui.showEnd, false, 'End button must not show before accept');
    assert.notEqual(ui.cardClass, 'is-video-call', 'Must not display full video stage before accept');
  });

  test('9. Accept transitions INCOMING_RINGING → CONNECTING', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-1',
      callId: 'c1',
      initiator: 'user-1',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

    const acceptPromise = manager.acceptCall();
    assert.equal(manager.state, CALL_STATE.CONNECTING);

    await acceptPromise;
    await manager.endCall();
  });

  test('10. Successful voice negotiation reaches CONNECTED', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-1',
      callId: 'c1',
      initiator: 'user-1',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    // Provide offer while ringing
    manager._handleIncomingOffer('v=0\r\nm=audio 9 UDP/SAVPF\r\n', { isVideo: false, callType: 'voice' });
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

    // Accept call answers the preserved offer and transitions to CONNECTED
    await manager.acceptCall();
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Connected');
    assert.equal(ui.showMute, true);
    assert.equal(ui.showEnd, true);
    assert.equal(ui.timerHidden, false);

    await manager.endCall();
  });

  test('11. Successful video negotiation reaches CONNECTED', async () => {
    const { manager, mediaDevices } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-2',
      callId: 'c2',
      initiator: 'user-2',
      isVideo: true,
      callType: 'video',
      peerName: 'Bob'
    });

    manager._handleIncomingOffer('v=0\r\nm=audio 9\r\nm=video 9\r\n', { isVideo: true, callType: 'video' });
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

    // Accept call triggers getUserMedia with video
    await manager.acceptCall();
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.equal(manager.isVideo, true);
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.equal(mediaDevices.getUserMediaCalls[0].video, true, 'Acquires camera on video accept');

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Connected');
    assert.equal(ui.cardClass, 'is-video-call');
    assert.equal(ui.showCamera, true);
    assert.equal(ui.showMute, true);
    assert.equal(ui.showEnd, true);

    await manager.endCall();
  });

  test('12. Video modality is preserved even when only audio track arrives initially', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-v',
      callId: 'cv',
      initiator: 'user-v',
      isVideo: true,
      callType: 'video',
      peerName: 'Charlie'
    });

    await manager.acceptCall();
    assert.equal(manager.isVideo, true);

    // Simulate ontrack with audio-only track
    const audioTrack = new MockTrack('audio');
    if (manager.peerConnection?.ontrack) {
      manager.peerConnection.ontrack({
        track: audioTrack,
        streams: [new MockMediaStream([audioTrack])]
      });
    }

    assert.equal(manager.isVideo, true, 'Must remain video modality after audio track arrives');
    assert.equal(manager.mode, 'video');

    await manager.endCall();
  });

  test('13. Video modality is not downgraded to voice because ontrack fires audio first', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-v',
      callId: 'cv',
      initiator: 'user-v',
      isVideo: true,
      callType: 'video',
      peerName: 'Charlie'
    });

    // Caller's offer specifies audio + video
    manager._handleIncomingOffer('v=0\r\nm=audio 9\r\nm=video 9\r\n', { isVideo: true, callType: 'video' });
    await manager.acceptCall();

    // Fire audio ontrack first
    const audioTrack = new MockTrack('audio');
    manager.peerConnection.ontrack({
      track: audioTrack,
      streams: [new MockMediaStream([audioTrack])]
    });

    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');

    // Fire video ontrack later
    const videoTrack = new MockTrack('video');
    manager.peerConnection.ontrack({
      track: videoTrack,
      streams: [new MockMediaStream([audioTrack, videoTrack])]
    });

    assert.equal(manager.isVideo, true);
    assert.equal(manager.remoteVideoStream !== null, true);

    await manager.endCall();
  });

  test('14. Timer starts only at CONNECTED', async () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-t',
      callId: 'ct',
      initiator: 'user-t',
      isVideo: false,
      callType: 'voice',
      peerName: 'Dan'
    });

    // In ringing state: timer is null
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.durationSec, 0);

    // After accept -> CONNECTING
    manager.state = CALL_STATE.CONNECTING;
    assert.equal(manager._timerInterval, null);

    // Reaching CONNECTED starts the timer
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.notEqual(manager._timerInterval, null, 'Timer must be active at CONNECTED');

    await manager.endCall();
    assert.equal(manager._timerInterval, null, 'Timer must be cleared on end');
  });

  test('15. Caller cancellation while receiver is ringing dismisses the incoming UI', async () => {
    const { manager, ringtone } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-c',
      callId: 'cc',
      initiator: 'user-c',
      isVideo: false,
      callType: 'voice',
      peerName: 'Eve'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(ringtone.isPlaying, true);

    // Caller cancels: remote call ended arrives
    manager.handleRemoteCallEnded({ roomId: 'room-c' });

    assert.equal(manager.state, CALL_STATE.REMOTE_CANCELLED);
    assert.equal(ringtone.isPlaying, false);

    const ui = computeCallUiState(manager);
    assert.equal(ui.statusText, 'Call cancelled');
    assert.equal(ui.showAccept, false);
    assert.equal(ui.showDecline, false);
  });

  test('16. Receiver decline dismisses incoming UI and informs caller using existing supported behavior', async () => {
    const { manager, rtcBridge, ringtone } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-d',
      callId: 'cd',
      initiator: 'user-d',
      isVideo: false,
      callType: 'voice',
      peerName: 'Frank'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);

    await manager.declineCall();

    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(ringtone.isPlaying, false);
    assert.equal(rtcBridge.leaveCalls > 0, true, 'Sends leave to inform caller via RTC');
  });

  test('17. Existing two-sided hangup behavior still passes', async () => {
    const { manager: caller } = createManager();
    const { manager: callee } = createManager();

    // Caller starts call
    const startPromise = caller.startCall('room-sync', 'Callee');
    assert.equal(caller.state, CALL_STATE.OUTGOING_RINGING);

    // Callee receives call
    callee.handleIncomingCall({
      roomId: 'room-sync',
      callId: 'call-sync',
      initiator: 'caller-id',
      peerName: 'Caller'
    });
    assert.equal(callee.state, CALL_STATE.INCOMING_RINGING);

    // Callee accepts and both complete negotiation
    await callee.acceptCall();
    callee._markConnected();
    caller._setState(CALL_STATE.CONNECTING);
    caller._markConnected();

    assert.equal(caller.state, CALL_STATE.CONNECTED);
    assert.equal(callee.state, CALL_STATE.CONNECTED);

    // Caller hangs up
    await caller.endCall();
    assert.equal(caller.state, CALL_STATE.ENDED);
    assert.equal(caller.isEnded, true);

    // Callee receives remote end
    const calleeStates = [];
    callee.on('stateChange', ({ state }) => calleeStates.push(state));
    callee.handleRemoteCallEnded({ roomId: 'room-sync' });
    assert.equal(calleeStates.includes(CALL_STATE.REMOTE_ENDED), true);
    assert.equal(callee.isEnded, true);
  });

  test('18. Caller name/phone identity remains correct', () => {
    const { manager } = createManager();
    manager.handleIncomingCall({
      roomId: 'room-id',
      callId: 'cid',
      initiator: 'uid-555',
      isVideo: true,
      callType: 'video',
      peerName: 'Grace Hopper',
      peerPhone: '+1-555-0199'
    });

    assert.equal(manager.peerName, 'Grace Hopper');
    assert.equal(manager.peerPhone, '+1-555-0199');

    const ui = computeCallUiState(manager);
    assert.equal(ui.peerPhoneShown, true);
  });

  test('RtcWebSocket preserves call_type and is_video in offer events', async () => {
    const rtc = new RtcWebSocket();
    let emitted = null;
    rtc.on('offer', (data) => {
      emitted = data;
    });

    rtc._handleMessage(JSON.stringify({
      type: 'offer',
      room_id: 'r1',
      sdp: 'mock-sdp',
      call_type: 'video',
      is_video: true
    }));

    assert.notEqual(emitted, null);
    assert.equal(emitted.callType, 'video');
    assert.equal(emitted.isVideo, true);
    assert.equal(emitted.sdp, 'mock-sdp');
  });

  test('ChatWebSocket preserves call_type and is_video in call.started events', async () => {
    const chat = new ChatWebSocket();
    let emitted = null;
    chat.on('call.started', (data) => {
      emitted = data;
    });

    chat._handleIncomingFrame({
      type: 'call.started',
      call_id: 'call-101',
      call_type: 'video',
      is_video: true,
      payload: {
        call_id: 'call-101',
        call_type: 'video',
        is_video: true
      }
    });

    assert.notEqual(emitted, null);
    assert.equal(emitted.callType, 'video');
    assert.equal(emitted.isVideo, true);
    assert.equal(emitted.callId, 'call-101');
  });

});
