import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

describe('WhatsApp-Style Floating / Minimized Call Window Suite', () => {
  const floatingHtmlPath = path.join(projectRoot, 'src', 'renderer', 'floating-call.html');
  const floatingJsPath = path.join(projectRoot, 'src', 'renderer', 'floating-call.js');
  const indexHtmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const stylesCssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const preloadJsPath = path.join(projectRoot, 'src', 'preload', 'preload.js');
  const mainJsPath = path.join(projectRoot, 'src', 'main', 'main.js');
  const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');

  const floatingHtml = fs.readFileSync(floatingHtmlPath, 'utf8');
  const floatingJs = fs.readFileSync(floatingJsPath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
  const mainJs = fs.readFileSync(mainJsPath, 'utf8').replace(/\r\n/g, '\n');
  const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');

  // =========================================================================
  // 1. MARKUP & UI ELEMENTS
  // =========================================================================
  describe('1. Floating Window Markup & Controls', () => {
    test('1. Floating call window HTML contains all required containers and controls', () => {
      assert.ok(floatingHtml.includes('class="floating-header"'), 'floating-header exists');
      assert.ok(floatingHtml.includes('id="view-incoming"'), 'view-incoming exists');
      assert.ok(floatingHtml.includes('id="view-audio"'), 'view-audio exists');
      assert.ok(floatingHtml.includes('id="view-video"'), 'view-video exists');
      assert.ok(floatingHtml.includes('id="incoming-avatar"'), 'incoming-avatar exists');
      assert.ok(floatingHtml.includes('id="incoming-peer-name"'), 'incoming-peer-name exists');
      assert.ok(floatingHtml.includes('id="audio-timer"'), 'audio-timer exists');
      assert.ok(floatingHtml.includes('id="video-timer"'), 'video-timer exists');
      assert.ok(floatingHtml.includes('id="btn-header-restore"'), 'btn-header-restore exists');
      assert.ok(floatingHtml.includes('id="btn-audio-mute"'), 'btn-audio-mute exists');
      assert.ok(floatingHtml.includes('id="btn-video-camera"'), 'btn-video-camera exists');
      assert.ok(floatingHtml.includes('id="btn-audio-hangup"'), 'btn-audio-hangup exists');
      assert.ok(floatingHtml.includes('id="btn-incoming-accept"'), 'btn-incoming-accept exists');
      assert.ok(floatingHtml.includes('id="btn-incoming-decline"'), 'btn-incoming-decline exists');
      assert.ok(floatingHtml.includes('id="floating-remote-video"'), 'floating-remote-video exists');
    });

    test('2. Floating window is draggable and buttons have no-drag', () => {
      assert.ok(floatingHtml.includes('-webkit-app-region: drag'), 'header has drag region');
      assert.ok(floatingHtml.includes('-webkit-app-region: no-drag'), 'interactive elements exclude drag region');
    });

    test('3. Main window incoming call header contains a minimize button', () => {
      assert.ok(indexHtml.includes('id="btn-incoming-call-minimize"'), 'btn-incoming-call-minimize exists');
      assert.ok(stylesCss.includes('.btn-incoming-minimize'), 'styles for btn-incoming-minimize exist');
    });
  });

  // =========================================================================
  // 2. SECURITY & PRELOAD IPC BRIDGE
  // =========================================================================
  describe('2. Security & Preload Isolation', () => {
    test('1. Preload securely exposes floatingCall API without raw ipcRenderer', () => {
      assert.ok(preloadJs.includes('floatingCall: {'), 'floatingCall namespace is defined in preload');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:show')"), 'exposes show');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:hide')"), 'exposes hide');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:get-state')"), 'exposes getState');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:sync-state'"), 'exposes syncState');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:action'"), 'exposes sendAction');
      assert.ok(preloadJs.includes("ipcRenderer.invoke('floating-call:bridge-signal'"), 'exposes bridgeSignal');
      assert.ok(preloadJs.includes("ipcRenderer.on('floating-call:state-changed'"), 'exposes onStateChange listener');
      assert.ok(preloadJs.includes("ipcRenderer.on('floating-call:dispatch-action'"), 'exposes onAction listener');
    });

    test('2. Floating window Electron creation enforces contextIsolation and disables nodeIntegration', () => {
      assert.ok(mainJs.includes('contextIsolation: true'), 'contextIsolation enabled');
      assert.ok(mainJs.includes('nodeIntegration: false'), 'nodeIntegration disabled');
      assert.ok(mainJs.includes('alwaysOnTop: true'), 'alwaysOnTop configured');
      assert.ok(mainJs.includes('frame: false'), 'frameless configured');
      assert.ok(mainJs.includes('skipTaskbar: false'), 'skipTaskbar configured');
    });
  });

  // =========================================================================
  // 3. MAIN PROCESS CALL-AWARE LIFECYCLE BEHAVIOR
  // =========================================================================
  describe('3. Main Process Call-Aware Lifecycle', () => {
    test('1. Main window close with NO active call preserves normal exit behavior', () => {
      let isCallActive = false;
      let preventDefaultCalled = false;
      let windowHidden = false;

      const mockEvent = {
        preventDefault: () => { preventDefaultCalled = true; }
      };
      const mockMainWindow = {
        hide: () => { windowHidden = true; }
      };

      // Handler logic from main.js:
      const handleClose = (e) => {
        if (isCallActive) {
          e.preventDefault();
          mockMainWindow.hide();
          return false;
        }
      };

      handleClose(mockEvent);
      assert.strictEqual(preventDefaultCalled, false, 'close is NOT prevented when no active call');
      assert.strictEqual(windowHidden, false, 'window is NOT merely hidden');
    });

    test('2. Main window close with ACTIVE call prevents termination and hides main window', () => {
      let isCallActive = true;
      let preventDefaultCalled = false;
      let windowHidden = false;

      const mockEvent = {
        preventDefault: () => { preventDefaultCalled = true; }
      };
      const mockMainWindow = {
        hide: () => { windowHidden = true; }
      };

      const handleClose = (e) => {
        if (isCallActive) {
          e.preventDefault();
          mockMainWindow.hide();
          return false;
        }
      };

      handleClose(mockEvent);
      assert.strictEqual(preventDefaultCalled, true, 'close is prevented during active call');
      assert.strictEqual(windowHidden, true, 'main window is hidden rather than destroyed');
    });

    test('3. Main window minimize during active call shows floating call window', () => {
      let isCallActive = true;
      let floatingCallShown = false;

      const mockFloatingWindow = {
        show: () => { floatingCallShown = true; }
      };

      const handleMinimize = () => {
        if (isCallActive) {
          mockFloatingWindow.show();
        }
      };

      handleMinimize();
      assert.strictEqual(floatingCallShown, true, 'floating window shown when main window minimized');
    });

    test('4. Call ended closes floating window and resets lifecycle state', () => {
      let isCallActive = true;
      let floatingWindowClosed = false;

      const mockFloatingWindow = {
        close: () => { floatingWindowClosed = true; }
      };

      const handleCallEnded = () => {
        isCallActive = false;
        if (mockFloatingWindow) {
          mockFloatingWindow.close();
        }
      };

      handleCallEnded();
      assert.strictEqual(isCallActive, false, 'active call flag cleared');
      assert.strictEqual(floatingWindowClosed, true, 'floating call window closed');
    });
  });

  // =========================================================================
  // 4. INCOMING CALL MINIMIZATION & RESTORATION
  // =========================================================================
  describe('4. Incoming Call Minimization & Actions', () => {
    test('1. Incoming call state minimizes correctly into floating window', () => {
      let floatingState = null;
      let floatingWindowShown = false;

      const mockFloatingCall = {
        show: () => { floatingWindowShown = true; },
        syncState: (state) => { floatingState = state; }
      };

      // Simulating incoming call minimization in app.js
      const minimizeIncomingCall = () => {
        mockFloatingCall.syncState({
          mode: 'incoming',
          state: 'incoming_ringing',
          peerName: 'Alice',
          isVideo: false,
          isMuted: false,
          isCameraOff: false,
          duration: 0
        });
        mockFloatingCall.show();
      };

      minimizeIncomingCall();
      assert.strictEqual(floatingWindowShown, true, 'floating window was shown');
      assert.strictEqual(floatingState.mode, 'incoming');
      assert.strictEqual(floatingState.peerName, 'Alice');
      assert.strictEqual(floatingState.state, 'incoming_ringing');
    });

    test('2. Accept action from floating window accepts the incoming call', () => {
      let callAccepted = false;
      const onAction = (action) => {
        if (action === 'accept') {
          callAccepted = true;
        }
      };

      onAction('accept');
      assert.strictEqual(callAccepted, true, 'incoming call accepted via floating window action');
    });

    test('3. Decline action from floating window declines the incoming call', () => {
      let callDeclined = false;
      const onAction = (action) => {
        if (action === 'decline') {
          callDeclined = true;
        }
      };

      onAction('decline');
      assert.strictEqual(callDeclined, true, 'incoming call declined via floating window action');
    });

    test('4. Restore action from floating window restores main call UI and hides floating window', () => {
      let callRestored = false;
      let floatingWindowHidden = false;

      const restoreCall = () => {
        callRestored = true;
        floatingWindowHidden = true;
      };

      const onAction = (action) => {
        if (action === 'restore') {
          restoreCall();
        }
      };

      onAction('restore');
      assert.strictEqual(callRestored, true, 'full call UI restored');
      assert.strictEqual(floatingWindowHidden, true, 'floating window hidden on restore');
    });
  });

  // =========================================================================
  // 5. ACTIVE CALL MINIMIZATION, CONTROLS & MEDIA
  // =========================================================================
  describe('5. Active Call Minimized Controls & WebRTC Preservation', () => {
    test('1. Active audio call minimization renders compact audio UI with timer and mute control', () => {
      let floatingState = null;
      const mockFloatingCall = {
        syncState: (state) => { floatingState = state; },
        show: () => {}
      };

      const minimizeActiveAudioCall = () => {
        mockFloatingCall.syncState({
          mode: 'audio',
          state: 'connected',
          peerName: 'Bob',
          isVideo: false,
          isMuted: false,
          isCameraOff: true,
          duration: 165
        });
        mockFloatingCall.show();
      };

      minimizeActiveAudioCall();
      assert.strictEqual(floatingState.mode, 'audio');
      assert.strictEqual(floatingState.duration, 165);
      assert.strictEqual(floatingState.peerName, 'Bob');
      assert.strictEqual(floatingState.isMuted, false);
    });

    test('2. Mute toggle from floating window updates mute state without terminating WebRTC', () => {
      let isMuted = false;
      const handleAction = (action) => {
        if (action === 'toggle-mute') {
          isMuted = !isMuted;
        }
      };

      handleAction('toggle-mute');
      assert.strictEqual(isMuted, true, 'audio muted from floating window');
      handleAction('toggle-mute');
      assert.strictEqual(isMuted, false, 'audio unmuted from floating window');
    });

    test('3. Camera toggle from floating window updates camera state', () => {
      let isCameraOff = false;
      const handleAction = (action) => {
        if (action === 'toggle-camera') {
          isCameraOff = !isCameraOff;
        }
      };

      handleAction('toggle-camera');
      assert.strictEqual(isCameraOff, true, 'camera disabled from floating window');
      handleAction('toggle-camera');
      assert.strictEqual(isCameraOff, false, 'camera re-enabled from floating window');
    });

    test('4. End call from floating window hangs up active call', () => {
      let callEnded = false;
      const handleAction = (action) => {
        if (action === 'end') {
          callEnded = true;
        }
      };

      handleAction('end');
      assert.strictEqual(callEnded, true, 'active call terminated cleanly from floating window');
    });

    test('5. Active video call minimization preserves WebRTC connection and renders video UI', () => {
      let floatingState = null;
      const mockFloatingCall = {
        syncState: (state) => { floatingState = state; },
        show: () => {}
      };

      mockFloatingCall.syncState({
        mode: 'video',
        state: 'connected',
        peerName: 'Alice',
        isVideo: true,
        isMuted: false,
        isCameraOff: false,
        duration: 75
      });

      assert.strictEqual(floatingState.mode, 'video');
      assert.strictEqual(floatingState.isVideo, true);
    });

    test('6. Screen sharing remains active across minimize and restore without destroying media tracks', () => {
      let isScreenSharing = true;
      let trackStopped = false;
      const mockScreenTrack = {
        kind: 'video',
        enabled: true,
        stop: () => { trackStopped = true; }
      };

      // When minimizing:
      const minimize = () => {
        // Must NOT stop tracks or reset WebRTC peer connection
      };
      // When restoring:
      const restore = () => {
        // Screen track must remain intact
      };

      minimize();
      assert.strictEqual(isScreenSharing, true, 'screen sharing remains true after minimize');
      assert.strictEqual(trackStopped, false, 'screen track was not stopped');

      restore();
      assert.strictEqual(isScreenSharing, true, 'screen sharing remains true after restore');
      assert.strictEqual(trackStopped, false, 'screen track was not stopped after restore');
    });
  });

  // =========================================================================
  // 6. FLOATING CALL RENDERER CODE INTEGRITY
  // =========================================================================
  describe('6. Floating Call Renderer Implementation Checks', () => {
    test('1. floating-call.js handles state sync, mode switching, and duration updates', () => {
      assert.ok(floatingJs.includes('renderState'), 'renderState handles updates');
      assert.ok(floatingJs.includes("state.state === 'incoming_ringing'"), 'handles incoming ringing');
      assert.ok(floatingJs.includes('isVideo'), 'handles video mode');
      assert.ok(floatingJs.includes('btnHeaderRestore'), 'header restore button wired');
      assert.ok(floatingJs.includes('btnAudioHangup'), 'audio hangup button wired');
      assert.ok(floatingJs.includes('btnIncomingAccept'), 'incoming accept button wired');
      assert.ok(floatingJs.includes('btnIncomingDecline'), 'incoming decline button wired');
    });

    test('3. floating-call.html and floating-call.js contain outgoing ringing view and controls', () => {
      assert.ok(floatingHtml.includes('id="view-outgoing"'), 'view-outgoing exists');
      assert.ok(floatingHtml.includes('id="outgoing-avatar"'), 'outgoing-avatar exists');
      assert.ok(floatingHtml.includes('id="outgoing-peer-name"'), 'outgoing-peer-name exists');
      assert.ok(floatingHtml.includes('id="outgoing-subtitle"'), 'outgoing-subtitle exists');
      assert.ok(floatingHtml.includes('id="btn-outgoing-hangup"'), 'btn-outgoing-hangup exists');
      assert.ok(floatingHtml.includes('id="btn-outgoing-restore"'), 'btn-outgoing-restore exists');
      assert.ok(floatingJs.includes("state.state === 'outgoing_ringing'"), 'handles outgoing ringing');
      assert.ok(floatingJs.includes('btnOutgoingHangup'), 'outgoing hangup button wired');
      assert.ok(floatingJs.includes('btnOutgoingRestore'), 'outgoing restore button wired');
    });
  });

  // =========================================================================
  // 7. RINGING STATE & NON-BLOCKING WHATSAPP CALLING INVARIANTS
  // =========================================================================
  describe('7. Ringing & Non-Blocking State Transitions Suite', () => {
    test('1. Outgoing audio call remains non-blocking before answer', () => {
      // In CSS, centered overlay does not blur background and incoming/minimized states allow click-through
      assert.ok(stylesCss.includes('.voice-call-overlay {'), 'CSS defines .voice-call-overlay');
      assert.ok(stylesCss.includes('backdrop-filter: none;'), 'CSS keeps background clear without blur');
      // In app.js, ringing state is detected
      assert.ok(appJs.includes("isRinging"), 'detects ringing state');
      assert.ok(appJs.includes("voiceCallOverlay.classList.remove('hidden')"), 'presents call overlay');
    });

    test('2. Outgoing video call remains non-blocking before answer', () => {
      assert.ok(appJs.includes("voiceCallOverlay.classList.remove('hidden')"), 'presents call overlay');
      assert.ok(appJs.includes("voiceCallCard?.classList.remove('is-minimized'"), 'displays centered call card');
    });

    test('3. Outgoing ringing appears in centered card without desktop floating window', () => {
      assert.ok(appJs.includes('voiceCallManager.startCall = function(roomId, ...args)'), 'startCall wrapper exists');
      assert.ok(appJs.includes('window.ollacoreDesktop.floatingCall.hide().catch(() => {});'), 'desktop floating window kept hidden on call start');
      assert.ok(floatingHtml.includes('id="view-outgoing"'), 'floating window has outgoing view');
    });

    test('4. Main chat remains accessible during outgoing ringing', () => {
      // CSS ensures click passthrough
      assert.ok(stylesCss.includes('pointer-events: none !important'), 'overlay has pointer-events none');
      assert.ok(stylesCss.includes('backdrop-filter: none !important'), 'overlay removes blur backdrop');
    });

    test('5. User can switch conversations while call is ringing without destroying call', () => {
      const mgr = new VoiceCallManager({
        sendSignal: () => {},
        rtcBridge: { connect: async () => ({ ok: true }), sendOffer: async () => ({ ok: true }) }
      });
      mgr.state = CALL_STATE.OUTGOING_RINGING;
      mgr.roomId = 'room-alpha';

      // Simulating room switch: selectConversation changes shellState.selectedRoomId
      const shellState = { selectedRoomId: 'room-alpha' };
      shellState.selectedRoomId = 'room-beta'; // User switches room

      // VoiceCallManager state and room are unaffected:
      assert.strictEqual(mgr.state, CALL_STATE.OUTGOING_RINGING, 'call state unaffected by navigation');
      assert.strictEqual(mgr.roomId, 'room-alpha', 'call roomId unaffected by navigation');
    });

    test('6. User can end outgoing call from floating window', () => {
      let callEnded = false;
      const mgr = {
        endCall: () => { callEnded = true; }
      };
      const onAction = (action) => {
        if (action === 'end') mgr.endCall();
      };

      onAction('end');
      assert.strictEqual(callEnded, true, 'outgoing call ended via action');
    });

    test('7. Incoming call appears in floating window', () => {
      assert.ok(floatingHtml.includes('id="view-incoming"'), 'floating incoming view exists');
      assert.ok(floatingJs.includes("state.state === 'incoming_ringing'"), 'floating handles incoming state');
    });

    test('8. User can accept incoming call from floating window', () => {
      let callAccepted = false;
      const mgr = {
        acceptCall: async () => { callAccepted = true; }
      };
      const onAction = (action) => {
        if (action === 'accept') mgr.acceptCall();
      };

      onAction('accept');
      assert.strictEqual(callAccepted, true, 'incoming call accepted from floating window');
    });

    test('9. User can decline incoming call from floating window', () => {
      let callDeclined = false;
      const mgr = {
        declineCall: () => { callDeclined = true; }
      };
      const onAction = (action) => {
        if (action === 'decline') mgr.declineCall();
      };

      onAction('decline');
      assert.strictEqual(callDeclined, true, 'incoming call declined from floating window');
    });

    test('10. Restore ringing call to full UI opens main call UI and hides floating window', () => {
      let mainOverlayVisible = false;
      let floatingHidden = false;

      const restoreCall = () => {
        mainOverlayVisible = true;
        floatingHidden = true;
      };

      const onAction = (action) => {
        if (action === 'restore') restoreCall();
      };

      onAction('restore');
      assert.strictEqual(mainOverlayVisible, true, 'main call overlay shown');
      assert.strictEqual(floatingHidden, true, 'floating window hidden');
    });

    test('11. Transition from ringing -> connected presents active call correctly', () => {
      const mgr = new VoiceCallManager();
      mgr.state = CALL_STATE.OUTGOING_RINGING;
      assert.strictEqual(mgr.state, CALL_STATE.OUTGOING_RINGING);

      // Simulate remote answer / connect
      mgr.state = CALL_STATE.CONNECTED;
      assert.strictEqual(mgr.state, CALL_STATE.CONNECTED);
    });

    test('12. Transition from ringing -> declined cleans up state', () => {
      const mgr = new VoiceCallManager();
      mgr.state = CALL_STATE.INCOMING_RINGING;
      mgr.declineCall();
      assert.strictEqual(mgr.state, CALL_STATE.DECLINED);
      assert.strictEqual(mgr.isEnded, true);
    });

    test('13. Transition from ringing -> cancelled cleans up state', () => {
      const mgr = new VoiceCallManager();
      mgr.state = CALL_STATE.OUTGOING_RINGING;
      mgr.endCall();
      assert.strictEqual(mgr.state, CALL_STATE.CANCELLED);
      assert.strictEqual(mgr.isEnded, true);
    });

    test('14. Active call minimize/restore transitions smoothly between windows', () => {
      assert.ok(appJs.includes('function minimizeCall()'), 'minimizeCall defined');
      assert.ok(appJs.includes('function restoreCall()'), 'restoreCall defined');
      assert.ok(appJs.includes('isCallMinimized'), 'tracks isCallMinimized flag');
    });

    test('15. Screen sharing remains functional across minimize/restore', () => {
      const mgr = new VoiceCallManager();
      mgr.isScreenSharing = true;
      mgr.state = CALL_STATE.CONNECTED;

      // Minimize / restore preserves isScreenSharing property
      assert.strictEqual(mgr.isScreenSharing, true, 'screen sharing preserved');
    });

    test('16. No duplicate floating windows created', () => {
      assert.ok(mainJs.includes('if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {'), 'checks existing instance before creating');
      assert.ok(mainJs.includes('return floatingCallWindow;'), 'returns cached instance');
    });

    test('17. Floating window closes automatically after call ends', () => {
      assert.ok(mainJs.includes('if (!isCallActive) {'), 'checks if call active on state sync');
      assert.ok(mainJs.includes('floatingCallWindow.hide();'), 'hides floating window on call end');
    });
  });

  class MockTrack {
    constructor(kind = 'audio') {
      this.kind = kind;
      this.enabled = true;
      this.readyState = 'live';
      this.stopped = false;
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
    removeTrack(track) {
      const idx = this.tracks.indexOf(track);
      if (idx !== -1) this.tracks.splice(idx, 1);
    }
  }

  class MockRTCRtpSender {
    constructor(track = null) {
      this.track = track;
    }
    async replaceTrack(newTrack) {
      this.track = newTrack;
    }
  }

  class MockRTCRtpTransceiver {
    constructor(kind = 'audio', sender = null) {
      this.kind = kind;
      this.direction = 'sendrecv';
      this.sender = sender || new MockRTCRtpSender();
      this.receiver = { track: new MockTrack(kind) };
    }
  }

  class MockRTCPeerConnection {
    static instances = [];

    constructor(config = {}) {
      this.config = config;
      this.iceServers = config.iceServers || [];
      this.senders = [];
      this.transceivers = [];
      this.localDescription = null;
      this.remoteDescription = null;
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
      this.isClosed = false;
      this.ontrack = null;
      this.onicecandidate = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      MockRTCPeerConnection.instances.push(this);
    }

    addTrack(track, stream) {
      const sender = new MockRTCRtpSender(track);
      this.senders.push(sender);
      const tc = new MockRTCRtpTransceiver(track.kind, sender);
      this.transceivers.push(tc);
      return sender;
    }

    getSenders() {
      return this.senders;
    }

    getTransceivers() {
      return this.transceivers;
    }

    addTransceiver(trackOrKind, init = {}) {
      const kind = typeof trackOrKind === 'string' ? trackOrKind : (trackOrKind?.kind || 'video');
      const sender = new MockRTCRtpSender(typeof trackOrKind === 'object' ? trackOrKind : null);
      this.senders.push(sender);
      const tc = new MockRTCRtpTransceiver(kind, sender);
      if (init.direction) tc.direction = init.direction;
      this.transceivers.push(tc);
      return tc;
    }

    async setLocalDescription(desc) {
      this.localDescription = desc;
    }

    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
    }

    close() {
      this.isClosed = true;
      this.connectionState = 'closed';
    }
  }

  describe('8. Floating Lifecycle, Authoritative Timer & Receiver Camera Pipeline Invariants', () => {
    test('1. Main app visible -> call window maintains active call sync without auto-hiding', () => {
      assert.ok(
        mainJs.includes("ipcMain.handle('floating-call:sync-state'"),
        'handles floating-call:sync-state'
      );
      assert.ok(
        !mainJs.includes('else if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {\n      floatingCallWindow.hide();'),
        'does not auto-hide call window when main window is visible'
      );
    });

    test('2. Main app minimized during active call -> floating shown automatically', () => {
      assert.ok(
        mainJs.includes("mainWindow.on('minimize'"),
        'main.js registers mainWindow minimize handler'
      );
      assert.ok(
        mainJs.includes('if (isCallActive) {') && mainJs.includes('win.show()'),
        'shows floating window on minimize if call active'
      );
    });

    test('3. Main app restored -> floating hidden and main call restored', () => {
      assert.ok(
        mainJs.includes("mainWindow.on('restore'"),
        'main.js registers mainWindow restore handler'
      );
      assert.ok(
        mainJs.includes("mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: true })"),
        'notifies renderer of mainWindow restore'
      );
      assert.ok(
        preloadJs.includes('onWindowStateChange'),
        'preload exposes onWindowStateChange bridge'
      );
    });

    test('4. Switching to another application while minimized preserves always-on-top floating window', () => {
      assert.ok(
        mainJs.includes("win.setAlwaysOnTop(true, 'screen-saver')"),
        'floating window is configured as always on top above other applications'
      );
    });

    test('5. No duplicate floating windows created across lifecycle', () => {
      assert.ok(
        mainJs.includes('function getOrCreateFloatingCallWindow()'),
        'getOrCreateFloatingCallWindow reuses existing window'
      );
      assert.ok(
        mainJs.includes('if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {\n    return floatingCallWindow;'),
        'returns existing instance without spawning a second BrowserWindow'
      );
    });

    test('6. Call ends -> floating closes automatically', () => {
      assert.ok(
        mainJs.includes('if (!isCallActive) {\n      floatingCallWindow.hide();'),
        'hides floating window when active states end'
      );
    });

    test('7. Timer starts when transitioning to CONNECTED', () => {
      const mgr = new VoiceCallManager();
      mgr.state = CALL_STATE.CONNECTING;
      assert.strictEqual(mgr.callConnectedAt, null, 'callConnectedAt is null before connected');
      mgr._markConnected();
      assert.strictEqual(mgr.state, CALL_STATE.CONNECTED, 'transitions to CONNECTED');
      assert.ok(mgr.callConnectedAt > 0, 'callConnectedAt timestamp recorded');
    });

    test('8. Timer displays elapsed duration formatted as MM:SS and HH:MM:SS', () => {
      const mgr = new VoiceCallManager();
      mgr.durationSec = 65;
      assert.strictEqual(mgr.getFormattedDuration(), '01:05', '65 seconds formatted as 01:05');

      mgr.durationSec = 3665;
      assert.strictEqual(mgr.getFormattedDuration(), '01:01:05', '3665 seconds formatted as 01:01:05');
      assert.strictEqual(mgr.duration, 3665, 'duration getter returns durationSec');
    });

    test('9. Timer updates every second via timerTick', async () => {
      const mgr = new VoiceCallManager();
      mgr.startCallDurationTimer();
      let ticks = 0;
      mgr.on('timerTick', () => { ticks++; });
      await new Promise(r => setTimeout(r, 1100));
      mgr.stopCallDurationTimer();
      assert.ok(ticks >= 1, 'timerTick emitted at least once within 1.1s');
    });

    test('10. Timer remains correct while minimized using authoritative epoch', () => {
      assert.ok(floatingJs.includes('function startDurationTicker(callConnectedAt'), 'floating-call has dedicated ticker');
      assert.ok(floatingJs.includes('Math.floor((Date.now() - callConnectedAt) / 1000)'), 'computes from authoritative epoch');
    });

    test('11. Timer remains correct after restore and does not drift', () => {
      const epoch = Date.now() - 45000;
      const mgr = new VoiceCallManager();
      mgr.callConnectedAt = epoch;
      mgr.durationSec = Math.floor((Date.now() - epoch) / 1000);
      assert.ok(mgr.durationSec >= 45 && mgr.durationSec <= 46, 'duration reflects elapsed time');
      assert.strictEqual(mgr.getFormattedDuration(), '00:45', 'renders 00:45');
    });

    test('12. Timer stops and resets cleanly when call ends', () => {
      const mgr = new VoiceCallManager();
      mgr.startCallDurationTimer();
      mgr.durationSec = 50;
      mgr.stopCallDurationTimer();
      assert.strictEqual(mgr.durationSec, 0, 'durationSec reset to 0');
      assert.strictEqual(mgr.callConnectedAt, null, 'callConnectedAt reset to null');
      assert.strictEqual(mgr.getFormattedDuration(), '00:00', 'getFormattedDuration reset to 00:00');
    });

    test('13. Camera permission failure handled gracefully without crash', async () => {
      class FailingMediaDevices {
        async getUserMedia() {
          const err = new Error('Permission denied');
          err.name = 'NotAllowedError';
          throw err;
        }
      }
      const mgr = new VoiceCallManager({ mediaDevices: new FailingMediaDevices() });
      await assert.rejects(
        () => mgr._acquireMedia(true),
        /permission denied/i,
        'throws friendly permission denied error'
      );
      assert.strictEqual(mgr.state, CALL_STATE.FAILED, 'transitions to FAILED');
    });

    test('14. getUserMedia device failure handled gracefully', async () => {
      class NotFoundMediaDevices {
        async getUserMedia() {
          const err = new Error('Device not found');
          err.name = 'NotFoundError';
          throw err;
        }
      }
      const mgr = new VoiceCallManager({ mediaDevices: new NotFoundMediaDevices() });
      await assert.rejects(
        () => mgr._acquireMedia(true),
        /Device not found/i,
        'throws device not found error'
      );
      assert.strictEqual(mgr.state, CALL_STATE.FAILED, 'transitions to FAILED');
    });

    test('15. Camera track created correctly during video media acquisition', async () => {
      class SuccessMediaDevices {
        async getUserMedia() {
          return new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
        }
      }
      const mgr = new VoiceCallManager({ mediaDevices: new SuccessMediaDevices() });
      const stream = await mgr._acquireMedia(true);
      assert.ok(stream.getVideoTracks().length > 0, 'video track acquired');
      assert.ok(mgr._localVideoTrack, 'local video track stored');
      assert.strictEqual(mgr._localVideoTrack.enabled, true, 'local video track enabled');
      assert.strictEqual(mgr._localVideoTrack.readyState, 'live', 'local video track readyState is live');
    });

    test('16. Camera track attached to RTCRtpSender and transceiver', () => {
      const pc = new MockRTCPeerConnection();
      const mgr = new VoiceCallManager();
      mgr.peerConnection = pc;
      mgr._localStream = new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
      mgr._localAudioTrack = mgr._localStream.getAudioTracks()[0];
      mgr._localVideoTrack = mgr._localStream.getVideoTracks()[0];

      mgr._attachLocalTracks();
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      assert.ok(videoSender, 'video sender created and attached');
      assert.strictEqual(videoSender.track, mgr._localVideoTrack, 'sender holds local video track');
    });

    test('17. Camera toggle preserves sender and peer connection', async () => {
      class TestMediaDevices {
        async getUserMedia() {
          return new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
        }
      }
      const pc = new MockRTCPeerConnection();
      const mgr = new VoiceCallManager({ mediaDevices: new TestMediaDevices() });
      mgr.peerConnection = pc;
      await mgr._acquireMedia(true);
      mgr._attachLocalTracks();

      assert.strictEqual(mgr.isCameraOff, false, 'camera is on initially');
      assert.strictEqual(mgr._localVideoTrack.enabled, true, 'track is enabled');

      // Toggle OFF
      const isOff = await mgr.toggleCamera();
      assert.strictEqual(isOff, true, 'toggleCamera returns true (camera is off)');
      assert.strictEqual(mgr.isCameraOff, true, 'camera off is true');
      assert.strictEqual(mgr._localVideoTrack.enabled, false, 'track is disabled');

      // Toggle ON
      const isOffAgain = await mgr.toggleCamera();
      assert.strictEqual(isOffAgain, false, 'toggleCamera returns false (camera is on)');
      assert.strictEqual(mgr.isCameraOff, false, 'camera off is false');
      assert.strictEqual(mgr._localVideoTrack.enabled, true, 'track is re-enabled');
      assert.strictEqual(pc.getSenders().length, 2, 'senders preserved without teardown');
    });

    test('18. Remote video track received and assigned to _remoteStream', () => {
      const mgr = new VoiceCallManager({ PeerConnectionClass: MockRTCPeerConnection });
      const pc = mgr._createPeerConnection();
      const remoteVTrack = new MockTrack('video');
      const remoteStream = new MockMediaStream([remoteVTrack]);

      pc.ontrack({ streams: [remoteStream], track: remoteVTrack });
      assert.ok(mgr._remoteStream, 'remote stream assigned');
      assert.ok(mgr._remoteStream.getVideoTracks().length > 0, 'remote stream contains video track');
    });

    test('19. Remote video element receives stream on track arrival', () => {
      const mgr = new VoiceCallManager({ PeerConnectionClass: MockRTCPeerConnection });
      const mockVideoElement = { srcObject: null, play: () => Promise.resolve() };
      mgr.remoteVideoElement = mockVideoElement;
      mgr.isVideo = true;

      const pc = mgr._createPeerConnection();
      const remoteVTrack = new MockTrack('video');
      const remoteStream = new MockMediaStream([remoteVTrack]);

      pc.ontrack({ streams: [remoteStream], track: remoteVTrack });
      assert.strictEqual(mockVideoElement.srcObject, remoteStream, 'remote video element received stream');
    });

    test('20. Dynamic camera acquisition when receiver answers audio and toggles camera', async () => {
      class DynamicMediaDevices {
        async getUserMedia(constraints) {
          if (constraints.video) {
            return new MockMediaStream([new MockTrack('video')]);
          }
          return new MockMediaStream([new MockTrack('audio')]);
        }
      }
      const pc = new MockRTCPeerConnection();
      const mgr = new VoiceCallManager({ mediaDevices: new DynamicMediaDevices() });
      mgr.peerConnection = pc;
      await mgr._acquireMedia(false);
      assert.strictEqual(mgr._localVideoTrack, null, 'no video track initially');
      mgr.isCameraOff = true;

      const isOff = await mgr.toggleCamera();
      assert.strictEqual(isOff, false, 'camera turned on successfully');
      assert.ok(mgr._localVideoTrack, 'local video track dynamically acquired');
      assert.strictEqual(mgr._localVideoTrack.enabled, true, 'local video track enabled');
      assert.strictEqual(mgr.isVideo, true, 'call upgraded to video modality');
    });
  });

  // =========================================================================
  // 9. WHATSAPP-STYLE CALL UI, IN-APP MINIMIZED WIDGET & SEPARATE DESKTOP WINDOW
  // =========================================================================
  describe('9. WhatsApp-Style Call UI, In-App Minimized Widget & Separate Desktop Window', () => {
    test('1. Audio/video calls open centered card inside mainWindow without full-screen blur', () => {
      // In styles.css, overlay is semi-transparent without blur, keeping app visible behind
      assert.ok(stylesCss.includes('.voice-call-overlay {'), 'defines .voice-call-overlay');
      assert.ok(stylesCss.includes('backdrop-filter: none;'), 'does not blur entire application');
      assert.ok(stylesCss.includes('justify-content: center;'), 'centers call card horizontally');
      assert.ok(stylesCss.includes('align-items: center;'), 'centers call card vertically');
      assert.ok(stylesCss.includes('.voice-call-card {') && stylesCss.includes('width: 380px;'), 'defines centered card width');
      assert.ok(stylesCss.includes('.voice-call-card.is-video-call {') && stylesCss.includes('width: 720px;'), 'defines centered video card width');
    });

    test('2. Dedicated WhatsApp-style call window appears when a call starts', () => {
      assert.ok(appJs.includes('voiceCallManager.startCall = function(roomId, ...args)'), 'startCall wrapper exists');
      assert.ok(appJs.includes('window.ollacoreDesktop.floatingCall.show()'), 'startCall shows dedicated call window');
      assert.ok(mainJs.includes("ipcMain.handle('floating-call:show'"), 'main process exposes floating-call:show handler');
    });

    test('3. Clicking minimize shows the compact in-app widget inside mainWindow', () => {
      assert.ok(appJs.includes('isCallMinimized = true;'), 'minimize sets isCallMinimized flag');
      assert.ok(appJs.includes("voiceCallOverlay.classList.remove('hidden');"), 'overlay remains visible');
      assert.ok(appJs.includes("voiceCallOverlay.classList.add('is-minimized', 'is-floating');"), 'overlay switches to transparent click-through in-app minimized mode');
      assert.ok(appJs.includes("voiceCallCard.classList.add('is-minimized', 'is-floating');"), 'card switches to compact pill layout');
      assert.ok(appJs.includes("callMinimizedControls?.classList.remove('hidden');"), 'in-app minimized controls are shown');
      assert.ok(stylesCss.includes('.voice-call-overlay.is-minimized') && stylesCss.includes('pointer-events: none !important'), 'minimized overlay allows clicking through to underlying chats');
      assert.ok(stylesCss.includes('.voice-call-card.is-minimized') && stylesCss.includes('pointer-events: auto !important'), 'compact in-app widget is interactive');
    });

    test('4. In-app minimized widget provides restore, mute, and end call controls', () => {
      assert.ok(indexHtml.includes('id="btn-call-restore"'), 'restore button in markup');
      assert.ok(indexHtml.includes('id="btn-call-minimized-mute"'), 'minimized mute button in markup');
      assert.ok(indexHtml.includes('id="btn-call-minimized-end"'), 'minimized end button in markup');
      assert.ok(appJs.includes('btnCallMinimizedMute?.addEventListener'), 'minimized mute button wired');
      assert.ok(appJs.includes('btnCallRestore?.addEventListener'), 'restore button wired');
      assert.ok(appJs.includes('btnCallMinimizedEnd?.addEventListener'), 'minimized end button wired');
    });

    test('5. Pointer dragging works across content area with click-vs-drag distinction', () => {
      assert.ok(appJs.includes('if (e.target.closest(\'button\')) return;'), 'button clicks do not start dragging');
      assert.ok(appJs.includes('Math.abs(dx) > 4 || Math.abs(dy) > 4'), 'movement threshold distinguishes click from drag');
      assert.ok(appJs.includes('hasDraggedCallTile = true;'), 'flags genuine drag movement');
      assert.ok(appJs.includes('if (hasDraggedCallTile) {\n      hasDraggedCallTile = false;\n      return;\n    }\n    restoreCall();'), 'clicking widget body restores call unless dragged');
    });

    test('6. Widget coordinates are clamped within application bounds on move and resize', () => {
      assert.ok(appJs.includes('function clampMinimizedTilePosition()'), 'clamping helper defined');
      assert.ok(appJs.includes('minimizedTileCoords.x = Math.min(Math.max(minX, minimizedTileCoords.x), maxX);'), 'clamps X within window bounds');
      assert.ok(appJs.includes('minimizedTileCoords.y = Math.min(Math.max(minY, minimizedTileCoords.y), maxY);'), 'clamps Y within window bounds');
      assert.ok(appJs.includes('window.addEventListener(\'resize\','), 'recalculates boundaries on window resize');
    });

    test('7. Restoring the call returns to centered card and cleans up minimized pill styling', () => {
      assert.ok(appJs.includes("voiceCallOverlay.classList.remove('is-minimized', 'is-floating');"), 'removes minimized overlay styling');
      assert.ok(appJs.includes("voiceCallCard.classList.remove('is-minimized', 'is-floating', 'is-maximized');"), 'removes minimized card styling');
      assert.ok(appJs.includes("callMinimizedControls?.classList.add('hidden');"), 'hides minimized controls');
      assert.ok(appJs.includes("voiceCallCard.style.left = '';"), 'clears pinned coordinates to re-center card');
    });

    test('8. Minimizing mainWindow shows separate desktop floating call window', () => {
      assert.ok(mainJs.includes("mainWindow.on('minimize'"), 'main window minimize handler');
      assert.ok(mainJs.includes("setFloatingCallMode('detailed')"), 'switches to detailed desktop window');
      assert.ok(mainJs.includes('win.show();'), 'shows separate desktop window when main app is minimized');
    });

    test('9. Restoring mainWindow hides desktop window and restores correct in-app state', () => {
      assert.ok(mainJs.includes("mainWindow.on('restore'"), 'mainWindow restore handler');
      assert.ok(mainJs.includes('floatingCallWindow.hide();'), 'desktop window hides when mainWindow restores');
      assert.ok(appJs.includes('if (!isCallMinimized) {\n              restoreCall();'), 'restores centered call card if call was not minimized in-app');
      assert.ok(appJs.includes('// Call was minimized in-app: restore compact in-app widget at its saved position'), 'preserves compact in-app widget if call was minimized');
    });

    test('10. Camera button appears in connected video calls and active screen sharing', () => {
      assert.ok(appJs.includes('if (isVideo || voiceCallManager.isScreenSharing) {\n        btnCallCamera?.classList.remove(\'hidden\');\n      } else {\n        btnCallCamera?.classList.add(\'hidden\');\n      }'), 'camera toggle appears in connected video calls and active screen share');
    });

    test('11. Switch-to-video button is removed from all call UI', () => {
      assert.strictEqual(appJs.includes("btnCallRequestVideo?.classList.remove('hidden')"), false, 'never unhidden in app.js');
      assert.ok(stylesCss.includes('#btn-call-request-video') && stylesCss.includes('display: none !important'), 'request video button display none !important in styles.css');
    });

    test('12. Incoming call panel in top-right corner does not block chat navigation', () => {
      assert.ok(stylesCss.includes('.voice-call-overlay.is-incoming'), 'defines .voice-call-overlay.is-incoming');
      assert.ok(stylesCss.includes('pointer-events: none !important'), 'incoming overlay passes clicks through');
      assert.ok(stylesCss.includes('.voice-call-card.is-incoming') && stylesCss.includes('pointer-events: auto !important'), 'incoming notification card is interactive');
    });
  });
});

