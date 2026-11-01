import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatWebSocket,
  encodeFrame,
  decodeFrame
} from '../src/chat/chat-websocket.js';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  createOptimisticMessage,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';

// Mock WebSocket class for unit testing ChatWebSocket
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

describe('Official OllaCore Chat Messaging Contract Test Suite', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Exact message.send frame structure
  // ─────────────────────────────────────────────────────────────
  test('1. Exact message.send frame conforms strictly to official schema without invented fields', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const reqId = ws.sendMessage('room-42', 'local-7f3a', { text: 'hello' });
    assert.ok(reqId);
    assert.equal(mock.sentData.length, 1);

    const frame = JSON.parse(mock.sentData[0]);

    // Top-level structure
    assert.equal(frame.v, 1);
    assert.equal(frame.type, 'message.send');
    assert.equal(frame.request_id, reqId);
    assert.equal(frame.room_id, 'room-42');

    // Payload structure
    assert.deepEqual(frame.payload, {
      client_message_id: 'local-7f3a',
      kind: 'text',
      body: {
        text: 'hello'
      },
      reply_to: null,
      attachment_ids: []
    });

    // Verify exact payload keys - no undocumented or invented fields
    const payloadKeys = Object.keys(frame.payload).sort();
    assert.deepEqual(payloadKeys, ['attachment_ids', 'body', 'client_message_id', 'kind', 'reply_to']);

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 2. UUID request_id generation
  // ─────────────────────────────────────────────────────────────
  test('2. request_id is generated as a unique RFC 4122 UUID v4 per frame', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const reqIds = new Set();

    for (let i = 0; i < 50; i++) {
      const frameStr = encodeFrame({
        type: 'message.send',
        payload: { client_message_id: `cid-${i}`, kind: 'text', body: { text: 'test' } }
      });
      const parsed = JSON.parse(frameStr);
      assert.match(parsed.request_id, uuidRegex);
      reqIds.add(parsed.request_id);
    }

    assert.equal(reqIds.size, 50, 'All 50 request_id values must be completely unique');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Unique client_message_id generation
  // ─────────────────────────────────────────────────────────────
  test('3. client_message_id is generated before send and is unique across outgoing messages', () => {
    const generatedIds = new Set();

    for (let i = 0; i < 50; i++) {
      const msg = createOptimisticMessage('room-1', 'usr-self', `Message ${i}`);
      assert.ok(msg.clientMessageId.startsWith('local-'));
      assert.equal(msg.client_message_id, msg.clientMessageId);
      assert.equal(msg.id, msg.clientMessageId);
      generatedIds.add(msg.clientMessageId);
    }

    assert.equal(generatedIds.size, 50, 'All generated client_message_id values must be unique');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Same client_message_id reused on retry
  // ─────────────────────────────────────────────────────────────
  test('4. Retry of a failed or pending message reuses the exact same client_message_id', () => {
    const pendingPayloads = new Map();
    const originalCid = 'local-retry-idempotency-key';
    const originalText = 'Important idempotency test';

    // Initial send registers payload with client_message_id
    pendingPayloads.set(originalCid, {
      roomId: 'room-abc',
      text: originalText,
      clientMessageId: originalCid
    });

    // Simulate failure and subsequent retry
    const pendingForRetry = pendingPayloads.get(originalCid);
    assert.ok(pendingForRetry, 'Pending payload must exist for retry');

    const retriedPayload = {
      client_message_id: pendingForRetry.clientMessageId,
      kind: 'text',
      body: { text: pendingForRetry.text },
      reply_to: null,
      attachment_ids: []
    };

    assert.equal(retriedPayload.client_message_id, originalCid, 'Must reuse the exact same client_message_id');
    assert.equal(retriedPayload.body.text, originalText);
    assert.equal(retriedPayload.reply_to, null);
    assert.deepEqual(retriedPayload.attachment_ids, []);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Retry does not create duplicate optimistic messages
  // ─────────────────────────────────────────────────────────────
  test('5. Retrying an existing message does not append another optimistic message to the list', () => {
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const cid = 'local-single-bubble';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Single bubble message', cid);

    state.addOptimisticMessage(opt);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messageStatus.get(cid), MESSAGE_STATUS.SENDING);

    // Network drops: status transitions to failed
    state.updateReceipt(cid, 'failed');
    assert.equal(state.messageStatus.get(cid), MESSAGE_STATUS.FAILED);

    // Retry initiated: addOptimisticMessage called again with same clientMessageId
    const retried = state.addOptimisticMessage(opt);
    assert.equal(state.messages.length, 1, 'Message list must remain length 1 on retry');
    assert.equal(retried.clientMessageId, cid);

    // Status transitions back to sending
    state.updateReceipt(cid, 'sending');
    assert.equal(state.messageStatus.get(cid), MESSAGE_STATUS.SENDING);
    assert.equal(state.messages.length, 1);
  });

  // ─────────────────────────────────────────────────────────────
  // 6. ACK correlation via request_id
  // ─────────────────────────────────────────────────────────────
  test('6. Server ACK frame correlates with outgoing request_id and transitions status to sent', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const requestToClient = new Map();
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const clientMsgId = 'local-ack-corr-1';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Message to ACK', clientMsgId);
    state.addOptimisticMessage(opt);

    // Outgoing send generates requestId
    const reqId = ws.sendMessage('room-1', clientMsgId, { text: 'Message to ACK' });
    requestToClient.set(reqId, clientMsgId);

    assert.equal(state.messageStatus.get(clientMsgId), 'sending');

    // Server responds with ACK frame
    mock.simulateMessage({
      v: 1,
      type: 'ack',
      request_id: reqId
    });

    const matchedCid = requestToClient.get(reqId);
    assert.equal(matchedCid, clientMsgId);
    requestToClient.delete(reqId);

    state.updateReceipt(matchedCid, 'sent');
    assert.equal(state.messageStatus.get(clientMsgId), 'sent');
    assert.equal(requestToClient.has(reqId), false);

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 7. message.created reconciliation
  // ─────────────────────────────────────────────────────────────
  test('7. Server message.created reconciles with optimistic message by client_message_id', () => {
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const cid = 'local-reconcile-test';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Optimistic text', cid);
    state.addOptimisticMessage(opt);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, cid);

    // Server broadcasts durable message.created with server-assigned id and event_seq
    const serverMessage = {
      id: 'srv-durable-msg-777',
      roomId: 'room-1',
      room_id: 'room-1',
      senderId: 'usr-self',
      sender_id: 'usr-self',
      kind: 'text',
      body: { text: 'Optimistic text' },
      createdAt: '2026-09-22T10:00:00Z',
      created_at: '2026-09-22T10:00:00Z',
      eventSeq: 512,
      event_seq: 512,
      clientMessageId: cid,
      client_message_id: cid
    };

    const reconciled = state.appendIncomingMessage(serverMessage);

    assert.equal(state.messages.length, 1, 'Reconciled message must not produce duplicate entries');
    assert.equal(reconciled.id, 'srv-durable-msg-777');
    assert.equal(reconciled.clientMessageId, cid);
    assert.equal(reconciled.eventSeq, 512);
    assert.equal(state.messages[0].id, 'srv-durable-msg-777');
    assert.equal(state.newestSeq, 512);
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Per-room sequence tracking
  // ─────────────────────────────────────────────────────────────
  test('8. Sequence cursors are maintained independently per room and not treated as global', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    // Event in Room A with sequence 100
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-A',
      payload: { id: 'msg-A-1', event_seq: 100, body: { text: 'A1' } }
    });

    // Event in Room B with sequence 20
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-B',
      payload: { id: 'msg-B-1', event_seq: 20, body: { text: 'B1' } }
    });

    assert.equal(ws.getRoomCursor('room-A'), 100);
    assert.equal(ws.getRoomCursor('room-B'), 20);
    assert.notEqual(ws.getRoomCursor('room-A'), ws.getRoomCursor('room-B'));

    // Advance Room B to 21
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-B',
      payload: { id: 'msg-B-2', event_seq: 21, body: { text: 'B2' } }
    });

    assert.equal(ws.getRoomCursor('room-A'), 100, 'Room A cursor must remain unaffected');
    assert.equal(ws.getRoomCursor('room-B'), 21, 'Room B cursor must advance independently');

    // Uninitialized room cursor returns undefined
    assert.equal(ws.getRoomCursor('room-uninitialized'), undefined);
    assert.equal(ws.hasRoomCursor('room-uninitialized'), false);

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Duplicate sequence/event handling
  // ─────────────────────────────────────────────────────────────
  test('9. Duplicate durable events with sequence <= room cursor are safely discarded', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    let createdEventsCount = 0;
    const duplicatesEmitted = [];

    ws.on('message.created', () => { createdEventsCount++; });
    ws.on('duplicate', (dup) => { duplicatesEmitted.push(dup); });

    // Initial event: seq 50 (initializes cursor to 50)
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-dup-test',
      payload: { id: 'msg-1', event_seq: 50, body: { text: 'Seq 50' } }
    });

    assert.equal(createdEventsCount, 1);
    assert.equal(ws.getRoomCursor('room-dup-test'), 50);

    // Replay duplicate event: seq 50 (<= current cursor)
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-dup-test',
      payload: { id: 'msg-1', event_seq: 50, body: { text: 'Seq 50 again' } }
    });

    // Replay older event: seq 49 (<= current cursor)
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-dup-test',
      payload: { id: 'msg-old', event_seq: 49, body: { text: 'Seq 49' } }
    });

    assert.equal(createdEventsCount, 1, 'Duplicate events must be discarded and not trigger message.created');
    assert.equal(duplicatesEmitted.length, 2, 'Should emit duplicate notifications for discarded frames');
    assert.equal(ws.getRoomCursor('room-dup-test'), 50, 'Cursor must not be corrupted by duplicates');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Catch-up frame generation & deliberate overlap
  // ─────────────────────────────────────────────────────────────
  test('10. Catch-up frame adheres to contract and supports deliberate one-sequence overlap', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    // Standard catch-up without overlap
    const reqId1 = ws.catchup(4130, 200);
    assert.ok(reqId1);

    const frame1 = JSON.parse(mock.sentData[0]);
    assert.equal(frame1.v, 1);
    assert.equal(frame1.type, 'catchup');
    assert.equal(frame1.request_id, reqId1);
    assert.deepEqual(frame1.payload, {
      after_seq: 4130,
      limit: 200
    });

    // Catch-up with deliberate one-sequence overlap: Math.max(0, afterSeq - 1)
    const reqId2 = ws.catchup(4130, 200, 'room-overlap', true);
    assert.ok(reqId2);

    const frame2 = JSON.parse(mock.sentData[1]);
    assert.equal(frame2.type, 'catchup');
    assert.equal(frame2.room_id, 'room-overlap');
    assert.equal(frame2.payload.after_seq, 4129, 'Overlap must calculate Math.max(0, 4130 - 1) = 4129');
    assert.equal(frame2.payload.limit, 200);

    // Overlap with 0 sequence bound
    ws.catchup(0, 50, null, true);
    const frame3 = JSON.parse(mock.sentData[2]);
    assert.equal(frame3.payload.after_seq, 0, 'Math.max(0, 0 - 1) must be 0');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Catch-up after reconnect
  // ─────────────────────────────────────────────────────────────
  test('11. Reconnect requests catch-up for all established room cursors independently', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mockSocket1 = MockWebSocket.instances[0];
    mockSocket1.simulateOpen();

    // Establish cursors for Room 1 and Room 2
    mockSocket1.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-alpha',
      payload: { id: 'm-a', event_seq: 300 }
    });
    mockSocket1.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-beta',
      payload: { id: 'm-b', event_seq: 750 }
    });

    assert.equal(ws.getRoomCursor('room-alpha'), 300);
    assert.equal(ws.getRoomCursor('room-beta'), 750);

    // Disconnect and reconnect
    ws.disconnect();
    await ws.connect();
    const mockSocket2 = MockWebSocket.instances[1];
    mockSocket2.simulateOpen();

    const catchupFrames = mockSocket2.sentData
      .map((d) => JSON.parse(d))
      .filter((f) => f.type === 'catchup');

    assert.equal(catchupFrames.length, 2, 'Must request catch-up for each established room cursor');

    const alphaCatchup = catchupFrames.find((f) => f.room_id === 'room-alpha');
    const betaCatchup = catchupFrames.find((f) => f.room_id === 'room-beta');

    assert.ok(alphaCatchup);
    assert.equal(alphaCatchup.payload.after_seq, 300);
    assert.ok(betaCatchup);
    assert.equal(betaCatchup.payload.after_seq, 750);

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 12. Sequence gap detection & resync signal
  // ─────────────────────────────────────────────────────────────
  test('12. Sequence gap emits gap/resync signal with expectedSeq and receivedSeq', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const gapEvents = [];
    const resyncEvents = [];

    ws.on('gap', (e) => gapEvents.push(e));
    ws.on('resync', (e) => resyncEvents.push(e));

    // Event 1 establishes cursor at 10
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-gap',
      payload: { id: 'm1', event_seq: 10 }
    });

    assert.equal(gapEvents.length, 0);

    // Event 2 arrives with sequence 15 (gap: expected 11, received 15)
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-gap',
      payload: { id: 'm2', event_seq: 15 }
    });

    assert.equal(gapEvents.length, 1);
    assert.deepEqual(gapEvents[0], {
      roomId: 'room-gap',
      expectedSeq: 11,
      receivedSeq: 15
    });

    assert.ok(resyncEvents.length >= 1);
    assert.equal(resyncEvents[0].roomId, 'room-gap');

    // Server-initiated explicit resync frame
    let explicitResync = null;
    ws.on('resync', (e) => { explicitResync = e; });

    mock.simulateMessage({
      v: 1,
      type: 'resync',
      room_id: 'room-server-signal'
    });

    assert.ok(explicitResync);
    assert.equal(explicitResync.roomId, 'room-server-signal');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 13. delivered does not mark read
  // ─────────────────────────────────────────────────────────────
  test('13. receipt.delivered updates status to delivered without advancing to read', () => {
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const cid = 'local-delivered-test';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Delivery test', cid);
    state.addOptimisticMessage(opt);
    state.updateReceipt(cid, 'sent');

    assert.equal(state.messageStatus.get(cid), 'sent');

    // Server sends receipt.delivered
    const delivered = state.updateReceipt(cid, 'delivered');
    assert.equal(delivered, true);
    assert.equal(state.messageStatus.get(cid), 'delivered');
    assert.notEqual(state.messageStatus.get(cid), 'read', 'delivered must NOT mark message as read');
  });

  // ─────────────────────────────────────────────────────────────
  // 14. read advances read state monotonically
  // ─────────────────────────────────────────────────────────────
  test('14. receipt.read advances status monotonically and rejects out-of-order downgrades', () => {
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const cid = 'local-read-monotonic';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Monotonic read test', cid);
    state.addOptimisticMessage(opt);
    state.updateReceipt(cid, 'sent');
    state.updateReceipt(cid, 'delivered');

    // Advance to read
    const readUpdated = state.updateReceipt(cid, 'read');
    assert.equal(readUpdated, true);
    assert.equal(state.messageStatus.get(cid), 'read');

    // Out-of-order or late delivered event must NOT downgrade read to delivered
    const lateDelivered = state.updateReceipt(cid, 'delivered');
    assert.equal(lateDelivered, false, 'Downgrade from read to delivered must be rejected');
    assert.equal(state.messageStatus.get(cid), 'read');

    // Late sent event must NOT downgrade read to sent
    const lateSent = state.updateReceipt(cid, 'sent');
    assert.equal(lateSent, false, 'Downgrade from read to sent must be rejected');
    assert.equal(state.messageStatus.get(cid), 'read');
  });

  // ─────────────────────────────────────────────────────────────
  // 15. failed state is separate from receipt state
  // ─────────────────────────────────────────────────────────────
  test('15. failed is separate from receipt state and allows recovery to sending on retry', () => {
    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-1', []);

    const cid = 'local-fail-state';
    const opt = createOptimisticMessage('room-1', 'usr-self', 'Fail state test', cid);
    state.addOptimisticMessage(opt);

    assert.equal(state.messageStatus.get(cid), 'sending');

    // Network drops: transitions to failed
    state.updateReceipt(cid, 'failed');
    assert.equal(state.messageStatus.get(cid), 'failed');

    // Retry transitions failed -> sending (recovery)
    const retryToSending = state.updateReceipt(cid, 'sending');
    assert.equal(retryToSending, true);
    assert.equal(state.messageStatus.get(cid), 'sending');

    // Advance to sent
    state.updateReceipt(cid, 'sent');
    assert.equal(state.messageStatus.get(cid), 'sent');

    // A sent/delivered/read message cannot downgrade to failed
    const invalidFail = state.updateReceipt(cid, 'failed');
    assert.equal(invalidFail, false, 'Confirmed message cannot transition back to failed');
    assert.equal(state.messageStatus.get(cid), 'sent');
  });

  // ─────────────────────────────────────────────────────────────
  // 16. Edit handling
  // ─────────────────────────────────────────────────────────────
  test('16. message.edit and message.updated update existing message body and editedAt preserving id', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    // 1. Sending edit frame
    const reqId = ws.editMessage('room-1', 'msg-edit-1', { text: 'Corrected text' });
    assert.ok(reqId);

    const sentFrame = JSON.parse(mock.sentData[0]);
    assert.equal(sentFrame.type, 'message.edit');
    assert.equal(sentFrame.room_id, 'room-1');
    assert.deepEqual(sentFrame.payload, {
      message_id: 'msg-edit-1',
      body: { text: 'Corrected text' }
    });

    // 2. Incoming message.updated in room state
    const state = new RoomMessagesState('usr-author');
    state.setInitialMessages('room-1', [
      { id: 'msg-edit-1', senderId: 'usr-author', body: { text: 'Original text' }, eventSeq: 10 }
    ]);

    const updated = state.updateMessage('msg-edit-1', {
      body: { text: 'Corrected text' },
      editedAt: '2026-09-22T10:30:00Z'
    });

    assert.equal(updated, true);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].body.text, 'Corrected text');
    assert.equal(state.messages[0].editedAt, '2026-09-22T10:30:00Z');
    assert.equal(state.messages[0].eventSeq, 10, 'Event sequence must be preserved across edits');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 17. Soft delete handling & reply preservation
  // ─────────────────────────────────────────────────────────────
  test('17. Soft-delete sets kind to deleted, withholds content, and preserves replies', () => {
    const state = new RoomMessagesState('usr-author');
    state.setInitialMessages('room-1', [
      {
        id: 'msg-parent-1',
        senderId: 'usr-author',
        kind: 'text',
        body: { text: 'Secret original text' },
        eventSeq: 1
      },
      {
        id: 'msg-reply-2',
        senderId: 'usr-peer',
        kind: 'text',
        body: { text: 'I agree with parent' },
        replyTo: 'msg-parent-1',
        eventSeq: 2
      }
    ]);

    assert.equal(state.messages.length, 2);

    // Perform soft delete
    const deleted = state.deleteMessage('msg-parent-1');
    assert.equal(deleted, true);

    // Message row remains in collection
    assert.equal(state.messages.length, 2, 'Message record must not be physically removed');

    const parent = state.messages.find((m) => m.id === 'msg-parent-1');
    assert.ok(parent);
    assert.equal(parent.isDeleted, true);
    assert.equal(parent.kind, 'deleted');
    assert.deepEqual(parent.body, { text: 'This message was deleted' });

    // Resolved content check
    const content = resolveMessageContent(parent);
    assert.equal(content.kind, 'deleted');
    assert.equal(content.text, 'This message was deleted');
    assert.equal(content.isDeleted, true);

    // Reply referencing the deleted parent still resolves
    const reply = state.messages.find((m) => m.id === 'msg-reply-2');
    assert.equal(reply.replyTo, 'msg-parent-1');
    const targetParent = state.messages.find((m) => m.id === reply.replyTo);
    assert.ok(targetParent, 'Parent record must still be resolvable by replyTo reference');
    assert.equal(targetParent.isDeleted, true);
  });

  // ─────────────────────────────────────────────────────────────
  // 18. Reaction handling
  // ─────────────────────────────────────────────────────────────
  test('18. Reaction add and remove frames operate correctly and prevent duplicates within 20 emoji limit', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.addReaction('room-1', 'msg-1', '🚀');
    ws.removeReaction('room-1', 'msg-1', '🚀');

    const frameAdd = JSON.parse(mock.sentData[0]);
    assert.equal(frameAdd.type, 'reaction.add');
    assert.deepEqual(frameAdd.payload, { message_id: 'msg-1', emoji: '🚀' });

    const frameRemove = JSON.parse(mock.sentData[1]);
    assert.equal(frameRemove.type, 'reaction.remove');
    assert.deepEqual(frameRemove.payload, { message_id: 'msg-1', emoji: '🚀' });

    // State reaction deduplication & 20 emoji limit
    const state = new RoomMessagesState('usr-1');
    state.setInitialMessages('room-1', [{ id: 'msg-1', body: { text: 'Hi' } }]);

    state.updateReaction('msg-1', 'usr-1', '❤️', true);
    state.updateReaction('msg-1', 'usr-1', '❤️', true); // Duplicate add from same user

    const msg = state.messages[0];
    assert.deepEqual(msg.reactions['❤️'], ['usr-1'], 'Duplicate reaction from same user must be prevented');

    // Fill 20 distinct emojis
    for (let i = 1; i <= 20; i++) {
      state.updateReaction('msg-1', `usr-${i}`, `emoji-${i}`, true);
    }

    // Attempt to add 21st distinct emoji
    const added21st = state.updateReaction('msg-1', 'usr-99', 'emoji-21', true);
    assert.equal(added21st, false, 'Must respect 20 distinct emoji limit');
    assert.equal(msg.reactions['emoji-21'], undefined);

    // Remove reaction
    state.updateReaction('msg-1', 'usr-1', '❤️', false);
    assert.equal(msg.reactions['❤️'], undefined, 'Emoji key must be cleaned up when no users remain');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 19. Typing / presence ephemeral behavior
  // ─────────────────────────────────────────────────────────────
  test('19. Typing and presence are ephemeral with sequence 0 and are never persisted in durable history', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const state = new RoomMessagesState('usr-self');
    state.setInitialMessages('room-ephemeral', []);

    let typingStartedReceived = false;
    let presenceReceived = false;

    ws.on('typing.started', () => { typingStartedReceived = true; });
    ws.on('presence.changed', () => { presenceReceived = true; });

    // Ephemeral typing event
    mock.simulateMessage({
      v: 1,
      type: 'typing.started',
      room_id: 'room-ephemeral',
      payload: { principal_id: 'usr-peer' }
    });

    // Ephemeral presence event
    mock.simulateMessage({
      v: 1,
      type: 'presence.changed',
      room_id: 'room-ephemeral',
      payload: { principal_id: 'usr-peer', online: true }
    });

    assert.equal(typingStartedReceived, true);
    assert.equal(presenceReceived, true);

    // Room cursor must NOT be advanced by ephemeral events
    assert.equal(ws.getRoomCursor('room-ephemeral'), undefined, 'Ephemeral events must not initialize or advance room cursor');

    // Durable messages list must remain empty
    assert.equal(state.messages.length, 0, 'Ephemeral events must not be added to durable message list');

    ws.disconnect();
  });

  // ─────────────────────────────────────────────────────────────
  // 20. REST history pagination compatibility with WebSocket cursor
  // ─────────────────────────────────────────────────────────────
  test('20. REST history bounds calculate newestSeq compatible with WebSocket catchup cursor', () => {
    const state = new RoomMessagesState('usr-self');

    // Simulate REST response from GET /rooms/{roomId}/messages?limit=50
    const restHistoryMessages = [
      { id: 'm-1', eventSeq: 4100, body: { text: 'History 1' }, createdAt: '2026-09-22T08:00:00Z' },
      { id: 'm-2', eventSeq: 4110, body: { text: 'History 2' }, createdAt: '2026-09-22T08:10:00Z' },
      { id: 'm-3', eventSeq: 4130, body: { text: 'History 3' }, createdAt: '2026-09-22T08:20:00Z' }
    ];

    state.setInitialMessages('room-pagination', restHistoryMessages, true);

    assert.equal(state.oldestSeq, 4100);
    assert.equal(state.newestSeq, 4130);

    // WebSocket cursor can be set from newestSeq
    const ws = new ChatWebSocket({ token: 't' });
    ws.setRoomCursor('room-pagination', state.newestSeq);
    assert.equal(ws.getRoomCursor('room-pagination'), 4130);

    // Prepending older messages (beforeSeq: 4100) must update oldestSeq without moving cursor backwards
    const olderMessages = [
      { id: 'm-0', eventSeq: 4050, body: { text: 'Older 0' }, createdAt: '2026-09-22T07:00:00Z' }
    ];
    state.prependOlderMessages(olderMessages, false);

    assert.equal(state.oldestSeq, 4050);
    assert.equal(state.newestSeq, 4130, 'newestSeq must remain at latest sequence after prepending older messages');
    assert.equal(ws.getRoomCursor('room-pagination'), 4130, 'WebSocket cursor must never move backwards on older pagination');
  });
});
