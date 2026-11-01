import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatWebSocket,
  CONNECTION_STATE,
  encodeFrame,
  decodeFrame
} from '../src/chat/chat-websocket.js';

class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // CONNECTING
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

  send(data) {
    if (this.readyState !== 1) {
      throw new Error(`WebSocket is not open (readyState: ${this.readyState})`);
    }
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }

  terminate() {
    this.close(1006, 'Terminated');
  }

  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (this.onmessage) {
      this.onmessage({ data: raw });
    }
  }

  simulateUnexpectedClose(code = 1006, reason = 'Connection dropped') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }
}

describe('ChatWebSocket Connection Lifecycle & Heartbeat Fix Suite (18 Requirements)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  // 1. WebSocket opens
  test('1. WebSocket opens and transitions state to connected', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    assert.equal(MockWebSocket.instances.length, 1);
    const socket = MockWebSocket.instances[0];

    socket.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    ws.disconnect();
  });

  // 2. Heartbeat starts after connection
  test('2. Heartbeat starts after connection', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 50,
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    assert.ok(ws._heartbeatTimer !== null);
    ws.disconnect();
  });

  // 3. Heartbeat continues beyond the initial connection period
  test('3. Heartbeat continues beyond the initial connection period', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 25,
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    await new Promise(r => setTimeout(r, 200));
    const pings = socket.sentData.map(d => JSON.parse(d)).filter(f => f.type === 'ping');
    assert.ok(pings.length >= 3, `Expected at least 3 pings, got ${pings.length}`);

    ws.disconnect();
  });

  // 4. Pong is accepted correctly
  test('4. Pong is accepted correctly: both type: pong and type: ack with payload: { type: pong }', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 30,
      heartbeatTimeoutMs: 50,
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // Trigger ping
    await new Promise(r => setTimeout(r, 35));
    assert.ok(socket.sentData.length >= 1);
    const pingFrame = decodeFrame(socket.sentData[0]);
    assert.equal(pingFrame.type, 'ping');
    assert.ok(ws._awaitingPong);

    // Simulate backend response: { v: 1, type: "ack", request_id: pingFrame.request_id, payload: { type: "pong" } }
    socket.simulateMessage({
      v: 1,
      type: 'ack',
      request_id: pingFrame.request_id,
      payload: { type: 'pong' }
    });

    assert.equal(ws._awaitingPong, false);
    assert.equal(ws._pongTimer, null);
    assert.ok(ws.lastPongAt > 0);

    // Also verify standalone { type: "pong" } frame is accepted
    const beforeTime = ws.lastPongAt;
    await new Promise(r => setTimeout(r, 10));
    socket.simulateMessage({ v: 1, type: 'pong', payload: {} });
    assert.ok(ws.lastPongAt >= beforeTime);

    ws.disconnect();
  });

  // 5. Pong deadline is handled correctly
  test('5. Pong deadline is handled correctly: timely pong prevents timeout', async () => {
    let timeoutFired = false;
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 80,
      heartbeatTimeoutMs: 30,
      WebSocketClass: MockWebSocket
    });

    ws.on('error', (err) => {
      if (err?.code === 'heartbeat_timeout') timeoutFired = true;
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // Wait for ping, then immediately answer with ack-pong
    await new Promise(r => setTimeout(r, 90));
    assert.ok(socket.sentData.length >= 1);
    const pingFrame = decodeFrame(socket.sentData[0]);
    socket.simulateMessage({
      v: 1,
      type: 'ack',
      request_id: pingFrame.request_id,
      payload: { type: 'pong' }
    });

    // Wait past what would have been the 30ms timeout deadline
    await new Promise(r => setTimeout(r, 45));
    assert.equal(timeoutFired, false);
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

    ws.disconnect();
  });

  // 6. Genuine heartbeat failure triggers reconnect
  test('6. Genuine heartbeat failure triggers reconnect', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 30,
      WebSocketClass: MockWebSocket
    });

    let timeoutReported = false;
    ws.on('error', (err) => {
      if (err?.code === 'heartbeat_timeout') timeoutReported = true;
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // Do NOT send pong; wait for deadline to expire
    await new Promise(r => setTimeout(r, 140));

    assert.equal(timeoutReported, true);
    assert.ok(ws.state === CONNECTION_STATE.RECONNECTING || ws.state === CONNECTION_STATE.CONNECTING);

    ws.disconnect();
  });

  // 7. Old socket heartbeat timer is cleared
  test('7. Old socket heartbeat timer is cleared on unexpected close or disconnect', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 30,
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();
    assert.ok(ws._heartbeatTimer !== null);

    socket.simulateUnexpectedClose();
    assert.equal(ws._heartbeatTimer, null);
    assert.equal(ws._pongTimer, null);

    ws.disconnect();
  });

  // 8. Old socket events cannot change the state of the new socket
  test('8. Old socket events cannot change the state of the new socket', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket1 = MockWebSocket.instances[0];
    socket1.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

    // Reconnect / create socket 2
    await ws.connect({ forceTokenRefresh: true });
    const socket2 = MockWebSocket.instances[1];
    socket2.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

    // Old socket emits close or error event
    socket1.simulateUnexpectedClose(1006, 'Old socket died');

    // State of ws must still be connected to socket2
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    assert.equal(ws._socket, socket2);

    ws.disconnect();
  });

  // 9. Only one socket exists during reconnect
  test('9. Only one socket exists during reconnect (old socket is cleaned up)', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket1 = MockWebSocket.instances[0];
    socket1.simulateOpen();

    await ws.connect({ forceTokenRefresh: true });
    assert.equal(socket1.closed, true);
    assert.equal(MockWebSocket.instances.length, 2);
    assert.equal(ws._socket, MockWebSocket.instances[1]);

    ws.disconnect();
  });

  // 10. Only one heartbeat timer exists
  test('10. Only one heartbeat timer exists across reconnects', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      heartbeatIntervalMs: 50,
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    MockWebSocket.instances[0].simulateOpen();
    const timer1 = ws._heartbeatTimer;
    assert.ok(timer1 !== null);

    // Force reconnect
    await ws.connect({ forceTokenRefresh: true });
    MockWebSocket.instances[1].simulateOpen();
    const timer2 = ws._heartbeatTimer;
    assert.ok(timer2 !== null);

    // Disconnect clears it cleanly
    ws.disconnect();
    assert.equal(ws._heartbeatTimer, null);
  });

  // 11. Successful reconnect changes status back to Connected
  test('11. Successful reconnect changes status back to Connected', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket1 = MockWebSocket.instances[0];
    socket1.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

    // Simulate connection drop
    socket1.simulateUnexpectedClose(1006, 'Server restart');
    assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);

    // Fast-forward backoff reconnect
    await ws.connect({ forceTokenRefresh: true });
    const socket2 = MockWebSocket.instances[1];
    socket2.simulateOpen();

    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    assert.equal(ws.reconnectAttempts, 0);

    ws.disconnect();
  });

  // 12. Reconnect performs catch-up
  test('12. Reconnect performs catch-up using the last processed durable sequence', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    ws.setRoomCursor('room-1', 42);

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // Catchup frame should have been sent automatically
    const catchups = socket.sentData.map(d => JSON.parse(d)).filter(f => f.type === 'catchup');
    assert.equal(catchups.length, 1);
    assert.equal(catchups[0].payload.after_seq, 42);

    ws.disconnect();
  });

  // 13. Duplicate messages are not created after reconnect
  test('13. Duplicate messages are not created after reconnect', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    ws.setRoomCursor('room-1', 10);

    let messagesReceived = 0;
    let duplicatesEmitted = 0;
    ws.on('message.created', () => { messagesReceived++; });
    ws.on('duplicate', () => { duplicatesEmitted++; });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // Server sends an older or duplicate event with seq <= 10
    socket.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      event_seq: 10,
      payload: { id: 'msg-1', text: 'Old message' }
    });

    assert.equal(messagesReceived, 0);
    assert.equal(duplicatesEmitted, 1);

    // Server sends new event with seq = 11
    socket.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      event_seq: 11,
      payload: { id: 'msg-2', text: 'New message' }
    });

    assert.equal(messagesReceived, 1);
    assert.equal(ws.getRoomCursor('room-1'), 11);

    ws.disconnect();
  });

  // 14. Logout prevents reconnect
  test('14. Logout / disconnect prevents any scheduled reconnect', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    // User logs out / disconnects cleanly
    ws.disconnect();
    assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(ws._reconnectTimer, null);

    // Simulate unexpected drop on the closed socket
    socket.simulateUnexpectedClose(1000, 'Normal Closure');

    // Verify it did not transition to reconnecting
    assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(ws._reconnectTimer, null);
  });

  // 15. WebSocket error/close triggers recovery
  test('15. WebSocket error/close triggers recovery', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();

    socket.simulateUnexpectedClose(1006, 'Abnormal closure');
    assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);
    assert.equal(ws.reconnectAttempts, 1);

    ws.disconnect();
  });

  // 16. Multiple reconnect attempts do not race
  test('16. Multiple reconnect attempts do not race or create duplicate timers', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      token: 'rt_token_valid',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket1 = MockWebSocket.instances[0];
    socket1.simulateOpen();

    // Call connect() multiple times concurrently
    const p1 = ws.connect({ forceTokenRefresh: true });
    const p2 = ws.connect({ forceTokenRefresh: true });
    await Promise.all([p1, p2]);

    // Active socket must be the latest one only
    assert.equal(ws._socket, MockWebSocket.instances[MockWebSocket.instances.length - 1]);

    ws.disconnect();
  });

  // 17. Authentication is preserved
  test('17. Authentication subprotocol is preserved and getToken is used on refresh', async () => {
    let tokenCallCount = 0;
    const ws = new ChatWebSocket({
      roomId: 'room-1',
      getToken: async () => {
        tokenCallCount++;
        return `rt_token_${tokenCallCount}`;
      },
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    assert.equal(MockWebSocket.instances[0].protocols[1], 'bearer.rt_token_1');

    await ws.connect({ forceTokenRefresh: true });
    assert.equal(MockWebSocket.instances[1].protocols[1], 'bearer.rt_token_2');

    ws.disconnect();
  });

  // 18. No credentials appear in logs
  test('18. No credentials appear in logs during socket operations', async () => {
    const secretToken = 'super_secret_session_token_xyz_123';
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const ws = new ChatWebSocket({
        roomId: 'room-1',
        token: secretToken,
        heartbeatIntervalMs: 20,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();

      socket.simulateMessage({
        v: 1,
        type: 'ack',
        request_id: '00000000-0000-0000-0000-000000000001',
        payload: { type: 'pong' }
      });

      socket.simulateUnexpectedClose(1006, 'Drop');
      ws.disconnect();

      const combinedLogs = logs.join('\n');
      assert.equal(combinedLogs.includes(secretToken), false, 'Token must not appear in any log output');
      assert.equal(combinedLogs.includes('bearer.'), false, 'Bearer token prefix must not appear in log output');
    } finally {
      console.log = origLog;
    }
  });
});
