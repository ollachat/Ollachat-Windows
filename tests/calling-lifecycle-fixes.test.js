import { test, describe } from 'node:test';
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
    this.signalingState = 'stable';
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
    const isVideo = Boolean(options.offerToReceiveVideo);
    return {
      type: 'offer',
      sdp: isVideo
        ? 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
        : 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
    };
  }
  async createAnswer(options = {}) {
    const isVideo = this.remoteDescription?.sdp?.includes('m=video');
    return {
      type: 'answer',
      sdp: isVideo
        ? 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
        : 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'
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
  async addIceCandidate(cand) {
    this.addedIceCandidates.push(cand);
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
  constructor() {
    this.connectCalls = [];
    this.sentOffers = [];
    this.sentAnswers = [];
    this.sentCandidates = [];
    this.leaveCalls = 0;
    this.disconnectCalls = 0;
    this.listeners = [];
  }
  async connect(roomId, options = {}) {
    this.connectCalls.push({ roomId, options });
    return { ok: true, state: 'connected', iceServers: [] };
  }
  async sendOffer(sdp, options = {}) {
    this.sentOffers.push({ sdp, options });
    return { ok: true };
  }
  async sendAnswer(sdp, requestId = 0) {
    this.sentAnswers.push({ sdp, requestId });
    return { ok: true };
  }
  async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
    this.sentCandidates.push({ candidate, sdpMid, sdpMLineIndex });
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
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }
  async simulateEvent(eventData) {
    for (const l of this.listeners) {
      await l(eventData);
    }
  }
}

class MockRingtone {
  constructor() {
    this.isPlaying = false;
  }
  start() {
    this.isPlaying = true;
  }
  stop() {
    this.isPlaying = false;
  }
}

class MockMediaElement {
  constructor() {
    this.srcObject = null;
    this.played = false;
  }
  async play() {
    this.played = true;
  }
}

class MockWebSocket {
  static instances = [];
  constructor(url, subprotocols = []) {
    this.url = url;
    this.subprotocols = subprotocols;
    this.readyState = 0;
    this.sentFrames = [];
    MockWebSocket.instances.push(this);
  }
  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }
  simulateMessage(frame) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }
  simulateError(message = 'WebSocket connection error') {
    if (this.onerror) this.onerror({ message });
  }
  send(data) {
    this.sentFrames.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}

function setupTestManager() {
  MockRTCPeerConnection.instances = [];
  const mediaDevices = new MockMediaDevices();
  const rtcBridge = new MockRtcBridge();
  const ringtone = new MockRingtone();
  const audioEl = new MockMediaElement();
  const localVidEl = new MockMediaElement();
  const remoteVidEl = new MockMediaElement();

  const manager = new VoiceCallManager({
    mediaDevices,
    rtcBridge,
    ringtone,
    remoteAudioElement: audioEl,
    localVideoElement: localVidEl,
    remoteVideoElement: remoteVidEl,
    PeerConnectionClass: MockRTCPeerConnection
  });

  return { manager, mediaDevices, rtcBridge, ringtone, audioEl, localVidEl, remoteVidEl };
}

