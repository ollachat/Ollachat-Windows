import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatWebSocket,
  CONNECTION_STATE,
  decodeFrame,
  isSocketOpen
} from '../src/chat/chat-websocket.js';

class StrictMockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // 0: CONNECTING
    this.sentData = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;

    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    StrictMockWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState === 0) {
      // Mimic exact Undici DOMException thrown when send is called before OPEN
      const err = new Error('Sent before connected.');
      err.name = 'InvalidStateError';
      throw err;
    }
    if (this.readyState !== 1) {
      const err = new Error('WebSocket is not open.');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (typeof this.onclose === 'function') {
      this.onclose({ code, reason });
    }
  }

  terminate() {
    this.close(1006, 'Terminated');
  }

  simulateOpen() {
    this.readyState = 1; // 1: OPEN
    if (typeof this.onopen === 'function') {
      this.onopen();
    }
  }

  simulateMessage(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: raw });
    }
  }
}

describe('WebSocket Send Guards & InvalidStateError Fix Suite', () => {
  beforeEach(() => {
    StrictMockWebSocket.instances = [];
  });

  test('1. Sending while CONNECTING does not throw an uncaught exception (buffers in FIFO queue)', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-101',
      token: 'rt_token_101',
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0
    });

    try {
      await ws.connect();
      assert.equal(StrictMockWebSocket.instances.length, 1);
      const socket = StrictMockWebSocket.instances[0];
      assert.equal(socket.readyState, 0); // Still CONNECTING

      // Attempting to send while socket is CONNECTING must NOT throw InvalidStateError
      let reqId = null;
      assert.doesNotThrow(() => {
        reqId = ws.sendMessage('room-101', 'client-msg-1', 'Hello during connecting');
      });

      assert.ok(reqId, 'Should return a valid request ID');
      assert.equal(socket.sentData.length, 0, 'Socket.send must not be called while CONNECTING');

      // The message is queued in pendingQueue
      const pending = ws.getPendingQueue('room-101');
      assert.equal(pending.length, 1, 'Should have 1 queued item');
      assert.equal(pending[0].requestId, reqId);
    } finally {
      ws.disconnect();
    }
  });

  test('2. Sending while CLOSING or CLOSED does not crash the app', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-102',
      token: 'rt_token_102',
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0
    });

    try {
      await ws.connect();
      const socket = StrictMockWebSocket.instances[0];
      socket.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Transition socket to CLOSING (readyState = 2)
      socket.readyState = 2;

      // When socket is closing and client is disconnected, calling send throws a handled Error, NOT an uncaught InvalidStateError
      ws.disconnect();
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);

      assert.throws(
        () => {
          ws.sendMessage('room-102', 'msg-closed', 'Hello after close');
        },
        {
          name: 'Error',
          message: /WebSocket is not connected/
        }
      );
    } finally {
      ws.disconnect();
    }
  });

  test('3. A queued durable message is delivered once after the socket becomes OPEN', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-103',
      token: 'rt_token_103',
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0
    });

    try {
      await ws.connect();
      const socket = StrictMockWebSocket.instances[0];

      // Queue 3 messages while socket is in CONNECTING state
      const req1 = ws.sendMessage('room-103', 'c1', 'First queued message');
      const req2 = ws.sendMessage('room-103', 'c2', 'Second queued message');
      const req3 = ws.sendMessage('room-103', 'c3', 'Third queued message');

      assert.equal(socket.sentData.length, 0, 'Nothing sent over socket yet');
      assert.equal(ws.getPendingQueue().length, 3);

      // Now socket handshake completes and OPEN fires
      socket.simulateOpen();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
      assert.equal(socket.sentData.length, 3, 'All 3 queued messages must be delivered once');

      // Verify FIFO ordering
      const decoded1 = decodeFrame(socket.sentData[0]);
      const decoded2 = decodeFrame(socket.sentData[1]);
      const decoded3 = decodeFrame(socket.sentData[2]);

      assert.equal(decoded1.request_id, req1);
      assert.equal(decoded1.payload.client_message_id, 'c1');
      assert.equal(decoded2.request_id, req2);
      assert.equal(decoded2.payload.client_message_id, 'c2');
      assert.equal(decoded3.request_id, req3);
      assert.equal(decoded3.payload.client_message_id, 'c3');

      // Queue must now be empty
      assert.equal(ws.getPendingQueue().length, 0);
    } finally {
      ws.disconnect();
    }
  });

  test('4. Stale callbacks from an old socket cannot affect a replacement socket', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-104',
      token: 'rt_token_104',
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0
    });

    try {
      await ws.connect();
      assert.equal(StrictMockWebSocket.instances.length, 1);
      const oldSocket = StrictMockWebSocket.instances[0];

      // Reconnect / create replacement socket
      await ws.connect({ forceTokenRefresh: true });
      assert.equal(StrictMockWebSocket.instances.length, 2);
      const newSocket = StrictMockWebSocket.instances[1];

      // Now old socket fires simulateOpen after replacement socket was created
      oldSocket.simulateOpen();

      // Old socket callback must NOT have made oldSocket active or altered state inappropriately
      assert.notEqual(ws._socket, oldSocket, 'Current socket must not be oldSocket');
      assert.equal(ws._socket, newSocket, 'Current socket must be newSocket');

      // Old socket onmessage should be ignored
      let frameReceived = false;
      ws.on('message.created', () => {
        frameReceived = true;
      });

      oldSocket.simulateMessage({
        type: 'message.created',
        payload: { id: 'stale-msg', body: { text: 'stale' } }
      });

      assert.equal(frameReceived, false, 'Stale message from old socket must be ignored');

      // New socket opens normally
      newSocket.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    } finally {
      ws.disconnect();
    }
  });

  test('5. Repeated reconnects do not produce duplicate sends or listeners', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room-105',
      token: 'rt_token_105',
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0,
      multiRoom: true
    });

    try {
      await ws.connectRoom('room-105');
      const socket1 = StrictMockWebSocket.instances[0];

      // Queue 1 message during initial connect
      const reqId = ws.sendMessage('room-105', 'c-unique-1', 'Deliver exactly once');

      // Open socket 1
      socket1.simulateOpen();
      assert.equal(socket1.sentData.length, 1);
      assert.equal(decodeFrame(socket1.sentData[0]).request_id, reqId);

      // Reconnect room
      await ws.connectRoom('room-105', { forceTokenRefresh: true });
      const socket2 = StrictMockWebSocket.instances[1];
      socket2.simulateOpen();

      // Socket 2 must NOT re-send the previously drained message!
      assert.equal(socket2.sentData.length, 0, 'Socket 2 should have 0 duplicate sends');
    } finally {
      ws.disconnect();
    }
  });

  test('6. Multi-room sockets remain isolated in state and pending queues', async () => {
    const ws = new ChatWebSocket({
      WebSocketClass: StrictMockWebSocket,
      connectTimeoutMs: 0,
      multiRoom: true
    });

    try {
      await ws.connectRoom('room-A', { token: 'rt_token_A' });
      await ws.connectRoom('room-B', { token: 'rt_token_B' });

      assert.equal(StrictMockWebSocket.instances.length, 2);
      const socketA = StrictMockWebSocket.instances[0];
      const socketB = StrictMockWebSocket.instances[1];

      // Queue messages into room A and room B while both are CONNECTING
      const reqA = ws.sendMessage('room-A', 'cA', 'Message for A');
      const reqB = ws.sendMessage('room-B', 'cB', 'Message for B');

      assert.equal(ws.getPendingQueue('room-A').length, 1);
      assert.equal(ws.getPendingQueue('room-B').length, 1);
      assert.equal(socketA.sentData.length, 0);
      assert.equal(socketB.sentData.length, 0);

      // Open ONLY Room A
      socketA.simulateOpen();

      // Room A should be sent, Room B must NOT be sent over Socket A
      assert.equal(socketA.sentData.length, 1);
      assert.equal(decodeFrame(socketA.sentData[0]).request_id, reqA);
      assert.equal(ws.getPendingQueue('room-A').length, 0);

      // Room B should still be in CONNECTING with its pending queue intact
      assert.equal(socketB.sentData.length, 0);
      assert.equal(ws.getPendingQueue('room-B').length, 1);

      // Now open Room B
      socketB.simulateOpen();
      assert.equal(socketB.sentData.length, 1);
      assert.equal(decodeFrame(socketB.sentData[0]).request_id, reqB);
      assert.equal(ws.getPendingQueue('room-B').length, 0);
    } finally {
      ws.disconnect();
    }
  });

  test('7. isSocketOpen accurately evaluates standard, Undici, ws and mock socket states', () => {
    assert.equal(isSocketOpen(null), false);
    assert.equal(isSocketOpen(undefined), false);

    // readyState numbers: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    assert.equal(isSocketOpen({ readyState: 0 }), false);
    assert.equal(isSocketOpen({ readyState: 1 }), true);
    assert.equal(isSocketOpen({ readyState: 2 }), false);
    assert.equal(isSocketOpen({ readyState: 3 }), false);

    // Mock objects without readyState field default to true
    assert.equal(isSocketOpen({ send: () => {} }), true);
  });
});
