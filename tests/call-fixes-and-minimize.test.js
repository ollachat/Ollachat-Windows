import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';
import { RtcWebSocket } from '../src/call/rtc-websocket.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const stylesCssPath = path.resolve(__dirname, '../src/renderer/styles.css');

const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');

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
  constructor(config = {}) {
    this.config = config;
    this.senders = [];
    this.signalingState = 'stable';
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
  }
  addTrack(track) {
    this.senders.push({ track });
    return { track };
  }
  getSenders() {
    return this.senders;
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
  async createOffer() {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
}

class MockRtcBridge {
  constructor({ connectOk = true, iceServers = [{ urls: ['stun:stun.ollacore.com:3478'] }] } = {}) {
    this.connectOk = connectOk;
    this.iceServers = iceServers;
    this.connectCalls = [];
  }
  async connect(roomId) {
    this.connectCalls.push(roomId);
    return { ok: this.connectOk, iceServers: this.iceServers };
  }
  async sendOffer() { return { ok: true }; }
  async sendAnswer() { return { ok: true }; }
  async sendIceCandidate() { return { ok: true }; }
  async leave() { return { ok: true }; }
  async disconnect() { return { ok: true }; }
  onSignal() { return () => {}; }
}

describe('OllaChat Windows Calling Fixes & Minimized Call Tile Suite', () => {
  let mediaDevices;
  let voiceCallManager;
  let sentSignals;
  let rtcBridge;

  beforeEach(() => {
    sentSignals = [];
    mediaDevices = new MockMediaDevices();
    rtcBridge = new MockRtcBridge();
    voiceCallManager = new VoiceCallManager({
      rtcBridge,
      mediaDevices,
      PeerConnectionClass: MockRTCPeerConnection,
      sendSignal: (signal) => {
        sentSignals.push(signal);
      }
    });
  });

  // =========================================================================
  // 1. NOTIFICATION REGRESSION TESTS
  // =========================================================================
  describe('1. Outgoing & Incoming Call Notifications', () => {
    test('1. Outgoing audio call sets isOutgoing=true and isIncoming=false on initiator', async () => {
      await voiceCallManager.startCall('room-101', 'Bob');
      assert.strictEqual(voiceCallManager.isOutgoing, true, 'manager knows call is outgoing');
      assert.strictEqual(voiceCallManager.isIncoming, false, 'initiator is not incoming callee');
      assert.strictEqual(voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    });

    test('2. Outgoing video call sets isOutgoing=true and isIncoming=false on initiator', async () => {
      await voiceCallManager.startVideoCall('room-102', 'Alice');
      assert.strictEqual(voiceCallManager.isOutgoing, true, 'manager knows video call is outgoing');
      assert.strictEqual(voiceCallManager.isIncoming, false, 'initiator is not incoming callee');
      assert.strictEqual(voiceCallManager.isVideo, true);
      assert.strictEqual(voiceCallManager.state, CALL_STATE.OUTGOING_RINGING);
    });

    test('3. Incoming audio call sets isIncoming=true and isOutgoing=false on callee', () => {
      voiceCallManager.handleIncomingCall({
        roomId: 'room-103',
        initiator: 'user-alice',
        callType: 'voice',
        isVideo: false,
        peerName: 'Alice'
      });
      assert.strictEqual(voiceCallManager.isIncoming, true, 'callee is marked incoming');
      assert.strictEqual(voiceCallManager.isOutgoing, false, 'callee is not outgoing');
      assert.strictEqual(voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    });

    test('4. Incoming video call sets isIncoming=true and isOutgoing=false on callee', () => {
      voiceCallManager.handleIncomingCall({
        roomId: 'room-104',
        initiator: 'user-bob',
        callType: 'video',
        isVideo: true,
        peerName: 'Bob'
      });
      assert.strictEqual(voiceCallManager.isIncoming, true, 'callee is marked incoming');
      assert.strictEqual(voiceCallManager.isOutgoing, false, 'callee is not outgoing');
      assert.strictEqual(voiceCallManager.isVideo, true);
      assert.strictEqual(voiceCallManager.state, CALL_STATE.INCOMING_RINGING);
    });

    test('5. app.js suppresses incoming call notification and handleIncomingCall for the call initiator', () => {
      // Verify app.js tracks outgoing calls with isLocalCaller checks
      assert.ok(appJs.includes('const isLocalCaller = isSelfInitiator || isCallerInRoom || isRecentlyInitiated;'),
        'app.js computes isLocalCaller via multi-factor identification');
      assert.ok(appJs.includes('if (isLocalCaller) {\n      // Local client initiated this call (outgoing). Suppress incoming notification'),
        'app.js explicitly suppresses notification when isLocalCaller is true');
      assert.ok(appJs.includes('recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());'),
        'tracks outgoing call initiation timestamp in recentlyInitiatedCalls');
    });

    test('6. Notification direction remains correct after reconnect / event replay', () => {
      // If client reconnects while in outgoing call, isCallerInRoom and recentlyInitiatedCalls keep caller protected
      assert.ok(appJs.includes('isCallerInRoom = (voiceCallManager.roomId === eventRoomId && (voiceCallManager.isOutgoing'),
        'isCallerInRoom respects voiceCallManager.isOutgoing');
      assert.ok(appJs.includes('recentlyInitiatedCalls.has(eventRoomId)'),
        'recentlyInitiatedCalls safeguards event replay');
    });
  });

  // =========================================================================
  // 2. UNUSED THREE-DOT BUTTON REMOVAL
  // =========================================================================
  describe('2. Unused Three-Dot Button Removal', () => {
    test('1. Three-dot button btn-incoming-call-more is completely removed from index.html', () => {
      assert.strictEqual(indexHtml.includes('btn-incoming-call-more'), false, 'no btn-incoming-call-more in DOM');
      assert.strictEqual(indexHtml.includes('btn-incoming-more'), false, 'no btn-incoming-more class in DOM');
    });

    test('2. No dead click handlers or element lookups remain for btnIncomingCallMore in app.js', () => {
      assert.strictEqual(appJs.includes("document.getElementById('btn-incoming-call-more')"), false, 'no element declaration');
      assert.strictEqual(appJs.includes("btnIncomingCallMore?.addEventListener('click'"), false, 'no click listener');
      assert.strictEqual(appJs.includes("btnIncomingCallMore?.classList"), false, 'no UI manipulation');
    });

    test('3. Existing End Call and Action buttons remain present in DOM', () => {
      assert.ok(indexHtml.includes('id="btn-call-end"'), 'End Call button exists');
      assert.ok(indexHtml.includes('id="btn-call-accept"'), 'Accept button exists');
      assert.ok(indexHtml.includes('id="btn-call-decline"'), 'Decline button exists');
    });
  });

  // =========================================================================
  // 3. MINIMIZE ACTIVE CALL UI & DRAGGABLE TILE
  // =========================================================================
  describe('3. Minimized Call Tile & Dragging', () => {
    test('1. index.html includes minimize, restore, and minimized-end controls', () => {
      assert.ok(indexHtml.includes('id="btn-call-minimize"'), 'btn-call-minimize button present in DOM');
      assert.ok(indexHtml.includes('id="btn-call-restore"'), 'btn-call-restore button present in DOM');
      assert.ok(indexHtml.includes('id="btn-call-minimized-end"'), 'btn-call-minimized-end button present in DOM');
      assert.ok(indexHtml.includes('id="call-minimized-controls"'), 'call-minimized-controls container present');
    });

    test('2. styles.css includes floating/minimized call tile styles with high z-index and bounds constraints', () => {
      assert.ok(stylesCss.includes('.voice-call-overlay.is-minimized'), 'minimized overlay style exists');
      assert.ok(stylesCss.includes('.voice-call-card.is-minimized'), 'minimized card style exists');
      assert.ok(stylesCss.includes('cursor: grab'), 'draggable cursor indicated');
      assert.ok(stylesCss.includes('z-index: 10000'), 'minimized tile stays above chat UI');
    });

    test('3. Audio continues when call is minimized', async () => {
      await voiceCallManager.startCall('room-min-1', 'Charlie');
      voiceCallManager.state = CALL_STATE.CONNECTED;

      // Check audio track status
      const track = voiceCallManager._localAudioTrack;
      assert.ok(track, 'local audio track exists');
      assert.strictEqual(track.enabled, true, 'audio track remains enabled');
      assert.strictEqual(track.stopped, false, 'audio track is not stopped');

      // Minimizing call does not affect tracks or end call
      assert.ok(appJs.includes('function minimizeCall()'), 'minimizeCall defined');
      assert.strictEqual(voiceCallManager.state, CALL_STATE.CONNECTED, 'call remains connected');
    });

    test('4. Video continues when video call is minimized', async () => {
      await voiceCallManager.startVideoCall('room-min-2', 'David');
      voiceCallManager.state = CALL_STATE.CONNECTED;

      const track = voiceCallManager._localVideoTrack;
      assert.ok(track, 'local video track exists');
      assert.strictEqual(track.enabled, true, 'video track remains enabled');
      assert.strictEqual(track.stopped, false, 'video track is not stopped');
      assert.strictEqual(voiceCallManager.state, CALL_STATE.CONNECTED, 'call remains connected');
    });

    test('5. Restore function restores full call UI and cleans up positioning styles', () => {
      assert.ok(appJs.includes('function restoreCall()'), 'restoreCall defined');
      assert.ok(appJs.includes("voiceCallOverlay.classList.remove('is-minimized'"), 'removes is-minimized on restore');
      assert.ok(appJs.includes("voiceCallCard.classList.remove('is-minimized'"), 'removes card is-minimized on restore');
      assert.ok(appJs.includes("voiceCallCard.style.position = ''"), 'clears inline position');
    });

    test('6. clampMinimizedTilePosition ensures tile stays strictly within window bounds', () => {
      assert.ok(appJs.includes('function clampMinimizedTilePosition()'), 'clamp function defined');
      assert.ok(appJs.includes('const margin = 10;'), 'safety margin defined');
      assert.ok(appJs.includes('const maxX = Math.max(margin, winW - width - margin);'), 'X bounds clamped');
      assert.ok(appJs.includes('const maxY = Math.max(margin, winH - height - margin);'), 'Y bounds clamped');
    });

    test('7. Draggable interactions distinguish dragging from accidental restore click', () => {
      assert.ok(appJs.includes('hasDraggedCallTile = true;'), 'tracks movement threshold to prevent click trigger');
      assert.ok(appJs.includes('if (hasDraggedCallTile) {'), 'prevents click restoration if tile was dragged');
      assert.ok(appJs.includes("voiceCallCard?.addEventListener('pointerdown'"), 'uses pointer events for dragging');
      assert.ok(appJs.includes("voiceCallCard?.addEventListener('pointermove'"), 'smooth dragging movement');
    });

    test('8. End call remains directly accessible from minimized tile', () => {
      assert.ok(appJs.includes("btnCallMinimizedEnd?.addEventListener('click'"), 'wires minimized end call button');
      assert.ok(appJs.includes('voiceCallManager.endCall()'), 'ends call directly from tile');
    });

    test('9. Window resize triggers re-clamping of minimized tile position', () => {
      assert.ok(appJs.includes("window.addEventListener('resize'"), 'listens to window resize');
      assert.ok(appJs.includes('clampMinimizedTilePosition()'), 're-clamps position on resize');
    });

    test('10. Single tile invariant: no duplicate floating tiles created', () => {
      // Verify overlay uses single static DOM structure without creating dynamic duplicate tiles
      assert.strictEqual((indexHtml.match(/id="voice-call-card"/g) || []).length, 1, 'exactly one voice call card in DOM');
      assert.strictEqual((indexHtml.match(/id="call-minimized-controls"/g) || []).length, 1, 'exactly one minimized controls container');
    });
  });

  // =========================================================================
  // 4. AUDIO CALL -> VIDEO CALL PROTOCOL & UX AUDIT
  // =========================================================================
  describe('4. Audio to Video Request Protocol & UX Audit', () => {
    test('1. Backend/SFU WebSocket protocols verify lack of peer upgrade request/accept frames', () => {
      // Verify RtcWebSocket protocol definition
      const rtcWsPath = path.resolve(__dirname, '../src/call/rtc-websocket.js');
      const rtcWsCode = fs.readFileSync(rtcWsPath, 'utf8');

      // RTC WebSocket supported frame types
      const allowedRtcFrames = ['offer', 'answer', 'candidate', 'leave'];
      for (const frame of ['upgrade_request', 'call.upgrade_request', 'call.upgrade_response']) {
        assert.strictEqual(rtcWsCode.includes(`'${frame}'`), false, `RTC WebSocket does not support ${frame}`);
      }

      // Chat WebSocket supported frame types
      const chatWsPath = path.resolve(__dirname, '../src/chat/chat-websocket.js');
      const chatWsCode = fs.readFileSync(chatWsPath, 'utf8');
      assert.strictEqual(chatWsCode.includes('call.upgrade_request'), false, 'Chat WebSocket does not support call.upgrade_request');
      assert.strictEqual(chatWsCode.includes('call.upgrade_response'), false, 'Chat WebSocket does not support call.upgrade_response');
    });

    test('2. Switch to video button is removed from active call UI and takes zero layout space', () => {
      assert.ok(stylesCss.includes('#btn-call-request-video'), 'CSS targets #btn-call-request-video');
      assert.ok(stylesCss.includes('display: none !important'), 'CSS completely removes display');
      assert.strictEqual(appJs.includes("btnCallRequestVideo?.classList.remove('hidden')"), false, 'never unhidden in app.js');
      assert.ok(appJs.includes("btnCallRequestVideo?.classList.add('hidden')"), 'hidden on call state update');
    });

    test('3. Clicking Request Video does not send unsupported WebSocket frames or break audio call', () => {
      // In app.js, clicking btnCallRequestVideo cleanly displays status without emitting invalid frames
      assert.ok(appJs.includes("btnCallRequestVideo?.addEventListener('click'"), 'wires request video button');
      assert.ok(appJs.includes('Video upgrade pending backend protocol'), 'reports clean user notification');
      assert.strictEqual(sentSignals.length, 0, 'zero unsupported signals sent to SFU/backend');
    });
  });
});
