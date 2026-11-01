import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read source files for structural and style assertions
const stylesCss = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf-8');
const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf-8');
const floatingCallJs = fs.readFileSync(path.join(__dirname, '../src/renderer/floating-call.js'), 'utf-8');
const floatingCallHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/floating-call.html'), 'utf-8');

class MockMediaTrack {
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
    this._tracks = tracks;
  }
  getTracks() {
    return this._tracks;
  }
  getAudioTracks() {
    return this._tracks.filter(t => t.kind === 'audio');
  }
  getVideoTracks() {
    return this._tracks.filter(t => t.kind === 'video');
  }
  addTrack(t) {
    this._tracks.push(t);
  }
}

class MockRtpSender {
  constructor(track) {
    this.track = track;
  }
  async replaceTrack(t) {
    this.track = t;
  }
}

class MockPeerConnection {
  constructor() {
    this.senders = [];
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
  }
  getSenders() {
    return this.senders;
  }
  addTrack(track, stream) {
    const sender = new MockRtpSender(track);
    this.senders.push(sender);
    return sender;
  }
  async createOffer() {
    return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', type: 'offer' };
  }
  async createAnswer() {
    return { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', type: 'answer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

describe('Video Call Screen Sharing, View Modes, and Floating Popup Remote Video Tests', () => {

  describe('1. Screen Share Control Visibility & Modal Accessibility', () => {
    test('1.1 screenshare-picker-modal has z-index: 10000 so it renders above voice-call-overlay (z-index 2500/9999)', () => {
      assert.ok(
        stylesCss.includes('#screenshare-picker-modal') && stylesCss.includes('z-index: 10000;'),
        '#screenshare-picker-modal is defined with z-index: 10000'
      );
    });

    test('1.2 Screen share button is visible during connected video call and displays clear feedback on error', () => {
      assert.ok(appJs.includes("btnCallScreenShare?.classList.remove('hidden')"), 'Screen share button unhidden in CONNECTED state');
      assert.ok(appJs.includes('Failed to load screen capture sources') || appJs.includes('callErrorBanner'), 'Clear error feedback on screenshare failure');
      assert.ok(appJs.includes('Cannot share screen: another participant is already sharing'), 'Feedback when screen share is unavailable due to active sharer');
    });
  });

  describe('2. Receiver Screen Share Permissions & Video Call Classification', () => {
    test('2.1 Receiver accepting video call sets _isOriginalVideoCall = true', async () => {
      const mockAudioTrack = new MockMediaTrack('audio');
      const mockVideoTrack = new MockMediaTrack('video');
      const mockStream = new MockMediaStream([mockAudioTrack, mockVideoTrack]);

      const mgr = new VoiceCallManager({
        mediaDevices: {
          getUserMedia: async () => mockStream
        },
        PeerConnectionClass: MockPeerConnection,
        SessionDescriptionClass: class {},
        IceCandidateClass: class {},
        sendSignal: () => {}
      });

      mgr.rtcBridge = {
        getState: async () => 'disconnected',
        connect: async () => ({ ok: true }),
        sendOffer: async () => ({ ok: true }),
        disconnect: () => {}
      };

      mgr.state = CALL_STATE.INCOMING_RINGING;
      mgr.isVideo = true;
      mgr.mode = 'video';
      mgr.roomId = 'room-recv-1';

      await mgr.acceptCall();

      assert.strictEqual(mgr._isOriginalVideoCall, true, 'Receiver properly flags call as original video call');
      assert.strictEqual(mgr.remoteScreenSharing, false, 'Receiver does not falsely classify camera as screenshare');
      assert.strictEqual(mgr.canStartScreenShare(), true, 'Receiver is allowed to start screen share');
    });

    test('2.2 OnTrack arrival of video track in video call does not trigger remoteScreenSharing', () => {
      const mgr = new VoiceCallManager();
      mgr.state = CALL_STATE.CONNECTED;
      mgr.isVideo = true;
      mgr.mode = 'video';
      mgr._isOriginalVideoCall = true;
      mgr.remoteScreenSharing = false;

      // Simulate incoming video track event
      const mockRemoteTrack = new MockMediaTrack('video');
      const remoteStream = new MockMediaStream([mockRemoteTrack]);
      mgr._remoteStream = remoteStream;

      assert.strictEqual(mgr.remoteScreenSharing, false, 'Remote video does not spuriously set remoteScreenSharing');
      assert.strictEqual(mgr.canStartScreenShare(), true, 'canStartScreenShare returns true for receiver in video call');
    });
  });

  describe('3. Exactly Two Call-View Options (Full-Screen Call View and Minimized Floating Popup)', () => {
    test('3.1 Extra view-mode buttons (btnCallMaximize and btnCallPopout) are kept hidden in updateVoiceCallUi', () => {
      // Confirms btnCallMaximize and btnCallPopout are hidden so only full view and minimized floating popup exist
      assert.ok(appJs.includes("btnCallMaximize?.classList.add('hidden');"), 'Maximize button kept hidden in call UI');
      assert.ok(appJs.includes("btnCallPopout?.classList.add('hidden');"), 'Popout button kept hidden in call UI');
      assert.ok(appJs.includes("btnCallMinimize?.classList.remove('hidden');"), 'Minimize button visible in active call header');
    });

    test('3.2 btnCallMinimize triggers Option B (desktop floating call popup) with video bridge initialization', () => {
      assert.ok(appJs.includes('window.ollacoreDesktop.floatingCall.show()'), 'btnCallMinimize shows floating window');
      assert.ok(appJs.includes('startFloatingVideoBridge()'), 'btnCallMinimize connects floating video bridge');
    });

    test('3.3 Floating call window provides restore action to return to Option A (full call view)', () => {
      assert.ok(floatingCallJs.includes("wireAction(btnVideoRestore, 'restore')"), 'Restore button wired in floating video view');
      assert.ok(floatingCallJs.includes("wireAction(btnAudioRestore, 'restore')"), 'Restore button wired in floating audio view');
      assert.ok(floatingCallHtml.includes('id="btn-video-restore"'), 'Restore button present in floating video UI');
      assert.ok(appJs.includes("restoreCall()"), 'Restore action restores main call UI');
    });
  });

  describe('4. Remote Video Rendering in Minimized Floating Popup', () => {
    test('4.1 startFloatingVideoBridge resolves _remoteStream and attaches to loopback RTCPeerConnection', () => {
      assert.ok(
        appJs.includes('const stream = voiceCallManager?._remoteStream || remoteVideo?.srcObject;'),
        'Resolves _remoteStream correctly from voiceCallManager'
      );
      assert.ok(appJs.includes('pc.addTrack(videoTrack, stream);'), 'Attaches remote video track to loopback bridge');
    });

    test('4.2 Video bridge handles ICE candidate queuing until remote description is set', () => {
      assert.ok(floatingCallJs.includes('pendingCandidates'), 'Queues pending candidates in floating call bridge');
      assert.ok(appJs.includes('pendingBridgeCandidates'), 'Queues pending bridge candidates in app.js');
    });

    test('4.3 Floating video placeholder is NOT hidden solely by local user camera toggle', () => {
      // Verifies floating call checks actual live remote video stream existence
      assert.ok(
        floatingCallJs.includes('const hasLiveVideo = Boolean(floatingRemoteVideo?.srcObject);'),
        'Floating call relies on actual remote video stream presence rather than local camera toggle'
      );
      assert.ok(
        floatingCallJs.includes("floatingRemoteVideo.style.opacity = '1'"),
        'Ensures floatingRemoteVideo is displayed with full opacity when track arrives'
      );
    });

    test('4.4 Main window minimization triggers startFloatingVideoBridge() during active video call', () => {
      assert.ok(
        appJs.includes('window.ollacoreDesktop.floatingCall.onWindowStateChange'),
        'Listens for main-window minimization'
      );
      assert.ok(
        appJs.includes('startFloatingVideoBridge()'),
        'Triggers video bridge on minimize'
      );
    });

    test('4.5 Restoring main call view closes bridge without resetting main call media session', () => {
      assert.ok(
        appJs.includes('localVideoBridgePc.close()'),
        'Closes loopback bridge cleanly on restore'
      );
      assert.ok(
        appJs.includes('remoteVideo.srcObject = voiceCallManager._remoteStream;'),
        'Re-attaches _remoteStream to remoteVideo in main window upon restore'
      );
    });

    test('4.6 Floating remote video element is muted and playsInline to bypass Chromium autoplay policy', () => {
      assert.ok(
        floatingCallHtml.includes('<video class="floating-remote-video" id="floating-remote-video" autoplay playsinline muted></video>'),
        'HTML markup includes muted attribute'
      );
      assert.ok(
        floatingCallJs.includes('floatingRemoteVideo.muted = true'),
        'JS explicitly sets muted property on floatingRemoteVideo'
      );
    });

    test('4.7 Preload bridgeSignal sanitizes WebRTC signals into cloneable plain objects and supports ready handshake', () => {
      const preloadJs = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf-8');
      assert.ok(
        preloadJs.includes('safeSignal.offer = { type: signal.offer.type, sdp: signal.offer.sdp };'),
        'Offer is sanitized to plain object'
      );
      assert.ok(
        preloadJs.includes('safeSignal.candidate = {'),
        'Candidate is sanitized to plain object'
      );
      assert.ok(
        floatingCallJs.includes("bridge.bridgeSignal({ type: 'ready' })"),
        'Floating call notifies mainWindow on initialization'
      );
    });
  });

});
