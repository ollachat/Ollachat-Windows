import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatWebSocket,
  CONNECTION_STATE,
  DEFAULT_WS_URL,
  encodeFrame,
  decodeFrame,
  SimpleEventEmitter
} from '../src/chat/chat-websocket.js';

// Mock WebSocket implementation for unit testing
class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
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

  simulateError(message = 'Mock network error') {
    if (this.onerror) {
      this.onerror(new Error(message));
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

describe('Real-Time Chat WebSocket Layer', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  // 1. Frame Encoding & Decoding Tests
  describe('Protocol Frame Encoding & Decoding', () => {
    test('encodeFrame produces valid JSON with required fields', () => {
      const raw = encodeFrame({
        type: 'ping'
      });
      const parsed = JSON.parse(raw);

      assert.equal(parsed.v, 1);
      assert.equal(parsed.type, 'ping');
      assert.deepEqual(parsed.payload, {});
      assert.ok(typeof parsed.request_id === 'string' && parsed.request_id.length > 0);
      assert.equal(parsed.room_id, undefined);
    });

    test('encodeFrame includes room_id and custom payload when provided', () => {
      const raw = encodeFrame({
        v: 1,
        request_id: 'req-custom-123',
        type: 'message.send',
        room_id: 'room_abc',
        payload: { body: { text: 'Hello World' }, kind: 'text' }
      });
      const parsed = JSON.parse(raw);

      assert.equal(parsed.v, 1);
      assert.equal(parsed.request_id, 'req-custom-123');
      assert.equal(parsed.type, 'message.send');
      assert.equal(parsed.room_id, 'room_abc');
      assert.deepEqual(parsed.payload, { body: { text: 'Hello World' }, kind: 'text' });
    });

    test('encodeFrame throws error if type is missing or not a string', () => {
      assert.throws(() => encodeFrame({}), /Frame type must be a non-empty string/);
      assert.throws(() => encodeFrame({ type: '' }), /Frame type must be a non-empty string/);
      assert.throws(() => encodeFrame({ type: 123 }), /Frame type must be a non-empty string/);
    });

    test('decodeFrame correctly parses valid JSON strings', () => {
      const valid = JSON.stringify({
        v: 1,
        request_id: 'req-1',
        type: 'ack',
        payload: {}
      });
      const frame = decodeFrame(valid);
      assert.equal(frame.v, 1);
      assert.equal(frame.request_id, 'req-1');
      assert.equal(frame.type, 'ack');
    });

    test('decodeFrame throws on invalid input or non-JSON string', () => {
      assert.throws(() => decodeFrame(12345), /Raw frame data must be a string/);
      assert.throws(() => decodeFrame('not a json string'), SyntaxError);
    });

    test('request_id generation is unique UUID v4 format', () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const raw1 = encodeFrame({ type: 'test' });
      const raw2 = encodeFrame({ type: 'test' });

      const parsed1 = JSON.parse(raw1);
      const parsed2 = JSON.parse(raw2);

      assert.match(parsed1.request_id, uuidRegex);
      assert.match(parsed2.request_id, uuidRegex);
      assert.notEqual(parsed1.request_id, parsed2.request_id);
    });
  });

  // 2. SimpleEventEmitter Tests
  describe('SimpleEventEmitter', () => {
    test('registers listener and dispatches events', () => {
      const emitter = new SimpleEventEmitter();
      let received = null;

      emitter.on('test-event', (data) => {
        received = data;
      });

      emitter.emit('test-event', { foo: 'bar' });
      assert.deepEqual(received, { foo: 'bar' });
    });

    test('unsubscribes listener via off() or returned function', () => {
      const emitter = new SimpleEventEmitter();
      let count = 0;

      const handler = () => { count++; };
      const unsubscribe = emitter.on('count', handler);

      emitter.emit('count');
      assert.equal(count, 1);

      unsubscribe();
      emitter.emit('count');
      assert.equal(count, 1);
    });
  });

  // 3. Connection Lifecycle & Authentication
  describe('Connection Lifecycle', () => {
    test('does not connect without a valid session token', async () => {
      const ws = new ChatWebSocket({
        token: null,
        WebSocketClass: MockWebSocket
      });

      let errorEmitted = null;
      ws.on('error', (err) => { errorEmitted = err; });

      await ws.connect();

      assert.equal(ws.state, CONNECTION_STATE.ERROR);
      assert.ok(errorEmitted);
      assert.equal(MockWebSocket.instances.length, 0);
    });

    test('supports dynamic token getter function', async () => {
      let dynamicToken = 'token_initial';
      const ws = new ChatWebSocket({
        getToken: () => dynamicToken,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);
      assert.deepEqual(MockWebSocket.instances[0].protocols, ['chatbox', 'bearer.token_initial']);

      ws.disconnect();
    });

    test('connects with subprotocol chatbox, bearer.{token}', async () => {
      const ws = new ChatWebSocket({
        token: 'secret_session_token_xyz',
        WebSocketClass: MockWebSocket
      });

      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);

      const stateChanges = [];
      ws.on('stateChange', (evt) => stateChanges.push(evt.state));

      await ws.connect();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTING);
      assert.equal(MockWebSocket.instances.length, 1);

      const mockSocket = MockWebSocket.instances[0];
      assert.equal(mockSocket.url, DEFAULT_WS_URL);
      assert.deepEqual(mockSocket.protocols, ['chatbox', 'bearer.secret_session_token_xyz']);

      // Simulate connection established
      mockSocket.simulateOpen();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
      assert.deepEqual(stateChanges, [CONNECTION_STATE.CONNECTING, CONNECTION_STATE.CONNECTED]);

      ws.disconnect();
    });

    test('prevents duplicate connect attempts when already connecting or connected', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      // Call connect again while connecting
      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      // Open socket
      MockWebSocket.instances[0].simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Call connect again while connected
      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      ws.disconnect();
    });

    test('disconnect closes socket with code 1000 and resets state', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      let disconnectedEmitted = false;
      ws.on('disconnected', () => { disconnectedEmitted = true; });

      ws.disconnect();

      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
      assert.equal(mockSocket.closed, true);
      assert.equal(mockSocket.closeCode, 1000);
      assert.equal(mockSocket.closeReason, 'Client disconnect');
    });
  });

  // 4. Send Behavior & Protocol-Specific Helpers
  describe('Send Behavior & Outgoing Frames', () => {
    test('send() throws error if socket is not connected', () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      assert.throws(() => ws.send('ping'), /Cannot send frame: WebSocket is not connected/);
    });

    test('send() sends JSON frame and returns request_id', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      const reqId = ws.send('ping', { test: true }, 'room_1');

      assert.equal(mockSocket.sentData.length, 1);
      const sentFrame = JSON.parse(mockSocket.sentData[0]);

      assert.equal(sentFrame.v, 1);
      assert.equal(sentFrame.type, 'ping');
      assert.equal(sentFrame.request_id, reqId);
      assert.equal(sentFrame.room_id, 'room_1');
      assert.deepEqual(sentFrame.payload, { test: true });

      ws.disconnect();
    });

    test('sendMessage sends message.send frame with expected payload structure', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      const reqId = ws.sendMessage('room_456', 'client_msg_1', { text: 'Hi' }, 'text', 'reply_msg_0', ['att_1']);

      assert.ok(reqId);
      const frame = JSON.parse(mockSocket.sentData[0]);

      assert.equal(frame.type, 'message.send');
      assert.equal(frame.room_id, 'room_456');
      assert.equal(frame.payload.client_message_id, 'client_msg_1');
      assert.deepEqual(frame.payload.body, { text: 'Hi' });
      assert.equal(frame.payload.kind, 'text');
      assert.equal(frame.payload.reply_to, 'reply_msg_0');
      assert.deepEqual(frame.payload.attachment_ids, ['att_1']);

      ws.disconnect();
    });

    test('protocol helpers send correct types: edit, delete, reactions, receipts, typing, catchup', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      ws.editMessage('room_1', 'msg_1', { text: 'Updated' });
      ws.deleteMessage('room_1', 'msg_1');
      ws.addReaction('room_1', 'msg_1', '👍');
      ws.removeReaction('room_1', 'msg_1', '👍');
      ws.markDelivered('room_1', 'msg_1');
      ws.markRead('room_1', 'msg_1');
      ws.typingStarted('room_1');
      ws.typingStopped('room_1');
      ws.catchup(42, 100);

      const sentTypes = mockSocket.sentData.map(d => JSON.parse(d).type);

      assert.deepEqual(sentTypes, [
        'message.edit',
        'message.delete',
        'reaction.add',
        'reaction.remove',
        'receipt.delivered',
        'receipt.read',
        'typing.started',
        'typing.stopped',
        'catchup'
      ]);

      const catchupFrame = JSON.parse(mockSocket.sentData[8]);
      assert.equal(catchupFrame.payload.after_seq, 42);
      assert.equal(catchupFrame.payload.limit, 100);

      ws.disconnect();
    });
  });

  // 5. Incoming Frame Dispatch
  describe('Incoming Frames & Events Dispatch', () => {
    test('dispatches incoming message.created with normalized fields', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      let receivedMsg = null;
      ws.on('message.created', (msg) => { receivedMsg = msg; });

      mockSocket.simulateMessage({
        v: 1,
        type: 'message.created',
        room_id: 'room_101',
        payload: {
          id: 'server_msg_99',
          sender_id: 'user_42',
          kind: 'text',
          body: { text: 'Hello!' },
          created_at: '2026-09-21T12:00:00Z',
          event_seq: 15,
          client_message_id: 'client_msg_uuid'
        }
      });

      assert.ok(receivedMsg);
      assert.equal(receivedMsg.id, 'server_msg_99');
      assert.equal(receivedMsg.roomId, 'room_101');
      assert.equal(receivedMsg.senderId, 'user_42');
      assert.equal(receivedMsg.eventSeq, 15);
      assert.equal(ws.highestSeq, 15);

      ws.disconnect();
    });

    test('dispatches presence.changed and typing events', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      let presenceEvent = null;
      let typingStartedEvent = null;
      let typingStoppedEvent = null;

      ws.on('presence.changed', (evt) => { presenceEvent = evt; });
      ws.on('typing.started', (evt) => { typingStartedEvent = evt; });
      ws.on('typing.stopped', (evt) => { typingStoppedEvent = evt; });

      mockSocket.simulateMessage({
        v: 1,
        type: 'presence.changed',
        room_id: 'room_1',
        payload: { principal_id: 'user_2', online: true }
      });

      mockSocket.simulateMessage({
        v: 1,
        type: 'typing.started',
        room_id: 'room_1',
        payload: { principal_id: 'user_2' }
      });

      mockSocket.simulateMessage({
        v: 1,
        type: 'typing.stopped',
        room_id: 'room_1',
        payload: { principal_id: 'user_2' }
      });

      assert.deepEqual(presenceEvent, { roomId: 'room_1', principalId: 'user_2', online: true });
      assert.deepEqual(typingStartedEvent, { roomId: 'room_1', principalId: 'user_2' });
      assert.deepEqual(typingStoppedEvent, { roomId: 'room_1', principalId: 'user_2' });

      ws.disconnect();
    });

    test('dispatches receipt and reaction events', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      let delivered = null;
      let read = null;
      let reactionAdded = null;
      let reactionRemoved = null;

      ws.on('receipt.delivered', (e) => { delivered = e; });
      ws.on('receipt.read', (e) => { read = e; });
      ws.on('reaction.added', (e) => { reactionAdded = e; });
      ws.on('reaction.removed', (e) => { reactionRemoved = e; });

      mockSocket.simulateMessage({
        type: 'receipt.delivered',
        room_id: 'room_1',
        payload: { message_id: 'm1', principal_id: 'u1' }
      });
      mockSocket.simulateMessage({
        type: 'receipt.read',
        room_id: 'room_1',
        payload: { message_id: 'm1', principal_id: 'u1' }
      });
      mockSocket.simulateMessage({
        type: 'reaction.added',
        room_id: 'room_1',
        payload: { message_id: 'm1', principal_id: 'u1', emoji: '🎉' }
      });
      mockSocket.simulateMessage({
        type: 'reaction.removed',
        room_id: 'room_1',
        payload: { message_id: 'm1', principal_id: 'u1', emoji: '🎉' }
      });

      assert.deepEqual(delivered, { roomId: 'room_1', messageId: 'm1', principalId: 'u1' });
      assert.deepEqual(read, { roomId: 'room_1', messageId: 'm1', principalId: 'u1' });
      assert.deepEqual(reactionAdded, { roomId: 'room_1', messageId: 'm1', principalId: 'u1', emoji: '🎉' });
      assert.deepEqual(reactionRemoved, { roomId: 'room_1', messageId: 'm1', principalId: 'u1', emoji: '🎉' });

      ws.disconnect();
    });

    test('dispatches member.added, member.updated, and member.removed frames', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      mockSocket.simulateOpen();

      let memberAdded = null;
      let memberUpdated = null;
      let memberRemoved = null;

      ws.on('member.added', (e) => { memberAdded = e; });
      ws.on('member.updated', (e) => { memberUpdated = e; });
      ws.on('member.removed', (e) => { memberRemoved = e; });

      mockSocket.simulateMessage({
        type: 'member.added',
        room_id: 'group_room_1',
        payload: { principal_id: 'user_b', role: 'member' }
      });
      mockSocket.simulateMessage({
        type: 'member.updated',
        room_id: 'group_room_1',
        payload: { principal_id: 'user_b', role: 'owner' }
      });
      mockSocket.simulateMessage({
        type: 'member.removed',
        room_id: 'group_room_1',
        payload: { principal_id: 'user_a' }
      });

      assert.deepEqual(memberAdded, { roomId: 'group_room_1', principalId: 'user_b', role: 'member' });
      assert.deepEqual(memberUpdated, { roomId: 'group_room_1', principalId: 'user_b', role: 'owner' });
      assert.deepEqual(memberRemoved, { roomId: 'group_room_1', principalId: 'user_a' });

      ws.disconnect();
    });

    test('dispatches ack, error, and pong frames', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      let ackReceived = null;
      let errorReceived = null;
      let pongReceived = false;

      ws.on('ack', (e) => { ackReceived = e; });
      ws.on('serverError', (e) => { errorReceived = e; });
      ws.on('pong', () => { pongReceived = true; });

      mockSocket.simulateMessage({
        type: 'ack',
        request_id: 'req_123'
      });
      mockSocket.simulateMessage({
        type: 'error',
        request_id: 'req_456',
        payload: { code: 'room_not_found', message: 'Room does not exist' }
      });
      mockSocket.simulateMessage({
        type: 'pong'
      });

      assert.deepEqual(ackReceived, { requestId: 'req_123' });
      assert.deepEqual(errorReceived, {
        code: 'room_not_found',
        message: 'Room does not exist',
        requestId: 'req_456'
      });
      assert.equal(pongReceived, true);

      ws.disconnect();
    });

    test('emits error on invalid non-JSON incoming message without crashing', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      let err = null;
      ws.on('error', (e) => { err = e; });

      mockSocket.simulateMessage('INVALID_JSON_GARBAGE');

      assert.ok(err);
      assert.equal(err.code, 'parse_error');

      ws.disconnect();
    });
  });

  // 6. Heartbeat Ping/Pong
  describe('Heartbeat Maintenance', () => {
    test('sends periodic ping frames based on heartbeatIntervalMs', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket,
        heartbeatIntervalMs: 25 // Fast interval for testing
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      await new Promise(r => setTimeout(r, 350));

      const pingFrames = mockSocket.sentData.map(d => JSON.parse(d)).filter(f => f.type === 'ping');
      assert.ok(pingFrames.length >= 2, `Expected at least 2 ping frames, got ${pingFrames.length}`);

      ws.disconnect();
    });

    test('stops heartbeat interval on disconnect', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket,
        heartbeatIntervalMs: 50
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];
      mockSocket.simulateOpen();

      ws.disconnect();
      const countBefore = mockSocket.sentData.length;

      await new Promise(r => setTimeout(r, 120));
      assert.equal(mockSocket.sentData.length, countBefore);
    });
  });

  // 7. Error Handling, Unexpected Close & Bounded Reconnect
  describe('Unexpected Close & Reconnection Strategy', () => {
    test('handles socket error event', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket = MockWebSocket.instances[0];

      let errorEvent = null;
      ws.on('error', (err) => { errorEvent = err; });

      mockSocket.simulateError('Simulated transport failure');

      assert.ok(errorEvent);
      assert.equal(errorEvent.code, 'socket_error');

      ws.disconnect();
    });

    test('unexpected close triggers reconnecting state with bounded backoff', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket,
        maxReconnectAttempts: 3
      });

      await ws.connect();
      const mockSocket1 = MockWebSocket.instances[0];
      mockSocket1.simulateOpen();

      const states = [];
      ws.on('stateChange', (e) => states.push(e.state));

      // Unexpected drop
      mockSocket1.simulateUnexpectedClose(1006, 'Abnormal closure');

      assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);
      assert.equal(ws.reconnectAttempts, 1);

      // Clean up timer
      ws.disconnect();
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    });

    test('exceeding maxReconnectAttempts transitions to ERROR state', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket,
        maxReconnectAttempts: 2
      });

      ws.reconnectAttempts = 2; // Simulate already attempted twice
      ws._handleUnexpectedClose(1006, 'Connection dropped');

      assert.equal(ws.state, CONNECTION_STATE.ERROR);

      ws.disconnect();
    });

    test('sends catchup frame on reconnect if highestSeq > 0', async () => {
      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const mockSocket1 = MockWebSocket.instances[0];
      mockSocket1.simulateOpen();

      // Receive event with sequence number
      mockSocket1.simulateMessage({
        type: 'message.created',
        room_id: 'room_1',
        payload: { id: 'm1', event_seq: 88 }
      });

      assert.equal(ws.highestSeq, 88);

      // Simulate unexpected disconnect and reconnect
      ws.disconnect(); // manual disconnect resets reconnectAttempts

      // Reconnect
      await ws.connect();
      const mockSocket2 = MockWebSocket.instances[1];
      mockSocket2.simulateOpen();

      // The new socket should have sent a catchup frame on open
      const catchupFrames = mockSocket2.sentData.map(d => JSON.parse(d)).filter(f => f.type === 'catchup');
      assert.equal(catchupFrames.length, 1);
      assert.equal(catchupFrames[0].payload.after_seq, 88);

      ws.disconnect();
    });
  });

  // 8. Room-Scoped WebSocket & Security Invariants
  describe('8. Room-Scoped WebSocket & Security Invariants', () => {
    test('connects with room-scoped access token and subprotocol chatbox, bearer.<room_token>', async () => {
      const roomToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb29tX2lkIjoiY29udl8xIn0.sig';
      const ws = new ChatWebSocket({
        roomId: 'conv_1',
        token: roomToken,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTING);
      assert.equal(MockWebSocket.instances.length, 1);
      assert.deepEqual(MockWebSocket.instances[0].protocols, ['chatbox', `bearer.${roomToken}`]);

      ws.disconnect();
    });

    test('security: strictly rejects du_ directory session tokens and transitions to ERROR', async () => {
      const duToken = 'du_session_token_1234567890';
      const ws = new ChatWebSocket({
        roomId: 'conv_1',
        token: duToken,
        WebSocketClass: MockWebSocket
      });

      let errorEmitted = null;
      ws.on('error', (err) => { errorEmitted = err; });

      await ws.connect();

      assert.equal(ws.state, CONNECTION_STATE.ERROR);
      assert.ok(errorEmitted);
      assert.match(errorEmitted.message, /Cannot connect ChatWebSocket with Directory session token/i);
      // Ensure no WebSocket instance was created
      assert.equal(MockWebSocket.instances.length, 0);

      ws.disconnect();
    });

    test('switching Room A -> Room B disconnects Room A and connects Room B with new room token', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_A',
        token: 'rt_token_A',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);
      const socketA = MockWebSocket.instances[0];
      assert.deepEqual(socketA.protocols, ['chatbox', 'bearer.rt_token_A']);
      socketA.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
      assert.equal(ws.roomId, 'room_A');

      // Now switch to Room B
      await ws.connect({
        roomId: 'room_B',
        token: 'rt_token_B',
        url: 'wss://api.ollacore.com/v1/chat/ws'
      });

      // Socket A must have been closed
      assert.ok(socketA.closed);
      assert.equal(socketA.closeCode, 1000);

      // Socket B must have been created with room B token
      assert.equal(MockWebSocket.instances.length, 2);
      const socketB = MockWebSocket.instances[1];
      assert.deepEqual(socketB.protocols, ['chatbox', 'bearer.rt_token_B']);
      assert.equal(ws.roomId, 'room_B');

      ws.disconnect();
    });

    test('dynamic token getter receives active roomId', async () => {
      const requestedRooms = [];
      const ws = new ChatWebSocket({
        roomId: 'room_test',
        getToken: async (roomId) => {
          requestedRooms.push(roomId);
          return `rt_token_for_${roomId}`;
        },
        WebSocketClass: MockWebSocket
      });

      await ws.connect();

      assert.deepEqual(requestedRooms, ['room_test']);
      assert.equal(MockWebSocket.instances.length, 1);
      assert.deepEqual(MockWebSocket.instances[0].protocols, ['chatbox', 'bearer.rt_token_for_room_test']);

      ws.disconnect();
    });

    test('logout / disconnect cleanly resets active socket, state, and room cursors', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_1',
        token: 'rt_token_1',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      ws.disconnect();
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
      assert.ok(socket.closed);
      assert.equal(ws._socket, null);
    });
  });

  describe('9. Extended Long-Duration Lifecycle, Stale Token Refresh, Heartbeat Pong Timeout & Catchup Tests', () => {
    test('initial connection establishes open state and starts heartbeat', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_longlife',
        token: 'rt_token_init',
        heartbeatIntervalMs: 50,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();

      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
      assert.ok(ws._heartbeatTimer !== null);

      ws.disconnect();
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
      assert.equal(ws._heartbeatTimer, null);
    });

    test('heartbeat lifecycle: ping frames are sent and incoming pong resets deadline', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_hb',
        token: 'rt_token_hb',
        heartbeatIntervalMs: 50,
        heartbeatTimeoutMs: 100,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();

      // Wait for at least one ping
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(socket.sentData.length >= 1);
      const pingFrame = decodeFrame(socket.sentData[0]);
      assert.equal(pingFrame.type, 'ping');

      // Simulate pong from server
      socket.simulateMessage(encodeFrame({ type: 'pong' }));
      assert.ok(ws.lastPongAt > 0);
      assert.equal(ws._awaitingPong, false);

      ws.disconnect();
    });

    test('heartbeat timeout: missed pong deadline triggers unexpected close and reconnect', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_hb_timeout',
        token: 'rt_token_timeout',
        heartbeatIntervalMs: 25,
        heartbeatTimeoutMs: 35,
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();

      const errorPromise = new Promise((resolve) => {
        ws.on('error', (err) => {
          if (err?.code === 'heartbeat_timeout') {
            resolve(err);
          }
        });
      });

      const err = await Promise.race([
        errorPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for heartbeat error')), 400))
      ]);

      assert.ok(err !== null);
      assert.equal(err.code, 'heartbeat_timeout');
      assert.ok(ws.state === CONNECTION_STATE.RECONNECTING || ws.state === CONNECTION_STATE.CONNECTING);

      ws.disconnect();
    });

    test('unexpected server close (including token expiration) clears cached token and fetches fresh token on reconnect', async () => {
      let tokenFetchCount = 0;
      const tokens = ['rt_token_first', 'rt_token_refreshed_after_expiry'];

      const ws = new ChatWebSocket({
        roomId: 'room_expire',
        getToken: async () => {
          const tok = tokens[tokenFetchCount] || 'rt_token_fallback';
          tokenFetchCount++;
          return tok;
        },
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      assert.equal(tokenFetchCount, 1);
      assert.equal(MockWebSocket.instances.length, 1);
      const socket1 = MockWebSocket.instances[0];
      assert.deepEqual(socket1.protocols, ['chatbox', 'bearer.rt_token_first']);
      socket1.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Simulate server abruptly closing socket due to 10-12m token expiration (code 1000 or 1006 without manual close)
      socket1.simulateUnexpectedClose(1006, 'Token expired');
      assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);
      assert.equal(ws._token, null); // Cached token must be purged so next connection fetches new token

      // Trigger reconnect timer
      await new Promise((resolve) => setTimeout(resolve, 1150));

      assert.equal(tokenFetchCount, 2);
      assert.equal(MockWebSocket.instances.length, 2);
      const socket2 = MockWebSocket.instances[1];
      assert.deepEqual(socket2.protocols, ['chatbox', 'bearer.rt_token_refreshed_after_expiry']);

      socket2.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      ws.disconnect();
    });

    test('stale socket cleanup: reconnect detaches listeners from old socket', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_stale',
        token: 'rt_token_stale',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket1 = MockWebSocket.instances[0];
      socket1.simulateOpen();

      // Trigger unexpected close
      socket1.simulateUnexpectedClose(1006, 'Connection dropped');
      assert.equal(socket1.onmessage, null);
      assert.equal(socket1.onerror, null);
      assert.equal(socket1.onopen, null);

      ws.disconnect();
    });

    test('duplicate connection prevention: connect() ignores redundant calls while connected or connecting', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_dup',
        token: 'rt_token_dup',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      // Calling connect while CONNECTING does not create second socket
      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Calling connect while CONNECTED does not create second socket
      await ws.connect();
      assert.equal(MockWebSocket.instances.length, 1);

      ws.disconnect();
    });

    test('connection status returns to CONNECTED after reconnect and emits connected event', async () => {
      const states = [];
      const ws = new ChatWebSocket({
        roomId: 'room_status',
        token: 'rt_token_status',
        WebSocketClass: MockWebSocket
      });

      ws.on('stateChange', ({ state }) => states.push(state));

      await ws.connect();
      MockWebSocket.instances[0].simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Simulate drop
      MockWebSocket.instances[0].simulateUnexpectedClose(1006, 'Network drop');
      assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(MockWebSocket.instances.length, 2);

      MockWebSocket.instances[1].simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      assert.ok(states.includes('connecting'));
      assert.ok(states.includes('connected'));
      assert.ok(states.includes('reconnecting'));

      ws.disconnect();
    });

    test('catchup frame sent after reconnect when room cursor > 0', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_catchup',
        token: 'rt_token_catchup',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket1 = MockWebSocket.instances[0];
      socket1.simulateOpen();

      // Receive a message to advance cursor to sequence 42
      socket1.simulateMessage(encodeFrame({
        type: 'message.created',
        room_id: 'room_catchup',
        event_seq: 42,
        payload: {
          id: 'msg-42',
          room_id: 'room_catchup',
          event_seq: 42,
          body: { text: 'Hello' }
        }
      }));

      assert.equal(ws.getRoomCursor('room_catchup'), 42);

      // Disconnect abruptly
      socket1.simulateUnexpectedClose(1006, 'Drop');

      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(MockWebSocket.instances.length, 2);
      const socket2 = MockWebSocket.instances[1];
      socket2.simulateOpen();

      // Socket 2 must have immediately sent catchup frame for sequence 42
      const catchupFrame = socket2.sentData.map(decodeFrame).find((f) => f.type === 'catchup');
      assert.ok(catchupFrame, 'Must have sent a catchup frame on reconnect');
      assert.equal(catchupFrame.payload.after_seq, 42);
      assert.equal(catchupFrame.room_id, 'room_catchup');

      ws.disconnect();
    });

    test('clean manual logout/disconnect does not trigger unwanted reconnect', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room_manual',
        token: 'rt_token_manual',
        WebSocketClass: MockWebSocket
      });

      await ws.connect();
      const socket = MockWebSocket.instances[0];
      socket.simulateOpen();
      assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

      // Clean manual disconnect
      ws.disconnect();
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
      assert.equal(ws._reconnectTimer, null);

      // Wait to ensure no reconnect timer fires
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(MockWebSocket.instances.length, 1);
      assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    });
  });
});
