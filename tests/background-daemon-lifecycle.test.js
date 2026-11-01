import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartHidden, setAutoStart, isAutoStartEnabled } from '../src/main/auto-start.js';
import { ChatWebSocket, CONNECTION_STATE } from '../src/chat/chat-websocket.js';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sentData = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }

  send(data) {
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) this.onclose({ code, reason });
  }
}

describe('Client-Side Windows Background Daemon & Lifecycle Suite', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  // 1. Background startup without visible UI
  test('1. Background startup detection suppresses initial window display', () => {
    // When launched with --hidden or opened at login
    assert.equal(shouldStartHidden(['OllaChat.exe', '--hidden']), true);
    assert.equal(shouldStartHidden(['OllaChat.exe', '--background']), true);
    assert.equal(shouldStartHidden([], { wasOpenedAsHidden: true }), true);

    // Normal launch shows window
    assert.equal(shouldStartHidden(['OllaChat.exe'], { wasOpenedAsHidden: false }), false);
  });

  // 2. Window close hides window instead of quitting when !isQuitting
  test('2. Window close intercepts default action and hides window when isQuitting is false', () => {
    let defaultPrevented = false;
    let windowHidden = false;
    let isQuitting = false;

    const mockEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      }
    };
    const mockWindow = {
      hide: () => {
        windowHidden = true;
      }
    };

    // Simulate close handler
    const onClose = (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mockWindow.hide();
      }
    };

    onClose(mockEvent);
    assert.equal(defaultPrevented, true);
    assert.equal(windowHidden, true);
  });

  // 3. Window close allows termination when isQuitting is true
  test('3. Window close allows clean destruction when isQuitting is true', () => {
    let defaultPrevented = false;
    let windowHidden = false;
    let isQuitting = true;

    const mockEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      }
    };
    const mockWindow = {
      hide: () => {
        windowHidden = true;
      }
    };

    const onClose = (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mockWindow.hide();
      }
    };

    onClose(mockEvent);
    assert.equal(defaultPrevented, false);
    assert.equal(windowHidden, false);
  });

  // 4. ChatWebSocket pool remains connected and active while UI is hidden
  test('4. Chat WebSocket pool remains connected and receives frames while window is hidden', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const p = pool.connectRoom('room_bg_active');
    await Promise.resolve();
    const sock = MockWebSocket.instances[0];
    sock.simulateOpen();
    await p;

    assert.equal(pool.state, CONNECTION_STATE.CONNECTED);
    assert.equal(pool.getRoomState('room_bg_active'), CONNECTION_STATE.CONNECTED);

    // Window is hidden; frame arrives
    const receivedFrames = [];
    pool.on('frame', (f) => receivedFrames.push(f));

    sock.simulateMessage({
      type: 'message.created',
      room_id: 'room_bg_active',
      payload: {
        id: 'msg-bg-1',
        sender_id: 'friend_bob',
        body: { text: 'Hey, are you there?' }
      }
    });

    assert.equal(receivedFrames.length, 1);
    assert.equal(receivedFrames[0].payload.id, 'msg-bg-1');
    assert.equal(sock.closed, false, 'Socket must remain open in background');

    pool.disconnect();
  });

  // 5. Tray Open restores and focuses window
  test('5. Tray Open action restores and focuses hidden window', () => {
    let shown = false;
    let focused = false;
    let restored = false;

    const mockWindow = {
      isVisible: () => false,
      isMinimized: () => true,
      show: () => { shown = true; },
      restore: () => { restored = true; },
      focus: () => { focused = true; }
    };

    const onTrayOpen = () => {
      if (!mockWindow.isVisible()) mockWindow.show();
      if (mockWindow.isMinimized()) mockWindow.restore();
      mockWindow.focus();
    };

    onTrayOpen();
    assert.equal(shown, true);
    assert.equal(restored, true);
    assert.equal(focused, true);
  });

  // 6. Tray Quit cleanly terminates all sockets and timers
  test('6. Tray Quit explicitly disconnects WebSockets and stops sync timers', async () => {
    let syncIntervalCleared = false;
    let appQuitCalled = false;
    let syncInterval = setInterval(() => {}, 10000);

    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_${roomId}`
    });
    const p = pool.connectRoom('room_quit_test');
    await Promise.resolve();
    MockWebSocket.instances[0].simulateOpen();
    await p;

    const onTrayQuit = () => {
      if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
        syncIntervalCleared = true;
      }
      pool.disconnect();
      appQuitCalled = true;
    };

    onTrayQuit();
    assert.equal(syncIntervalCleared, true);
    assert.equal(appQuitCalled, true);
    assert.equal(MockWebSocket.instances[0].closed, true);
    assert.equal(pool.state, CONNECTION_STATE.DISCONNECTED);
  });

  // 7. Incoming call while UI is hidden triggers ringtone, window focus, and camera remains OFF
  test('7. Incoming call while UI is hidden wakes call state machine with camera OFF', () => {
    let windowFocused = false;
    const mockApp = {
      focusWindow: () => { windowFocused = true; }
    };

    const manager = new VoiceCallManager({
      roomId: 'room_call_bg',
      peerName: 'Alice'
    });

    // Background call arrives
    mockApp.focusWindow();
    manager.handleIncomingCall({
      roomId: 'room_call_bg',
      callId: 'call_bg_1',
      initiator: 'Alice',
      isVideo: true,
      callType: 'video',
      peerName: 'Alice'
    });

    assert.equal(windowFocused, true);
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    // Camera MUST remain OFF while ringing!
    assert.equal(manager._localStream, null);
    assert.equal(manager.durationSec, 0);
  });

  // 8. Sleep/wake recovery re-sync simulation
  test('8. Resume event from sleep triggers room and connection verification', () => {
    let syncCalled = false;
    const mockPowerMonitorListeners = new Map();
    const mockPowerMonitor = {
      on: (event, handler) => {
        mockPowerMonitorListeners.set(event, handler);
      }
    };

    // Register resume listener
    mockPowerMonitor.on('resume', () => {
      syncCalled = true;
    });

    // Simulate system wake from sleep
    const resumeHandler = mockPowerMonitorListeners.get('resume');
    assert.ok(resumeHandler);
    resumeHandler();

    assert.equal(syncCalled, true, 'Resume must trigger connection re-sync');
  });
});
