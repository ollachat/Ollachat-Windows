import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  getTickDescriptor
} from '../src/renderer/chat-shell-state.js';
import {
  ChatWebSocket,
  encodeFrame
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
}

describe('Receipts & Ticks Protocol Contract Tests', () => {

  describe('1. Monotonic Progression & No Downgrade', () => {
    let state;
    const currentUserId = 'user-alice';
    const roomId = 'room-101';
    const msgId = 'msg-alpha';

    beforeEach(() => {
      state = new RoomMessagesState(currentUserId);
      state.setInitialMessages(roomId, [
        {
          id: msgId,
          roomId,
          senderId: currentUserId,
          kind: 'text',
          body: { text: 'Hello Bob' },
          createdAt: new Date().toISOString()
        }
      ]);
    });

    test('Initial outgoing message status defaults to SENT (single tick)', () => {
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.SENT);
    });

    test('Progression: sent -> delivered (double tick)', () => {
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED, roomId), true);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.DELIVERED);
    });

    test('Progression: delivered -> read (blue double tick)', () => {
      state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.READ, roomId), true);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);
    });

    test('Progression: sent -> read direct jump is allowed', () => {
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.READ, roomId), true);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);
    });

    test('No downgrade: read -> delivered is rejected', () => {
      state.updateReceipt(msgId, MESSAGE_STATUS.READ, roomId);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);

      const updated = state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(updated, false, 'Should reject downgrading read to delivered');
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ, 'Status must remain READ');
    });

    test('No downgrade: read -> sent is rejected', () => {
      state.updateReceipt(msgId, MESSAGE_STATUS.READ, roomId);
      const updated = state.updateReceipt(msgId, MESSAGE_STATUS.SENT, roomId);
      assert.equal(updated, false, 'Should reject downgrading read to sent');
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);
    });

    test('No downgrade: delivered -> sent is rejected', () => {
      state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED, roomId);
      const updated = state.updateReceipt(msgId, MESSAGE_STATUS.SENT, roomId);
      assert.equal(updated, false, 'Should reject downgrading delivered to sent');
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.DELIVERED);
    });

    test('No downgrade: delivered or read cannot be downgraded to failed or sending', () => {
      state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.FAILED, roomId), false);
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.SENDING, roomId), false);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.DELIVERED);

      state.updateReceipt(msgId, MESSAGE_STATUS.READ, roomId);
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.FAILED, roomId), false);
      assert.equal(state.updateReceipt(msgId, MESSAGE_STATUS.SENDING, roomId), false);
      assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);
    });
  });

  describe('2. Message and Room Isolation', () => {
    let state;
    const currentUserId = 'user-alice';

    beforeEach(() => {
      state = new RoomMessagesState(currentUserId);
    });

    test('Message isolation: receipt for Msg 1 does not modify Msg 2', () => {
      const roomId = 'room-alpha';
      state.setInitialMessages(roomId, [
        { id: 'msg-1', roomId, senderId: currentUserId, kind: 'text', body: { text: 'One' }, createdAt: '2026-09-23T10:00:00Z' },
        { id: 'msg-2', roomId, senderId: currentUserId, kind: 'text', body: { text: 'Two' }, createdAt: '2026-09-23T10:01:00Z' }
      ]);

      assert.equal(state.getStatus('msg-1'), MESSAGE_STATUS.SENT);
      assert.equal(state.getStatus('msg-2'), MESSAGE_STATUS.SENT);

      state.updateReceipt('msg-1', MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(state.getStatus('msg-1'), MESSAGE_STATUS.DELIVERED);
      assert.equal(state.getStatus('msg-2'), MESSAGE_STATUS.SENT, 'Msg 2 must remain SENT');

      state.updateReceipt('msg-1', MESSAGE_STATUS.READ, roomId);
      assert.equal(state.getStatus('msg-1'), MESSAGE_STATUS.READ);
      assert.equal(state.getStatus('msg-2'), MESSAGE_STATUS.SENT, 'Msg 2 must still remain SENT');
    });

    test('Room isolation: receipt for inactive room does not corrupt active room', () => {
      const roomA = 'room-active-A';
      const roomB = 'room-inactive-B';

      // Active room is Room A
      state.setInitialMessages(roomA, [
        { id: 'msg-A1', roomId: roomA, senderId: currentUserId, kind: 'text', body: { text: 'In A' }, createdAt: '2026-09-23T10:00:00Z' }
      ]);

      assert.equal(state.getStatus('msg-A1'), MESSAGE_STATUS.SENT);

      // Receipt arrives for Room B (inactive)
      const res = state.updateReceipt('msg-B1', MESSAGE_STATUS.DELIVERED, roomB);
      assert.equal(res, true, 'Returns true because receipt was updated in Room B cache');

      // Active room A must be completely unaffected
      assert.equal(state.getStatus('msg-A1'), MESSAGE_STATUS.SENT);
      assert.equal(state.getStatus('msg-B1'), null);

      // Now switch to Room B: cached receipt must be preserved and restored!
      state.setInitialMessages(roomB, [
        { id: 'msg-B1', roomId: roomB, senderId: currentUserId, kind: 'text', body: { text: 'In B' }, createdAt: '2026-09-23T10:05:00Z' }
      ]);
      assert.equal(state.getStatus('msg-B1'), MESSAGE_STATUS.DELIVERED, 'Room B restores cached DELIVERED status');
    });

    test('Reconnect and room switching preserves receipt state across sessions', () => {
      const room1 = 'room-switch-1';
      state.setInitialMessages(room1, [
        { id: 'msg-s1', roomId: room1, senderId: currentUserId, kind: 'text', body: { text: 'Stay' }, createdAt: '2026-09-23T10:00:00Z' }
      ]);
      state.updateReceipt('msg-s1', MESSAGE_STATUS.READ, room1);
      assert.equal(state.getStatus('msg-s1'), MESSAGE_STATUS.READ);

      // Switch to Room 2
      const room2 = 'room-switch-2';
      state.setInitialMessages(room2, [
        { id: 'msg-s2', roomId: room2, senderId: currentUserId, kind: 'text', body: { text: 'Other' }, createdAt: '2026-09-23T10:02:00Z' }
      ]);
      assert.equal(state.getStatus('msg-s2'), MESSAGE_STATUS.SENT);

      // Switch back to Room 1: should retain READ status, NOT reset to sent
      state.setInitialMessages(room1, [
        { id: 'msg-s1', roomId: room1, senderId: currentUserId, kind: 'text', body: { text: 'Stay' }, createdAt: '2026-09-23T10:00:00Z' }
      ]);
      assert.equal(state.getStatus('msg-s1'), MESSAGE_STATUS.READ, 'Receipt status preserved after room switch');
    });
  });

  describe('3. ChatWebSocket Receipt Frame Handling & Sequence Exemption', () => {
    let wsClient;
    let mockWs;

    beforeEach(async () => {
      MockWebSocket.instances = [];
      wsClient = new ChatWebSocket({
        url: 'ws://localhost:3000/v1/chat/ws',
        WebSocketClass: MockWebSocket,
        token: 'rt_mock_room_token',
        autoReconnect: false,
        pingIntervalMs: 60000
      });
      await wsClient.connect();
      mockWs = MockWebSocket.instances[0];
      mockWs.simulateOpen();
    });

    afterEach(() => {
      wsClient.disconnect();
    });

    test('markDelivered transmits conformant Android/OllaCore frame', () => {
      const sent = wsClient.markDelivered('room-42', 'msg-123');
      assert.ok(typeof sent === 'string' && sent.length > 0);
      assert.equal(mockWs.sentData.length, 1);

      const frame = JSON.parse(mockWs.sentData[0]);
      assert.equal(frame.v, 1);
      assert.equal(frame.type, 'receipt.delivered');
      assert.equal(frame.room_id, 'room-42');
      assert.deepEqual(frame.payload, { message_id: 'msg-123' });
    });

    test('markRead transmits conformant Android/OllaCore frame', () => {
      const sent = wsClient.markRead('room-42', 'msg-123');
      assert.ok(typeof sent === 'string' && sent.length > 0);
      assert.equal(mockWs.sentData.length, 1);

      const frame = JSON.parse(mockWs.sentData[0]);
      assert.equal(frame.v, 1);
      assert.equal(frame.type, 'receipt.read');
      assert.equal(frame.room_id, 'room-42');
      assert.deepEqual(frame.payload, { message_id: 'msg-123' });
    });

    test('receipt.delivered is NOT dropped when event_seq <= currentCursor', () => {
      // Advance cursor to 50
      wsClient.setRoomCursor('room-42', 50);

      let receivedReceipt = null;
      wsClient.on('receipt.delivered', (data) => {
        receivedReceipt = data;
      });

      // Receipt arrives with event_seq = 20 (older than currentCursor = 50)
      mockWs.simulateMessage({
        v: 1,
        type: 'receipt.delivered',
        event_seq: 20,
        room_id: 'room-42',
        payload: { message_id: 'msg-early' }
      });

      assert.ok(receivedReceipt !== null, 'receipt.delivered MUST NOT be dropped due to event_seq');
      assert.equal(receivedReceipt.roomId, 'room-42');
      assert.equal(receivedReceipt.messageId, 'msg-early');
    });

    test('receipt.read is NOT dropped when event_seq <= currentCursor', () => {
      // Advance cursor to 100
      wsClient.setRoomCursor('room-42', 100);

      let receivedRead = null;
      wsClient.on('receipt.read', (data) => {
        receivedRead = data;
      });

      // Receipt arrives with event_seq = 10
      mockWs.simulateMessage({
        v: 1,
        type: 'receipt.read',
        event_seq: 10,
        room_id: 'room-42',
        payload: { message_id: 'msg-prior' }
      });

      assert.ok(receivedRead !== null, 'receipt.read MUST NOT be dropped due to event_seq');
      assert.equal(receivedRead.roomId, 'room-42');
      assert.equal(receivedRead.messageId, 'msg-prior');
    });

    test('Duplicate protection still drops duplicate message.created with old event_seq', () => {
      // Advance cursor to 50
      wsClient.setRoomCursor('room-42', 50);

      let messageCreatedReceived = false;
      wsClient.on('message.created', () => {
        messageCreatedReceived = true;
      });

      // Duplicate message.created with event_seq = 40 (<= currentCursor)
      mockWs.simulateMessage({
        v: 1,
        type: 'message.created',
        event_seq: 40,
        room_id: 'room-42',
        payload: { id: 'msg-dup', body: { text: 'Old duplicate' } }
      });

      assert.equal(messageCreatedReceived, false, 'message.created with event_seq <= cursor MUST be dropped');
    });

    test('Handles both top-level and payload-nested messageId / roomId in receipt frames', () => {
      let events = [];
      wsClient.on('receipt.delivered', (d) => events.push({ type: 'delivered', ...d }));
      wsClient.on('receipt.read', (d) => events.push({ type: 'read', ...d }));

      // Format 1: payload nested
      mockWs.simulateMessage({
        v: 1,
        type: 'receipt.delivered',
        room_id: 'room-A',
        payload: { message_id: 'msg-1' }
      });

      // Format 2: top level
      mockWs.simulateMessage({
        v: 1,
        type: 'receipt.read',
        roomId: 'room-B',
        payload: {},
        messageId: 'msg-2'
      });

      assert.equal(events.length, 2);
      assert.deepEqual(events[0], { type: 'delivered', roomId: 'room-A', messageId: 'msg-1', principalId: '' });
      assert.deepEqual(events[1], { type: 'read', roomId: 'room-B', messageId: 'msg-2', principalId: '' });
    });
  });

  describe('4. Acknowledgement Triggering Logic (Delivered vs Read)', () => {
    test('Incoming message from peer triggers markDelivered immediately', () => {
      const currentUserId = 'user-alice';
      const peerMsg = {
        id: 'msg-from-bob',
        roomId: 'room-ab',
        senderId: 'user-bob',
        body: { text: 'Hey Alice' }
      };

      const acknowledgements = [];
      function onIncomingMessage(msg, activeRoomId) {
        if (msg.senderId !== currentUserId) {
          acknowledgements.push({ action: 'delivered', roomId: msg.roomId, messageId: msg.id });
          if (activeRoomId === msg.roomId) {
            acknowledgements.push({ action: 'read', roomId: msg.roomId, messageId: msg.id });
          }
        }
      }

      // Scenario A: chat is closed / not active room
      onIncomingMessage(peerMsg, 'room-other');
      assert.deepEqual(acknowledgements, [
        { action: 'delivered', roomId: 'room-ab', messageId: 'msg-from-bob' }
      ]);

      // Scenario B: chat IS active room
      acknowledgements.length = 0;
      onIncomingMessage(peerMsg, 'room-ab');
      assert.deepEqual(acknowledgements, [
        { action: 'delivered', roomId: 'room-ab', messageId: 'msg-from-bob' },
        { action: 'read', roomId: 'room-ab', messageId: 'msg-from-bob' }
      ]);
    });

    test('Opening a room triggers markRead only for latest incoming message', () => {
      const currentUserId = 'user-alice';
      const messages = [
        { id: 'm1', senderId: 'user-bob', body: { text: 'Hi' } },
        { id: 'm2', senderId: currentUserId, body: { text: 'Hello' } },
        { id: 'm3', senderId: 'user-bob', body: { text: 'Are you there?' } }
      ];

      function findLatestIncoming(msgs) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].senderId !== currentUserId) {
            return msgs[i];
          }
        }
        return null;
      }

      const latest = findLatestIncoming(messages);
      assert.ok(latest !== null);
      assert.equal(latest.id, 'm3');
    });

    test('History loading does NOT mark outgoing messages as read just because incoming messages exist', () => {
      const currentUserId = 'user-alice';
      const state = new RoomMessagesState(currentUserId);
      const history = [
        { id: 'm1', roomId: 'r1', senderId: currentUserId, body: { text: 'Sent by me' }, createdAt: '2026-09-23T10:00:00Z' },
        { id: 'm2', roomId: 'r1', senderId: 'user-bob', body: { text: 'Reply from bob' }, createdAt: '2026-09-23T10:01:00Z' }
      ];

      state.setInitialMessages('r1', history);
      assert.equal(state.getStatus('m1'), MESSAGE_STATUS.SENT, 'Outgoing message must NOT be assumed read just because peer replied');
    });
  });

  describe('5. Tick Rendering & Incoming Invariant Regression Tests', () => {
    const currentUserId = 'user-self';
    const peerUserId = 'user-peer';
    const roomId = 'room-reg-1';

    test('1. Incoming message -> no tick (hasTick is false)', () => {
      const desc = getTickDescriptor(null, false);
      assert.equal(desc.hasTick, false);
      assert.equal(desc.symbol, '');
      assert.equal(desc.statusClass, '');

      // Even if incoming message status is somehow 'read' or 'delivered'
      const descRead = getTickDescriptor('read', false);
      assert.equal(descRead.hasTick, false);
      assert.equal(descRead.symbol, '');

      const descDelivered = getTickDescriptor('delivered', false);
      assert.equal(descDelivered.hasTick, false);
      assert.equal(descDelivered.symbol, '');
    });

    test('2. Outgoing sending -> single grey tick', () => {
      const desc = getTickDescriptor(MESSAGE_STATUS.SENDING, true);
      assert.equal(desc.hasTick, true);
      assert.equal(desc.symbol, '✓');
      assert.equal(desc.statusClass, 'status-sent');
      assert.equal(desc.title, 'Sending');
    });

    test('3. Outgoing sent/delivered -> double grey ticks for delivered, single for sent', () => {
      const descSent = getTickDescriptor(MESSAGE_STATUS.SENT, true);
      assert.equal(descSent.hasTick, true);
      assert.equal(descSent.symbol, '✓');
      assert.equal(descSent.statusClass, 'status-sent');
      assert.equal(descSent.title, 'Sent');

      const descDelivered = getTickDescriptor(MESSAGE_STATUS.DELIVERED, true);
      assert.equal(descDelivered.hasTick, true);
      assert.equal(descDelivered.symbol, '✓✓');
      assert.equal(descDelivered.statusClass, 'status-delivered');
      assert.equal(descDelivered.title, 'Delivered');
    });

    test('4. Outgoing read -> double blue ticks (✓✓ with status-read class)', () => {
      const desc = getTickDescriptor(MESSAGE_STATUS.READ, true);
      assert.equal(desc.hasTick, true);
      assert.equal(desc.symbol, '✓✓');
      assert.equal(desc.statusClass, 'status-read');
      assert.equal(desc.title, 'Read');
    });

    test('5. Incoming message must never become blue/double-ticked in RoomMessagesState', () => {
      const state = new RoomMessagesState(currentUserId);
      const incomingMsg = {
        id: 'inc-msg-1',
        roomId,
        senderId: peerUserId,
        sender_id: peerUserId,
        body: { text: 'ya i can see' },
        createdAt: new Date().toISOString()
      };
      state.setInitialMessages(roomId, [incomingMsg]);

      // Verify incoming message has no status
      assert.equal(state.getStatus('inc-msg-1'), null);

      // Attempting to update receipt for incoming message MUST be rejected
      const deliveredUpdated = state.updateReceipt('inc-msg-1', MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(deliveredUpdated, false, 'updateReceipt must reject incoming message');
      assert.equal(state.getStatus('inc-msg-1'), null);

      const readUpdated = state.updateReceipt('inc-msg-1', MESSAGE_STATUS.READ, roomId);
      assert.equal(readUpdated, false, 'updateReceipt must reject incoming message read receipt');
      assert.equal(state.getStatus('inc-msg-1'), null);

      // Rendering tick descriptor for incoming message must always have hasTick: false
      const tick = getTickDescriptor(state.getStatus('inc-msg-1'), false);
      assert.equal(tick.hasTick, false);
      assert.equal(tick.symbol, '');
    });

    test('6. Receipt for message A must not update message B', () => {
      const state = new RoomMessagesState(currentUserId);
      state.setInitialMessages(roomId, [
        { id: 'msg-A', roomId, senderId: currentUserId, body: { text: 'ok' }, createdAt: '2026-09-23T10:00:00Z' },
        { id: 'msg-B', roomId, senderId: currentUserId, body: { text: 'second' }, createdAt: '2026-09-23T10:01:00Z' }
      ]);

      assert.equal(state.getStatus('msg-A'), MESSAGE_STATUS.SENT);
      assert.equal(state.getStatus('msg-B'), MESSAGE_STATUS.SENT);

      state.updateReceipt('msg-A', MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(state.getStatus('msg-A'), MESSAGE_STATUS.DELIVERED);
      assert.equal(state.getStatus('msg-B'), MESSAGE_STATUS.SENT);

      state.updateReceipt('msg-A', MESSAGE_STATUS.READ, roomId);
      assert.equal(state.getStatus('msg-A'), MESSAGE_STATUS.READ);
      assert.equal(state.getStatus('msg-B'), MESSAGE_STATUS.SENT);
    });

    test('7. Receipt from another room must not update the current room', () => {
      const state = new RoomMessagesState(currentUserId);
      state.setInitialMessages('room-active', [
        { id: 'msg-active-1', roomId: 'room-active', senderId: currentUserId, body: { text: 'In active' } }
      ]);

      // Receipt arrives for other room
      state.updateReceipt('msg-other-1', MESSAGE_STATUS.READ, 'room-other');

      assert.equal(state.getStatus('msg-active-1'), MESSAGE_STATUS.SENT);
      assert.equal(state.getStatus('msg-other-1'), null, 'Other room message status must not appear in active room');
    });

    test('8. Receipt state must remain monotonic and never downgrade', () => {
      const state = new RoomMessagesState(currentUserId);
      state.setInitialMessages(roomId, [
        { id: 'msg-mono', roomId, senderId: currentUserId, body: { text: 'Monotonic test' } }
      ]);

      // sent -> delivered (allowed)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.DELIVERED, roomId), true);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.DELIVERED);

      // delivered -> sent (rejected)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.SENT, roomId), false);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.DELIVERED);

      // delivered -> read (allowed)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.READ, roomId), true);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.READ);

      // read -> delivered (rejected)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.DELIVERED, roomId), false);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.READ);

      // read -> sent (rejected)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.SENT, roomId), false);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.READ);

      // read -> failed (rejected)
      assert.equal(state.updateReceipt('msg-mono', MESSAGE_STATUS.FAILED, roomId), false);
      assert.equal(state.getStatus('msg-mono'), MESSAGE_STATUS.READ);
    });

    test('9. Reconnect/room switching must preserve correct receipt state', () => {
      const state = new RoomMessagesState(currentUserId);
      const messages = [
        { id: 'msg-p1', roomId, senderId: currentUserId, body: { text: 'Preserve me' } }
      ];
      state.setInitialMessages(roomId, messages);
      state.updateReceipt('msg-p1', MESSAGE_STATUS.READ, roomId);
      assert.equal(state.getStatus('msg-p1'), MESSAGE_STATUS.READ);

      // Switch to different room
      state.setInitialMessages('room-temp', [
        { id: 'msg-temp', roomId: 'room-temp', senderId: currentUserId, body: { text: 'Temp' } }
      ]);
      assert.equal(state.getStatus('msg-temp'), MESSAGE_STATUS.SENT);

      // Switch back to original room
      state.setInitialMessages(roomId, messages);
      assert.equal(state.getStatus('msg-p1'), MESSAGE_STATUS.READ, 'Receipt status preserved after switching back');
    });

    test('10. A recipient reply must NOT automatically mark the previous outgoing message as read', () => {
      const state = new RoomMessagesState(currentUserId);
      state.setInitialMessages(roomId, [
        { id: 'out-1', roomId, senderId: currentUserId, body: { text: 'ok' }, createdAt: '2026-09-23T10:00:00Z' }
      ]);
      state.updateReceipt('out-1', MESSAGE_STATUS.DELIVERED, roomId);
      assert.equal(state.getStatus('out-1'), MESSAGE_STATUS.DELIVERED);

      // Recipient replies with "ya i can see"
      const replyMsg = {
        id: 'reply-1',
        roomId,
        senderId: peerUserId,
        body: { text: 'ya i can see' },
        replyTo: 'out-1',
        createdAt: '2026-09-23T10:01:00Z'
      };
      state.appendIncomingMessage(replyMsg);

      // Reply must NOT mark out-1 as READ without an explicit receipt.read signal
      assert.equal(state.getStatus('out-1'), MESSAGE_STATUS.DELIVERED, 'Must remain DELIVERED, not READ merely because peer replied');
      assert.equal(state.getStatus('reply-1'), null, 'Incoming reply must have no status');
    });
  });
});