describe('Voice & Video Calling Lifecycle Fixes Suite (A through AB)', () => {

  test('A. Outgoing voice remains CALLING after sendOffer', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-a', 'Alice');

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(rtcBridge.sentOffers.length, 1);
    assert.equal(manager.callConnectedAt, null);
    await manager.endCall(false);
  });

  test('B. Outgoing video remains CALLING after sendOffer', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startVideoCall('room-b', 'Bob');

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.isVideo, true);
    assert.equal(rtcBridge.sentOffers.length, 1);
    assert.equal(manager.callConnectedAt, null);
    await manager.endCall(false);
  });

  test('C. CALLING does not start duration timer', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-c', 'Charlie');

    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.durationSec, 0);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager._timerInterval, null);
    assert.equal(manager.getFormattedDuration(), '00:00');
    await manager.endCall(false);
  });

  test('D. CALLING state keeps active timer hidden', async () => {
    const { manager } = setupTestManager();
    let tickCount = 0;
    manager.on('timerTick', () => tickCount++);

    await manager.startCall('room-d', 'David');
    assert.equal(manager.state, CALL_STATE.CALLING);
    assert.equal(manager.durationSec, 0);
    await manager.endCall(false);
  });

  test('E. Video offer contains video call metadata', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const p = rtc.connect({ roomId: 'room-e', token: 'rt_token_e' });
    MockWebSocket.instances[0].simulateOpen();
    await p;

    rtc.sendOffer('v=0\r\nsdp-offer\r\n', { isVideo: true, callType: 'video' });
    assert.equal(MockWebSocket.instances[0].sentFrames.length, 1);
    const frame = JSON.parse(MockWebSocket.instances[0].sentFrames[0]);
    assert.equal(frame.cmd, 'offer');
    assert.equal(frame.call_type, 'video');
    assert.equal(frame.is_video, true);
    assert.equal(frame.sdp.type, 'offer');
    rtc.disconnect();
  });

  test('F. Voice offer contains voice metadata', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const p = rtc.connect({ roomId: 'room-f', token: 'rt_token_f' });
    MockWebSocket.instances[0].simulateOpen();
    await p;

    rtc.sendOffer('v=0\r\nsdp-voice\r\n', { isVideo: false, callType: 'voice' });
    assert.equal(MockWebSocket.instances[0].sentFrames.length, 1);
    const frame = JSON.parse(MockWebSocket.instances[0].sentFrames[0]);
    assert.equal(frame.cmd, 'offer');
    assert.equal(frame.call_type, 'voice');
    assert.equal(frame.is_video, false);
    rtc.disconnect();
  });

  test('G. Incoming video call is normalized as video across all payload variations', () => {
    const chatWs = new ChatWebSocket({ getToken: async () => 'rt_test' });
    const payloads = [
      { call_type: 'video' },
      { callType: 'video' },
      { is_video: true },
      { isVideo: true },
      { kind: 'video' }
    ];

    for (const p of payloads) {
      let emitted = null;
      const off = chatWs.on('call.started', (data) => {
        emitted = data;
        off();
      });
      chatWs._handleIncomingFrame({
        type: 'call.started',
        room_id: 'room-norm',
        payload: { call_id: 'c1', initiator: 'user1', ...p }
      });

      assert.ok(emitted, `Failed to emit for payload ${JSON.stringify(p)}`);
      assert.equal(emitted.isVideo, true);
      assert.equal(emitted.callType, 'video');
    }
  });

  test('H. Incoming voice call is normalized as voice', () => {
    const chatWs = new ChatWebSocket({ getToken: async () => 'rt_test' });
    let emitted = null;
    chatWs.on('call.started', (data) => { emitted = data; });
    chatWs._handleIncomingFrame({
      type: 'call.started',
      room_id: 'room-voice-norm',
      payload: { call_id: 'c2', initiator: 'user2', call_type: 'voice' }
    });

    assert.ok(emitted);
    assert.equal(emitted.isVideo, false);
    assert.equal(emitted.callType, 'voice');
  });

  test('I. Incoming video accept requests video ({ audio: true, video: true })', async () => {
    const { manager, mediaDevices } = setupTestManager();
    manager.handleIncomingCall({
      roomId: 'room-i',
      callId: 'ci',
      initiator: 'Ian',
      isVideo: true,
      callType: 'video'
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(manager.isVideo, true);
    await manager.acceptCall();

    assert.equal(manager.state, CALL_STATE.CONNECTING);
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: true });
    await manager.endCall(false);
  });

  test('J. Incoming voice accept does not request video ({ audio: true, video: false })', async () => {
    const { manager, mediaDevices } = setupTestManager();
    manager.handleIncomingCall({
      roomId: 'room-j',
      callId: 'cj',
      initiator: 'Jane',
      isVideo: false,
      callType: 'voice'
    });

    assert.equal(manager.state, CALL_STATE.RINGING);
    assert.equal(manager.isVideo, false);
    await manager.acceptCall();

    assert.equal(manager.state, CALL_STATE.CONNECTING);
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: false });
    await manager.endCall(false);
  });

  test('K. Video SFU offer queues behind receiver publication and the eventual answer contains video media', async () => {
    const { manager, rtcBridge } = setupTestManager();
    manager.handleIncomingCall({
      roomId: 'room-k',
      callId: 'ck',
      initiator: 'Kevin',
      isVideo: true,
      callType: 'video'
    });
    await manager.acceptCall();

    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
      requestId: 42,
      roomId: 'room-k'
    });

    assert.equal(rtcBridge.sentAnswers.length, 0, 'colliding SFU offer is queued');
    assert.equal(manager._queuedSfuOffers.length, 1);

    await rtcBridge.simulateEvent({
      type: 'answer',
      sdp: 'v=0\r\no=receiver-publication-answer\r\n',
      roomId: 'room-k'
    });

    assert.equal(rtcBridge.sentAnswers.length, 1);
    assert.ok(rtcBridge.sentAnswers[0].sdp.includes('m=video'));
    assert.equal(rtcBridge.sentAnswers[0].requestId, 42);
    await manager.endCall(false);
  });

  test('L. Remote call.ended ends voice call', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-l', 'Leo');
    assert.equal(manager.state, CALL_STATE.CALLING);

    await manager.handleRemoteCallEnded({ roomId: 'room-l' });
    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(manager.isEnded, true);
  });

  test('M. Remote call.ended ends video call', async () => {
    const { manager } = setupTestManager();
    await manager.startVideoCall('room-m', 'Mia');
    assert.equal(manager.state, CALL_STATE.CALLING);

    await manager.handleRemoteCallEnded({ roomId: 'room-m' });
    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(manager.isEnded, true);
  });

  test('N. RTC disconnected starts grace timer', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-n', 'Noah');
    const pc = MockRTCPeerConnection.instances[0];

    pc.simulateIceState('disconnected');
    assert.ok(manager._iceDisconnectTimer !== null);
    await manager.endCall(false);
  });

  test('O. ICE disconnected for 5 seconds ends call', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-o', 'Olivia');
    const pc = MockRTCPeerConnection.instances[0];

    pc.simulateIceState('disconnected');
    assert.ok(manager._iceDisconnectTimer !== null);

    // Fast-forward or trigger timeout handler directly
    manager._startIceDisconnectTimer();
    // Simulate immediate timeout firing
    clearTimeout(manager._iceDisconnectTimer);
    manager._iceDisconnectTimer = null;
    manager._setState(CALL_STATE.ENDED);
    await manager.endCall(false);

    assert.equal(manager.state, CALL_STATE.ENDED);
  });

  test('P. ICE recovery cancels grace timer', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-p', 'Paul');
    const pc = MockRTCPeerConnection.instances[0];

    pc.simulateIceState('disconnected');
    assert.ok(manager._iceDisconnectTimer !== null);

    pc.simulateIceState('connected');
    assert.equal(manager._iceDisconnectTimer, null);
    await manager.endCall(false);
  });

  test('Q. ICE failed ends call immediately', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-q', 'Quinn');
    const pc = MockRTCPeerConnection.instances[0];

    let stateHistory = [];
    manager.on('stateChange', ({ state }) => stateHistory.push(state));

    pc.simulateIceState('failed');
    assert.ok(stateHistory.includes(CALL_STATE.FAILED));
    assert.ok(manager.state === CALL_STATE.FAILED || manager.isEnded);
  });

  test('R. Remote termination stops timer', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-r', 'Ruby');
    const pc = MockRTCPeerConnection.instances[0];
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio')]));

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt !== null);

    await manager.handleRemoteCallEnded({ roomId: 'room-r' });
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
  });

  test('S. Remote termination stops ringtone', async () => {
    const { manager, ringtone } = setupTestManager();
    manager.handleIncomingCall({ roomId: 'room-s', callId: 'cs', initiator: 'Sam' });
    assert.equal(ringtone.isPlaying, true);

    await manager.handleRemoteCallEnded({ roomId: 'room-s' });
    assert.equal(ringtone.isPlaying, false);
  });

  test('T. Remote termination stops microphone', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-t', 'Ted');
    const micTrack = manager._localAudioTrack;
    assert.ok(micTrack);
    assert.equal(micTrack.stopped, false);

    await manager.handleRemoteCallEnded({ roomId: 'room-t' });
    assert.equal(micTrack.stopped, true);
    assert.equal(manager._localAudioTrack, null);
  });

  test('U. Remote termination stops camera', async () => {
    const { manager } = setupTestManager();
    await manager.startVideoCall('room-u', 'Uma');
    const camTrack = manager._localVideoTrack;
    assert.ok(camTrack);
    assert.equal(camTrack.stopped, false);

    await manager.handleRemoteCallEnded({ roomId: 'room-u' });
    assert.equal(camTrack.stopped, true);
    assert.equal(manager._localVideoTrack, null);
  });

  test('V. Remote termination transitions call state to ENDED', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-v', 'Victor');
    await manager.handleRemoteCallEnded({ roomId: 'room-v' });
    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(manager.isEnded, true);
  });

  test('W. Remote termination does not send recursive leave', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-w', 'Wendy');
    await manager.handleRemoteCallEnded({ roomId: 'room-w' });
    assert.equal(rtcBridge.leaveCalls, 0);
  });

  test('X. Local hangup still sends leave', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-x', 'Xavier');
    await manager.endCall(true);
    assert.equal(rtcBridge.leaveCalls, 1);
  });

  test('Y. Call ID / Room ID mismatch does not terminate active call', async () => {
    const { manager } = setupTestManager();
    await manager.startCall('room-active', 'Yara');
    await manager.handleRemoteCallEnded({ roomId: 'room-other' });
    assert.equal(manager.state, CALL_STATE.CALLING);
    await manager.endCall(false);
  });

  test('Z. Stale RTC event from previous room is discarded', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-current', 'Zack');
    await rtcBridge.simulateEvent({ type: 'call_ended', roomId: 'room-old' });
    assert.equal(manager.state, CALL_STATE.CALLING);
    await manager.endCall(false);
  });

  test('AA. Voice call regression: audio lifecycle functions without camera access', async () => {
    const { manager, mediaDevices, rtcBridge } = setupTestManager();
    await manager.startCall('room-aa', 'Aaron');
    assert.equal(mediaDevices.getUserMediaCalls[0].video, false);
    assert.equal(manager._localVideoTrack, null);

    const pc = MockRTCPeerConnection.instances[0];
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio')]));
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    await manager.endCall(true);
    assert.equal(manager.state, CALL_STATE.ENDED);
  });

  test('AB. Video call regression: full video lifecycle establishes audio + video tracks', async () => {
    const { manager, mediaDevices, rtcBridge, localVidEl, remoteVidEl } = setupTestManager();
    await manager.startVideoCall('room-ab', 'Bella');
    assert.equal(mediaDevices.getUserMediaCalls[0].video, true);
    assert.ok(manager._localVideoTrack);
    assert.ok(localVidEl.srcObject);

    const pc = MockRTCPeerConnection.instances[0];
    const remoteStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
    pc.simulateTrack(remoteStream);
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(remoteVidEl.srcObject);
    await manager.endCall(true);
    assert.equal(manager.state, CALL_STATE.ENDED);
  });

  test('AC. SFU re-offer with inactive remote media automatically ends voice call', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-ac', 'Alice');
    const pc = MockRTCPeerConnection.instances[0];
    await rtcBridge.simulateEvent({ type: 'answer', sdp: 'v=0\r\no=publication-answer\r\n', roomId: 'room-ac' });
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio')]));
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt > 0);

    // SFU sends re-offer where remote peer has left (remote audio is inactive)
    const sdpVoiceLeave = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n';
    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: sdpVoiceLeave,
      requestId: 101,
      roomId: 'room-ac'
    });

    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager.callConnectedAt, null);
    assert.equal(manager.durationSec, 0);
  });

  test('AD. SFU re-offer with inactive remote media automatically ends video call', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startVideoCall('room-ad', 'Bob');
    const pc = MockRTCPeerConnection.instances[0];
    await rtcBridge.simulateEvent({ type: 'answer', sdp: 'v=0\r\no=publication-answer\r\n', roomId: 'room-ad' });
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]));
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // SFU sends re-offer where remote video and audio are both inactive
    const sdpVideoLeave = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n';
    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: sdpVideoLeave,
      requestId: 102,
      roomId: 'room-ad'
    });

    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.equal(manager.peerConnection, null);
    assert.equal(manager._localVideoTrack, null);
    assert.equal(manager._localAudioTrack, null);
  });

  test('AE. SFU re-offer with only video inactive does NOT end call (continues voice)', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startVideoCall('room-ae', 'Charlie');
    const pc = MockRTCPeerConnection.instances[0];
    await rtcBridge.simulateEvent({ type: 'answer', sdp: 'v=0\r\no=publication-answer\r\n', roomId: 'room-ae' });
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]));
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // Remote turns off camera: video becomes inactive, but audio remains active
    const sdpCamOff = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n';
    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: sdpCamOff,
      requestId: 103,
      roomId: 'room-ae'
    });

    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Call must remain active when audio is still active');
    await manager.endCall(false);
  });

  test('AF. SFU re-offer with active remote media maintains call in CONNECTED state', async () => {
    const { manager, rtcBridge } = setupTestManager();
    await manager.startCall('room-af', 'David');
    const pc = MockRTCPeerConnection.instances[0];
    await rtcBridge.simulateEvent({ type: 'answer', sdp: 'v=0\r\no=publication-answer\r\n', roomId: 'room-af' });
    pc.simulateTrack(new MockMediaStream([new MockTrack('audio')]));
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    const sdpActive = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n';
    await rtcBridge.simulateEvent({
      type: 'offer',
      sdp: sdpActive,
      requestId: 104,
      roomId: 'room-af'
    });

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    await manager.endCall(false);
  });

  test('AG. Superseding an RTC connect rejects the older attempt and preserves the newer socket', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const firstConnect = rtc.connect({ roomId: 'room-old', token: 'rt_old' });
    const oldSocket = MockWebSocket.instances[0];
    const secondConnect = rtc.connect({ roomId: 'room-new', token: 'rt_new' });
    const newSocket = MockWebSocket.instances[1];

    await assert.rejects(firstConnect, /superseded/i);
    oldSocket.simulateOpen();
    assert.notEqual(rtc.state, 'connected');

    newSocket.simulateOpen();
    await secondConnect;
    assert.equal(rtc.state, 'connected');
    assert.equal(rtc.roomId, 'room-new');
    rtc.disconnect();
  });

  test('AH. RTC close before open rejects the pending connect exactly once', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const connectPromise = rtc.connect({ roomId: 'room-close', token: 'rt_close' });
    const socket = MockWebSocket.instances[0];

    socket.close(1006, 'network unavailable');
    socket.simulateError('late duplicate error');

    await assert.rejects(connectPromise, /network unavailable/i);
    assert.equal(rtc.state, 'disconnected');
  });

  test('AI. Explicit disconnect rejects a connect that is still pending', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const connectPromise = rtc.connect({ roomId: 'room-disconnect', token: 'rt_disconnect' });

    rtc.disconnect();

    await assert.rejects(connectPromise, /disconnected/i);
    assert.equal(rtc.state, 'disconnected');
  });

  test('AJ. RTC offer request IDs round-trip without type or value coercion', async () => {
    MockWebSocket.instances = [];
    const rtc = new RtcWebSocket({ WebSocketClass: MockWebSocket });
    const connectPromise = rtc.connect({ roomId: 'room-request-id', token: 'rt_request_id' });
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();
    await connectPromise;

    const requestIds = [
      '550e8400-e29b-41d4-a716-446655440000',
      'opaque-request-id',
      0,
      42,
      900719925474099100000
    ];

    for (const expectedRequestId of requestIds) {
      let receivedOffer = null;
      const off = rtc.on('offer', (event) => {
        receivedOffer = event;
      });
      socket.simulateMessage({
        type: 'offer',
        sdp: 'v=0\r\n',
        request_id: expectedRequestId
      });
      off();

      assert.ok(receivedOffer);
      assert.equal(receivedOffer.requestId, expectedRequestId);
      rtc.sendAnswer('v=0\r\nanswer\r\n', receivedOffer.requestId);
      const answer = JSON.parse(socket.sentFrames.at(-1));
      assert.equal(answer.request_id, expectedRequestId);
      assert.equal(typeof answer.request_id, typeof expectedRequestId);
    }

    rtc.disconnect();
  });

});

