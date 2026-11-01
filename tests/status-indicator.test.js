import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocket, CONNECTION_STATE } from '../src/chat/chat-websocket.js';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';

describe('Status Indicator Lifecycle & Room-Scoped State Tests', () => {

  /**
   * Helper that simulates the renderer status indicator lifecycle logic in app.js.
   */
  function createIndicatorController(shellState = new ChatShellState()) {
    let wsIndicatorClass = 'ws-status-pill state-disconnected';
    let wsStatusLabelText = 'Disconnected';
    let wsIndicatorTitle = 'Gateway status: disconnected';

    function updateWsIndicator(state, details = null, roomId = null) {
      if (roomId && shellState.selectedRoomId && roomId !== shellState.selectedRoomId) {
        return; // Stale event from another room ignored
      }
      if (!shellState.selectedRoomId) {
        state = 'disconnected';
        details = null;
      }

      shellState.setWsState(state, details);
      const normalized = shellState.wsState;
      wsIndicatorClass = `ws-status-pill state-${normalized}`;

      const labels = {
        connected: 'Connected',
        connecting: 'Connecting...',
        reconnecting: 'Reconnecting...',
        disconnected: 'Disconnected',
        error: 'Connection Error'
      };

      wsStatusLabelText = labels[normalized] || normalized;
      wsIndicatorTitle = details?.message
        ? `Gateway: ${normalized} (${details.message})`
        : `Gateway status: ${normalized}`;
    }

    return {
      shellState,
      updateWsIndicator,
      getLabel: () => wsStatusLabelText,
      getClass: () => wsIndicatorClass,
      getTitle: () => wsIndicatorTitle
    };
  }

  test('A. Initial authenticated screen does not show Connection Error', () => {
    const ctrl = createIndicatorController();
    assert.equal(ctrl.shellState.selectedRoomId, null);

    // Startup with no room selected
    ctrl.updateWsIndicator('disconnected');
    assert.equal(ctrl.getLabel(), 'Disconnected');
    assert.notEqual(ctrl.getLabel(), 'Connection Error');

    // Even if an unexpected error event arrives while no room is selected, indicator remains disconnected
    ctrl.updateWsIndicator('error', { message: 'Some startup glitch' });
    assert.equal(ctrl.getLabel(), 'Disconnected');
    assert.notEqual(ctrl.getLabel(), 'Connection Error');
  });

  test('B. Selecting Room A transitions connecting -> connected', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';

    // User selects Room A
    ctrl.shellState.selectConversation(roomA);
    ctrl.updateWsIndicator('connecting', null, roomA);
    assert.equal(ctrl.getLabel(), 'Connecting...');
    assert.equal(ctrl.getClass(), 'ws-status-pill state-connecting');

    // Room A finishes connecting
    ctrl.updateWsIndicator('connected', null, roomA);
    assert.equal(ctrl.getLabel(), 'Connected');
    assert.equal(ctrl.getClass(), 'ws-status-pill state-connected');
  });

  test('C. Connected Room A displays "Connected"', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';

    ctrl.shellState.selectConversation(roomA);
    ctrl.updateWsIndicator('connected', null, roomA);

    assert.equal(ctrl.getLabel(), 'Connected');
    assert.equal(ctrl.getClass(), 'ws-status-pill state-connected');
  });

  test('D. Switching Room A -> Room B: Room A state cannot overwrite Room B state', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';
    const roomB = 'room_B';

    // Connect Room A
    ctrl.shellState.selectConversation(roomA);
    ctrl.updateWsIndicator('connected', null, roomA);
    assert.equal(ctrl.getLabel(), 'Connected');

    // Switch to Room B
    ctrl.shellState.selectConversation(roomB);
    ctrl.updateWsIndicator('connecting', null, roomB);
    assert.equal(ctrl.getLabel(), 'Connecting...');

    // Late event from Room A arrives
    ctrl.updateWsIndicator('disconnected', null, roomA);
    // Should still be Room B's state ('connecting')
    assert.equal(ctrl.getLabel(), 'Connecting...');

    // Room B connects
    ctrl.updateWsIndicator('connected', null, roomB);
    assert.equal(ctrl.getLabel(), 'Connected');
  });

  test('E. A stale error event from Room A cannot change Room B indicator to "Connection Error"', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';
    const roomB = 'room_B';

    // User was on Room A, now switches to Room B
    ctrl.shellState.selectConversation(roomB);
    ctrl.updateWsIndicator('connected', null, roomB);
    assert.equal(ctrl.getLabel(), 'Connected');

    // Asynchronous error from Room A's socket closure arrives
    ctrl.updateWsIndicator('error', { message: 'Old socket closed abnormally' }, roomA);

    // Indicator must NOT be overwritten by Room A error
    assert.equal(ctrl.getLabel(), 'Connected');
    assert.notEqual(ctrl.getLabel(), 'Connection Error');
  });

  test('F. Successful connection always changes the indicator to "Connected"', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';

    ctrl.shellState.selectConversation(roomA);
    // Prior state was reconnecting or error
    ctrl.updateWsIndicator('reconnecting', { attempt: 1 }, roomA);
    assert.equal(ctrl.getLabel(), 'Reconnecting...');

    // Reconnection succeeds
    ctrl.updateWsIndicator('connected', null, roomA);
    assert.equal(ctrl.getLabel(), 'Connected');
    assert.equal(ctrl.getClass(), 'ws-status-pill state-connected');
  });

  test('G. Disconnecting the active room changes the indicator to "Disconnected"', () => {
    const ctrl = createIndicatorController();
    const roomA = 'room_A';

    ctrl.shellState.selectConversation(roomA);
    ctrl.updateWsIndicator('connected', null, roomA);
    assert.equal(ctrl.getLabel(), 'Connected');

    // Deselect room / close
    ctrl.shellState.selectConversation(null);
    ctrl.updateWsIndicator('disconnected');
    assert.equal(ctrl.getLabel(), 'Disconnected');
    assert.equal(ctrl.getClass(), 'ws-status-pill state-disconnected');
  });

  test('H. Only the active WebSocket instance may update the indicator (ChatWebSocket emits roomId)', async () => {
    class MockSocket {
      static instances = [];
      constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        MockSocket.instances.push(this);
      }
      simulateOpen() {
        if (this.onopen) this.onopen();
      }
      close() {
        if (this.onclose) this.onclose({ code: 1000, reason: 'Closed' });
      }
    }

    const ws = new ChatWebSocket({
      WebSocketClass: MockSocket
    });

    const stateChanges = [];
    ws.on('stateChange', (data) => {
      stateChanges.push(data);
    });

    await ws.connect({ roomId: 'room_1', token: 'rt_token_1' });
    assert.equal(stateChanges[stateChanges.length - 1].state, CONNECTION_STATE.CONNECTING);
    assert.equal(stateChanges[stateChanges.length - 1].roomId, 'room_1');

    // Simulate socket open for room_1
    MockSocket.instances[0].simulateOpen();
    assert.equal(stateChanges[stateChanges.length - 1].state, CONNECTION_STATE.CONNECTED);
    assert.equal(stateChanges[stateChanges.length - 1].roomId, 'room_1');

    // Switch to room_2
    await ws.connect({ roomId: 'room_2', token: 'rt_token_2' });
    assert.equal(stateChanges[stateChanges.length - 1].roomId, 'room_2');

    // Simulate socket open for room_2
    MockSocket.instances[1].simulateOpen();
    assert.equal(stateChanges[stateChanges.length - 1].state, CONNECTION_STATE.CONNECTED);
    assert.equal(stateChanges[stateChanges.length - 1].roomId, 'room_2');

    ws.disconnect();
    assert.equal(stateChanges[stateChanges.length - 1].state, CONNECTION_STATE.DISCONNECTED);
  });
});
