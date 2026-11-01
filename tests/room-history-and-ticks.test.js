import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  createOptimisticMessage,
  getTickDescriptor,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';

describe('Room History & Receipt Consistency Regression Tests', () => {
  const userA = 'user-alice';
  const userB = 'user-bob';
  const roomA = 'room-alpha';
  const roomB = 'room-beta';

  let sharedReceiptStore;
  let roomMessagesMap;

  function getOrCreateState(roomId, userId = userA) {
    if (!roomMessagesMap.has(roomId)) {
      const s = new RoomMessagesState(userId, sharedReceiptStore);
      s.roomId = roomId;
      roomMessagesMap.set(roomId, s);
    }
    return roomMessagesMap.get(roomId);
  }

  beforeEach(() => {
    sharedReceiptStore = new Map();
    roomMessagesMap = new Map();
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Load room with 4 messages -> switch room -> return -> all 4 remain
  // ─────────────────────────────────────────────────────────────
  test('1. Load room with 4 messages -> switch room -> return -> all 4 remain', () => {
    const stateA = getOrCreateState(roomA);
    const initialMsgs = [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'Msg 1' }, createdAt: '2026-09-23T10:00:00Z' },
      { id: 'm2', roomId: roomA, senderId: userA, eventSeq: 2, body: { text: 'Msg 2' }, createdAt: '2026-09-23T10:01:00Z' },
      { id: 'm3', roomId: roomA, senderId: userB, eventSeq: 3, body: { text: 'Msg 3' }, createdAt: '2026-09-23T10:02:00Z' },
      { id: 'm4', roomId: roomA, senderId: userA, eventSeq: 4, body: { text: 'Msg 4' }, createdAt: '2026-09-23T10:03:00Z' }
    ];
    stateA.setInitialMessages(roomA, initialMsgs);
    assert.equal(stateA.messages.length, 4);

    // Switch to room B
    const stateB = getOrCreateState(roomB);
    stateB.setInitialMessages(roomB, [
      { id: 'mb1', roomId: roomB, senderId: userB, eventSeq: 1, body: { text: 'Hello B' } }
    ]);
    assert.equal(stateB.messages.length, 1);

    // Return to room A
    const returnedA = getOrCreateState(roomA);
    assert.equal(returnedA.messages.length, 4, 'All 4 messages must remain in Room A state');
    assert.deepEqual(returnedA.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Send multiple messages -> switch room -> return -> all messages remain
  // ─────────────────────────────────────────────────────────────
  test('2. Send multiple messages -> switch room -> return -> all messages remain', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, []);

    // Send 4 optimistic messages in Room A
    for (let i = 1; i <= 4; i++) {
      const opt = createOptimisticMessage(roomA, userA, `Message ${i}`, `local-a-${i}`);
      stateA.addOptimisticMessage(opt);
    }
    assert.equal(stateA.messages.length, 4);

    // Switch to Room B
    const stateB = getOrCreateState(roomB);
    const optB = createOptimisticMessage(roomB, userA, 'Message in B', 'local-b-1');
    stateB.addOptimisticMessage(optB);
    assert.equal(stateB.messages.length, 1);

    // Return to Room A
    const returnedA = getOrCreateState(roomA);
    assert.equal(returnedA.messages.length, 4, 'All 4 sent messages must survive room switch');
    assert.equal(returnedA.messages[3].body.text, 'Message 4');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Latest sidebar preview must not be used as room history
  // ─────────────────────────────────────────────────────────────
  test('3. Latest sidebar preview must not be used as room history', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'Old message' } }
    ]);

    // Sidebar conversation preview contains latest message from inbox
    const sidebarConversation = {
      roomId: roomA,
      lastMessage: {
        preview: 'Newest message preview from inbox',
        senderId: userB,
        eventSeq: 50
      }
    };

    // The room state must retain its actual message collection, not be replaced by sidebar preview
    assert.equal(stateA.messages.length, 1);
    assert.equal(stateA.messages[0].body.text, 'Old message');
    assert.notEqual(stateA.messages[0].body.text, sidebarConversation.lastMessage.preview);
  });

  // ─────────────────────────────────────────────────────────────
  // 4. History reload must restore all server messages
  // ─────────────────────────────────────────────────────────────
  test('4. History reload must restore all server messages with mergeServerMessages', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'First' } }
    ]);

    // Reload from server with 3 messages
    const serverHistory = [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'First' } },
      { id: 'm2', roomId: roomA, senderId: userB, eventSeq: 2, body: { text: 'Second' } },
      { id: 'm3', roomId: roomA, senderId: userA, eventSeq: 3, body: { text: 'Third' } }
    ];
    stateA.mergeServerMessages(serverHistory);

    assert.equal(stateA.messages.length, 3);
    assert.equal(stateA.oldestSeq, 1);
    assert.equal(stateA.newestSeq, 3);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Optimistic message reconciled with server ID remains visible after room switch
  // ─────────────────────────────────────────────────────────────
  test('5. Optimistic message reconciled with server ID remains visible after room switch', () => {
    const stateA = getOrCreateState(roomA);
    const cid = 'local-reconcile-switch';
    const opt = createOptimisticMessage(roomA, userA, 'Optimistic to reconcile', cid);
    stateA.addOptimisticMessage(opt);

    // Switch to Room B
    getOrCreateState(roomB);

    // Server returns canonical message.created for Room A while Room B is active
    const canonicalServerMsg = {
      id: 'srv-canonical-999',
      roomId: roomA,
      senderId: userA,
      clientMessageId: cid,
      eventSeq: 15,
      body: { text: 'Optimistic to reconcile' },
      createdAt: '2026-09-23T11:00:00Z'
    };

    // Route event directly to Room A's state in map
    stateA.appendIncomingMessage(canonicalServerMsg);
    stateA.updateReceipt(canonicalServerMsg.id, 'sent', roomA);

    // Return to Room A
    const returnedA = getOrCreateState(roomA);
    assert.equal(returnedA.messages.length, 1);
    assert.equal(returnedA.messages[0].id, 'srv-canonical-999');
    assert.equal(returnedA.messages[0].clientMessageId, cid);
    assert.equal(returnedA.getStatus('srv-canonical-999'), 'sent');
    assert.equal(returnedA.getStatus(cid), 'sent');
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Receipt status survives room switch
  // ─────────────────────────────────────────────────────────────
  test('6. Receipt status survives room switch', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'Sent by me' } }
    ]);
    stateA.updateReceipt('m1', 'delivered', roomA);
    assert.equal(stateA.getStatus('m1'), 'delivered');

    // Switch to Room B
    const stateB = getOrCreateState(roomB);
    stateB.setInitialMessages(roomB, []);

    // Return to Room A
    const returnedA = getOrCreateState(roomA);
    assert.equal(returnedA.getStatus('m1'), 'delivered', 'Delivered receipt must survive room switch');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Read status survives room switch
  // ─────────────────────────────────────────────────────────────
  test('7. Read status survives room switch and cannot revert to sent/delivered', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm-read-1', roomId: roomA, senderId: userA, eventSeq: 10, body: { text: 'Important read' } }
    ]);
    stateA.updateReceipt('m-read-1', 'read', roomA);
    assert.equal(stateA.getStatus('m-read-1'), 'read');

    // Switch away and back
    getOrCreateState(roomB);
    const returnedA = getOrCreateState(roomA);
    assert.equal(returnedA.getStatus('m-read-1'), 'read');

    // Attempt invalid downgrade from a stale event
    const downgraded = returnedA.updateReceipt('m-read-1', 'delivered', roomA);
    assert.equal(downgraded, false, 'Read cannot be downgraded to delivered');
    assert.equal(returnedA.getStatus('m-read-1'), 'read');
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Delivered status survives room switch
  // ─────────────────────────────────────────────────────────────
  test('8. Delivered status survives room switch and history reload', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm-deliv-1', roomId: roomA, senderId: userA, eventSeq: 5, body: { text: 'Delivered msg' } }
    ]);
    stateA.updateReceipt('m-deliv-1', 'delivered', roomA);
    assert.equal(stateA.getStatus('m-deliv-1'), 'delivered');

    // Switch to Room B
    getOrCreateState(roomB);

    // Switch back to Room A and simulate history re-fetch
    const returnedA = getOrCreateState(roomA);
    returnedA.mergeServerMessages([
      { id: 'm-deliv-1', roomId: roomA, senderId: userA, eventSeq: 5, body: { text: 'Delivered msg' } }
    ]);
    assert.equal(returnedA.getStatus('m-deliv-1'), 'delivered', 'Must remain delivered after history reload');
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Message A receipt does not affect Message B
  // ─────────────────────────────────────────────────────────────
  test('9. Message A receipt does not affect Message B', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'mA', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'Msg A' } },
      { id: 'mB', roomId: roomA, senderId: userA, eventSeq: 2, body: { text: 'Msg B' } }
    ]);

    stateA.updateReceipt('mA', 'read', roomA);
    assert.equal(stateA.getStatus('mA'), 'read');
    assert.equal(stateA.getStatus('mB'), 'sent', 'Receipt on mA must NOT change mB');

    stateA.updateReceipt('mB', 'delivered', roomA);
    assert.equal(stateA.getStatus('mA'), 'read');
    assert.equal(stateA.getStatus('mB'), 'delivered');
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Messages from another room never appear in active room
  // ─────────────────────────────────────────────────────────────
  test('10. Messages from another room never appear in active room', () => {
    const stateA = getOrCreateState(roomA);
    const stateB = getOrCreateState(roomB);

    stateA.setInitialMessages(roomA, [
      { id: 'msg-roomA', roomId: roomA, senderId: userA, body: { text: 'A text' } }
    ]);
    stateB.setInitialMessages(roomB, [
      { id: 'msg-roomB', roomId: roomB, senderId: userB, body: { text: 'B text' } }
    ]);

    assert.equal(stateA.hasMessage('msg-roomA'), true);
    assert.equal(stateA.hasMessage('msg-roomB'), false);
    assert.equal(stateB.hasMessage('msg-roomB'), true);
    assert.equal(stateB.hasMessage('msg-roomA'), false);
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Reconnect does not erase room history
  // ─────────────────────────────────────────────────────────────
  test('11. Reconnect does not erase room history', () => {
    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 10, body: { text: 'Persistent 1' } },
      { id: 'm2', roomId: roomA, senderId: userA, eventSeq: 11, body: { text: 'Persistent 2' } }
    ]);

    // WebSocket reconnect triggers resync / catchup without calling reset()
    // Simulated catchup with afterSeq = 11:
    const newMsgs = [
      { id: 'm3', roomId: roomA, senderId: userB, eventSeq: 12, body: { text: 'New after reconnect' } }
    ];
    stateA.mergeServerMessages(newMsgs);

    assert.equal(stateA.messages.length, 3);
    assert.deepEqual(stateA.messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  });

  // ─────────────────────────────────────────────────────────────
  // 12. Pagination/cursor logic does not discard older messages
  // ─────────────────────────────────────────────────────────────
  test('12. Pagination/cursor logic does not discard older messages', () => {
    const stateA = getOrCreateState(roomA);

    // Initial batch: latest messages (seqs 3-4)
    stateA.setInitialMessages(roomA, [
      { id: 'm3', roomId: roomA, senderId: userA, eventSeq: 3, body: { text: 'Three' } },
      { id: 'm4', roomId: roomA, senderId: userB, eventSeq: 4, body: { text: 'Four' } }
    ], true);

    assert.equal(stateA.oldestSeq, 3);
    assert.equal(stateA.newestSeq, 4);

    // User scrolls up: load older messages before seq 3 (seqs 1-2)
    const olderMsgs = [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'One' } },
      { id: 'm2', roomId: roomA, senderId: userB, eventSeq: 2, body: { text: 'Two' } }
    ];
    stateA.prependOlderMessages(olderMsgs, false);

    assert.equal(stateA.messages.length, 4);
    assert.deepEqual(stateA.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(stateA.oldestSeq, 1);
    assert.equal(stateA.newestSeq, 4);
    assert.equal(stateA.hasMore, false);
  });

  // ─────────────────────────────────────────────────────────────
  // 13. Closing/reopening conversation preserves full message history
  // ─────────────────────────────────────────────────────────────
  test('13. Closing/reopening conversation preserves full message history', () => {
    const stateA = getOrCreateState(roomA);
    const msgs = [
      { id: 'm1', roomId: roomA, senderId: userA, eventSeq: 1, body: { text: 'M1' } },
      { id: 'm2', roomId: roomA, senderId: userA, eventSeq: 2, body: { text: 'M2' } },
      { id: 'm3', roomId: roomA, senderId: userA, eventSeq: 3, body: { text: 'M3' } },
      { id: 'm4', roomId: roomA, senderId: userA, eventSeq: 4, body: { text: 'M4' } }
    ];
    stateA.setInitialMessages(roomA, msgs);

    // Closing conversation: selection becomes null (DOM cleared, but roomMessagesMap preserved)
    let selectedRoom = null;
    assert.equal(selectedRoom, null);

    // Reopening conversation A
    selectedRoom = roomA;
    const reopenedA = getOrCreateState(selectedRoom);
    assert.equal(reopenedA.messages.length, 4, 'Reopening must restore all 4 messages immediately');
  });

  // ─────────────────────────────────────────────────────────────
  // 14. Room with >50 messages: initial load displays newest messages
  // ─────────────────────────────────────────────────────────────
  test('14. Room with >50 messages: initial load displays newest messages, not oldest 50', () => {
    // Generate 65 historical messages (seq 1 to 65)
    const all65Messages = [];
    for (let i = 1; i <= 65; i++) {
      all65Messages.push({
        id: `msg-${i}`,
        roomId: roomA,
        senderId: userA,
        eventSeq: i,
        body: { text: `Message sequence ${i}` },
        createdAt: new Date(1700000000000 + i * 60000).toISOString()
      });
    }

    // Backend query simulation with before_seq = 2147483647 and limit = 50:
    // Takes the 50 newest messages (seqs 16 to 65) sorted ascending
    const beforeSeq = 2147483647;
    const limit = 50;
    const fetchedLatest50 = all65Messages
      .filter((m) => m.eventSeq < beforeSeq)
      .slice(-limit);

    assert.equal(fetchedLatest50.length, 50);
    assert.equal(fetchedLatest50[0].eventSeq, 16, 'Oldest in page is seq 16');
    assert.equal(fetchedLatest50[49].eventSeq, 65, 'Newest in page is seq 65');

    const stateA = getOrCreateState(roomA);
    stateA.setInitialMessages(roomA, fetchedLatest50, true);

    assert.equal(stateA.messages.length, 50);
    assert.equal(stateA.newestSeq, 65, 'Latest message must be seq 65');
    assert.equal(stateA.oldestSeq, 16);
    assert.equal(stateA.hasMore, true);
    assert.equal(stateA.messages.some((m) => m.eventSeq === 65), true, 'Most recent message must be visible');
    assert.equal(stateA.messages.some((m) => m.eventSeq === 1), false, 'Oldest message seq 1 was paginated out');
  });

  // ─────────────────────────────────────────────────────────────
  // 15. Incoming messages never render ticks
  // ─────────────────────────────────────────────────────────────
  test('15. Incoming messages never render ticks under any status', () => {
    const statuses = [null, undefined, 'sending', 'sent', 'delivered', 'read', 'failed'];
    for (const st of statuses) {
      const desc = getTickDescriptor(st, false); // isOwn = false
      assert.equal(desc.hasTick, false, `Incoming with status ${st} must not have tick`);
      assert.equal(desc.symbol, '');
      assert.equal(desc.statusClass, '');
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 16. Exact live bug sequence from specification requirement 12
  // ─────────────────────────────────────────────────────────────
  test('16. Exact Live Bug: 4+ sent in Room A -> switch to Room B -> return A -> all exist -> send/receive while unselected -> return A -> background msg/ACK present with correct receipts', () => {
    // 1. Send 4+ messages in Room A
    const stateA = getOrCreateState(roomA, userA);
    stateA.setInitialMessages(roomA, []);

    const sentA = [];
    for (let i = 1; i <= 4; i++) {
      const cid = `opt-live-${i}`;
      const opt = createOptimisticMessage(roomA, userA, `Live message ${i}`, cid);
      stateA.addOptimisticMessage(opt);
      sentA.push({ cid, text: `Live message ${i}` });
    }
    assert.equal(stateA.messages.length, 4);

    // Server ACKs all 4 messages
    for (let i = 0; i < 4; i++) {
      const srvId = `srv-a-${i + 1}`;
      stateA.appendIncomingMessage({
        id: srvId,
        roomId: roomA,
        senderId: userA,
        clientMessageId: sentA[i].cid,
        eventSeq: i + 1,
        body: { text: sentA[i].text }
      });
      stateA.updateReceipt(srvId, 'sent', roomA);
    }
    // Update m1 to delivered, m2 to read
    stateA.updateReceipt('srv-a-1', 'delivered', roomA);
    stateA.updateReceipt('srv-a-2', 'read', roomA);

    assert.equal(stateA.getStatus('srv-a-1'), 'delivered');
    assert.equal(stateA.getStatus('srv-a-2'), 'read');
    assert.equal(stateA.getStatus('srv-a-3'), 'sent');
    assert.equal(stateA.getStatus('srv-a-4'), 'sent');

    // 2. Switch to Room B
    let activeRoomId = roomB;
    const stateB = getOrCreateState(roomB, userA);
    stateB.setInitialMessages(roomB, [
      { id: 'mb-1', roomId: roomB, senderId: userB, eventSeq: 1, body: { text: 'Room B greeting' } }
    ]);
    assert.equal(stateB.messages.length, 1);

    // 3. Return to Room A
    activeRoomId = roomA;
    const activeStateA = getOrCreateState(activeRoomId, userA);
    // 4. All 4+ messages must still exist!
    assert.equal(activeStateA.messages.length, 4, 'All 4 messages in Room A must still exist');
    assert.equal(activeStateA.getStatus('srv-a-1'), 'delivered');
    assert.equal(activeStateA.getStatus('srv-a-2'), 'read');
    assert.equal(activeStateA.getStatus('srv-a-3'), 'sent');
    assert.equal(activeStateA.getStatus('srv-a-4'), 'sent');

    // 5. Switch away from Room A to Room B again
    activeRoomId = roomB;

    // Send another message (message 5) in Room A while Room A is NOT selected:
    // (e.g. background outgoing queued or incoming from peer in Room A)
    const targetA = getOrCreateState(roomA, userA);
    const bgMsgCid = 'opt-live-bg-5';
    const opt5 = createOptimisticMessage(roomA, userA, 'Background message 5', bgMsgCid);
    targetA.addOptimisticMessage(opt5);

    // Background ACK arrives for Room A while Room B is still active
    targetA.appendIncomingMessage({
      id: 'srv-a-5',
      roomId: roomA,
      senderId: userA,
      clientMessageId: bgMsgCid,
      eventSeq: 5,
      body: { text: 'Background message 5' }
    });
    targetA.updateReceipt('srv-a-5', 'sent', roomA);

    // Also a delivered receipt arrives for message 3 while Room A is not selected
    targetA.updateReceipt('srv-a-3', 'delivered', roomA);

    // Also an incoming peer message arrives in Room A while Room A is not selected
    targetA.appendIncomingMessage({
      id: 'srv-a-6-peer',
      roomId: roomA,
      senderId: userB,
      eventSeq: 6,
      body: { text: 'Peer message while unselected' }
    });

    // Active room is still Room B
    assert.equal(activeRoomId, roomB);
    assert.equal(getOrCreateState(roomB).messages.length, 1);

    // 6. Return to Room A
    activeRoomId = roomA;
    const returnedStateA = getOrCreateState(activeRoomId, userA);

    // 7. All messages including background message/ACK and peer message must be present
    assert.equal(returnedStateA.messages.length, 6, 'All 6 messages must be present in Room A');
    assert.equal(returnedStateA.messages[4].id, 'srv-a-5');
    assert.equal(returnedStateA.messages[4].body.text, 'Background message 5');
    assert.equal(returnedStateA.messages[5].id, 'srv-a-6-peer');

    // 8. Receipt states must remain strictly correct
    assert.equal(returnedStateA.getStatus('srv-a-1'), 'delivered');
    assert.equal(returnedStateA.getStatus('srv-a-2'), 'read');
    assert.equal(returnedStateA.getStatus('srv-a-3'), 'delivered');
    assert.equal(returnedStateA.getStatus('srv-a-4'), 'sent');
    assert.equal(returnedStateA.getStatus('srv-a-5'), 'sent');

    // Invariant: incoming peer message never has ticks
    const peerTick = getTickDescriptor(returnedStateA.getStatus('srv-a-6-peer'), false);
    assert.equal(peerTick.hasTick, false);

    // Outgoing messages have correct tick descriptors
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-2'), true).symbol, '✓✓');
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-2'), true).statusClass, 'status-read');
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-3'), true).symbol, '✓✓');
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-3'), true).statusClass, 'status-delivered');
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-4'), true).symbol, '✓');
    assert.equal(getTickDescriptor(returnedStateA.getStatus('srv-a-4'), true).statusClass, 'status-sent');
  });
});

describe('Recipient-Side Message Ownership & Sender Identity Regression Tests (10 Requirements)', () => {
  const accountAId = '23c7f84b-6998-4fc5-b91a-57158c6d6551';
  const accountBId = 'a8f85b84-4bfa-4edc-aff9-fca087d7c047';
  const directRoomId = '2e71010f-2d19-4d42-8171-a00b10272850';
  const otherRoomId = 'f74c810d-9999-4d42-8171-a00b10272899';

  function renderBubbleSimulation(message, currentUserId, state) {
    const isOwn = isOwnMessage(message, currentUserId);
    const rowClass = `message-row ${isOwn ? 'outgoing' : 'incoming'}`;
    let hasTick = false;
    let tickSymbol = null;
    let statusClass = null;
    if (isOwn) {
      const status = state.getStatus(message.id)
        || (message.clientMessageId ? state.getStatus(message.clientMessageId) : null)
        || (message.client_message_id ? state.getStatus(message.client_message_id) : null)
        || 'sent';
      const tickDesc = getTickDescriptor(status, true);
      hasTick = tickDesc.hasTick;
      tickSymbol = tickDesc.symbol;
      statusClass = tickDesc.statusClass;
    }
    return { isOwn, rowClass, hasTick, tickSymbol, statusClass };
  }

  // ─────────────────────────────────────────────────────────────
  // 1. A sends to B -> A renders outgoing
  // ─────────────────────────────────────────────────────────────
  test('1. A sends to B -> A renders outgoing (message-row outgoing, has ticks)', () => {
    const stateA = new RoomMessagesState(accountAId);
    stateA.roomId = directRoomId;

    const optA = createOptimisticMessage(directRoomId, accountAId, 'Hello B from A', 'cid-a-1');
    stateA.addOptimisticMessage(optA);

    const renderedA = renderBubbleSimulation(optA, accountAId, stateA);
    assert.equal(renderedA.isOwn, true, 'Sender A must recognize message as own');
    assert.equal(renderedA.rowClass, 'message-row outgoing', 'Sender A must render outgoing class');
    assert.equal(renderedA.hasTick, true, 'Sender A message must have ticks');
    assert.equal(renderedA.statusClass, 'status-sent');
    assert.equal(renderedA.tickSymbol, '✓');

    // After sent ACK
    stateA.updateReceipt('cid-a-1', 'sent', directRoomId);
    const renderedSent = renderBubbleSimulation(optA, accountAId, stateA);
    assert.equal(renderedSent.hasTick, true);
    assert.equal(renderedSent.statusClass, 'status-sent');
    assert.equal(renderedSent.tickSymbol, '✓');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. A sends to B -> B renders incoming
  // ─────────────────────────────────────────────────────────────
  test('2. A sends to B -> B renders incoming (message-row incoming, NO ticks)', () => {
    const stateB = new RoomMessagesState(accountBId);
    stateB.roomId = directRoomId;

    const wirePayloadFromA = {
      id: 'srv-msg-a-to-b',
      room_id: directRoomId,
      sender_id: accountAId,
      body: { text: 'Hello B from A' },
      event_seq: 101,
      created_at: '2026-09-23T12:00:00Z'
    };

    stateB.appendIncomingMessage(wirePayloadFromA);
    assert.equal(stateB.messages.length, 1);

    const receivedOnB = stateB.messages[0];
    const renderedB = renderBubbleSimulation(receivedOnB, accountBId, stateB);

    assert.equal(renderedB.isOwn, false, 'Recipient B must NOT treat A message as own');
    assert.equal(renderedB.rowClass, 'message-row incoming', 'Recipient B must render incoming class');
    assert.equal(renderedB.hasTick, false, 'Recipient B message must have NO ticks');
    assert.equal(renderedB.tickSymbol, null, 'Incoming message must have null tickSymbol');
    assert.equal(renderedB.statusClass, null, 'Incoming message must have null statusClass');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. B sends to A -> B renders outgoing
  // ─────────────────────────────────────────────────────────────
  test('3. B sends to A -> B renders outgoing (message-row outgoing, has ticks)', () => {
    const stateB = new RoomMessagesState(accountBId);
    stateB.roomId = directRoomId;

    const optB = createOptimisticMessage(directRoomId, accountBId, 'Hello A from B', 'cid-b-1');
    stateB.addOptimisticMessage(optB);

    const renderedB = renderBubbleSimulation(optB, accountBId, stateB);
    assert.equal(renderedB.isOwn, true, 'Sender B must recognize message as own');
    assert.equal(renderedB.rowClass, 'message-row outgoing', 'Sender B must render outgoing class');
    assert.equal(renderedB.hasTick, true, 'Sender B message must have ticks');

    stateB.updateReceipt('cid-b-1', 'sent', directRoomId);
    const renderedSentB = renderBubbleSimulation(optB, accountBId, stateB);
    assert.equal(renderedSentB.hasTick, true);
    assert.equal(renderedSentB.statusClass, 'status-sent');
    assert.equal(renderedSentB.tickSymbol, '✓');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. B sends to A -> A renders incoming
  // ─────────────────────────────────────────────────────────────
  test('4. B sends to A -> A renders incoming (message-row incoming, NO ticks)', () => {
    const stateA = new RoomMessagesState(accountAId);
    stateA.roomId = directRoomId;

    const wirePayloadFromB = {
      id: 'srv-msg-b-to-a',
      room_id: directRoomId,
      sender_id: accountBId,
      body: { text: 'Hello A from B' },
      event_seq: 102,
      created_at: '2026-09-23T12:01:00Z'
    };

    stateA.appendIncomingMessage(wirePayloadFromB);
    assert.equal(stateA.messages.length, 1);

    const receivedOnA = stateA.messages[0];
    const renderedA = renderBubbleSimulation(receivedOnA, accountAId, stateA);

    assert.equal(renderedA.isOwn, false, 'Recipient A must NOT treat B message as own');
    assert.equal(renderedA.rowClass, 'message-row incoming', 'Recipient A must render incoming class');
    assert.equal(renderedA.hasTick, false, 'Recipient A incoming message must have NO ticks');
    assert.equal(renderedA.tickSymbol, null);
    assert.equal(renderedA.statusClass, null);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Background message preserves sender identity
  // ─────────────────────────────────────────────────────────────
  test('5. Background message preserves sender identity when received in unselected room', () => {
    const roomMapA = new Map();
    function getRoomStateA(rid) {
      if (!roomMapA.has(rid)) {
        const s = new RoomMessagesState(accountAId);
        s.roomId = rid;
        roomMapA.set(rid, s);
      }
      return roomMapA.get(rid);
    }

    // A is currently viewing otherRoomId
    const activeRoomState = getRoomStateA(otherRoomId);
    assert.equal(activeRoomState.roomId, otherRoomId);

    // Event arrives for directRoomId while unselected
    const bgFrame = {
      id: 'bg-srv-msg-5',
      room_id: directRoomId,
      sender_id: accountBId,
      body: { text: 'Background message from B' },
      event_seq: 201
    };

    const targetRoomState = getRoomStateA(directRoomId);
    targetRoomState.appendIncomingMessage(bgFrame);

    // Invariant: Sender identity is preserved as accountBId, NOT active room or local user
    assert.equal(targetRoomState.messages.length, 1);
    const bgMsg = targetRoomState.messages[0];
    assert.equal(bgMsg.sender_id, accountBId);
    assert.equal(bgMsg.senderId, accountBId);

    // When rendered for user A:
    const rendered = renderBubbleSimulation(bgMsg, accountAId, targetRoomState);
    assert.equal(rendered.isOwn, false);
    assert.equal(rendered.rowClass, 'message-row incoming');
    assert.equal(rendered.hasTick, false);
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Room switching preserves sender identity
  // ─────────────────────────────────────────────────────────────
  test('6. Room switching preserves sender identity and message ownership', () => {
    const stateA = new RoomMessagesState(accountAId);
    stateA.roomId = directRoomId;

    // Direct room has 1 outgoing from A and 1 incoming from B
    stateA.setInitialMessages(directRoomId, [
      { id: 'm-a1', roomId: directRoomId, senderId: accountAId, sender_id: accountAId, body: { text: 'A1' } },
      { id: 'm-b1', roomId: directRoomId, senderId: accountBId, sender_id: accountBId, body: { text: 'B1' } }
    ]);
    stateA.updateReceipt('m-a1', 'read', directRoomId);

    // User switches to otherRoomId
    const stateOther = new RoomMessagesState(accountAId);
    stateOther.roomId = otherRoomId;
    stateOther.setInitialMessages(otherRoomId, [
      { id: 'm-oth-1', roomId: otherRoomId, senderId: 'user-c', body: { text: 'C1' } }
    ]);

    // User switches back to directRoomId
    assert.equal(stateA.messages.length, 2);
    const m1 = stateA.messages[0];
    const m2 = stateA.messages[1];

    const r1 = renderBubbleSimulation(m1, accountAId, stateA);
    const r2 = renderBubbleSimulation(m2, accountAId, stateA);

    assert.equal(r1.isOwn, true, 'm-a1 must remain outgoing for A');
    assert.equal(r1.rowClass, 'message-row outgoing');
    assert.equal(r1.hasTick, true);
    assert.equal(r1.tickSymbol, '✓✓');
    assert.equal(r1.statusClass, 'status-read');

    assert.equal(r2.isOwn, false, 'm-b1 must remain incoming for A');
    assert.equal(r2.rowClass, 'message-row incoming');
    assert.equal(r2.hasTick, false);
  });

  // ─────────────────────────────────────────────────────────────
  // 7. History reload preserves sender identity
  // ─────────────────────────────────────────────────────────────
  test('7. History reload preserves sender identity (canonical sender_id and senderId normalized)', () => {
    const stateB = new RoomMessagesState(accountBId);
    stateB.roomId = directRoomId;

    // Server returns mixed history (some wire snake_case sender_id, some camelCase senderId)
    const serverHistory = [
      { id: 'h1', room_id: directRoomId, sender_id: accountAId, event_seq: 1, body: { text: 'From A' } },
      { id: 'h2', roomId: directRoomId, senderId: accountBId, eventSeq: 2, body: { text: 'From B' } },
      { id: 'h3', room_id: directRoomId, sender_id: accountAId, event_seq: 3, body: { text: 'From A again' } }
    ];

    stateB.mergeServerMessages(serverHistory);
    assert.equal(stateB.messages.length, 3);

    // On B's client:
    // h1 is from A -> incoming, no ticks
    assert.equal(isOwnMessage(stateB.messages[0], accountBId), false);
    const r1 = renderBubbleSimulation(stateB.messages[0], accountBId, stateB);
    assert.equal(r1.rowClass, 'message-row incoming');
    assert.equal(r1.hasTick, false);

    // h2 is from B -> outgoing, has ticks
    assert.equal(isOwnMessage(stateB.messages[1], accountBId), true);
    const r2 = renderBubbleSimulation(stateB.messages[1], accountBId, stateB);
    assert.equal(r2.rowClass, 'message-row outgoing');
    assert.equal(r2.hasTick, true);

    // h3 is from A -> incoming, no ticks
    assert.equal(isOwnMessage(stateB.messages[2], accountBId), false);
    const r3 = renderBubbleSimulation(stateB.messages[2], accountBId, stateB);
    assert.equal(r3.rowClass, 'message-row incoming');
    assert.equal(r3.hasTick, false);
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Reconciliation from clientMessageId -> server message ID preserves sender identity
  // ─────────────────────────────────────────────────────────────
  test('8. Reconciliation from clientMessageId -> server message ID preserves sender identity', () => {
    const stateA = new RoomMessagesState(accountAId);
    stateA.roomId = directRoomId;

    const cid = 'cid-reconcile-test-8';
    const optA = createOptimisticMessage(directRoomId, accountAId, 'Reconcile test', cid);
    stateA.addOptimisticMessage(optA);

    assert.equal(stateA.messages.length, 1);
    assert.equal(stateA.messages[0].id, cid);
    assert.equal(stateA.messages[0].senderId, accountAId);

    // Server emits message.created with server ID and snake_case sender_id
    const serverCreated = {
      id: 'srv-assigned-id-888',
      room_id: directRoomId,
      sender_id: accountAId,
      client_message_id: cid,
      event_seq: 888,
      body: { text: 'Reconcile test' }
    };

    stateA.appendIncomingMessage(serverCreated);

    assert.equal(stateA.messages.length, 1, 'Reconciled message must replace optimistic, not duplicate');
    const reconciled = stateA.messages[0];
    assert.equal(reconciled.id, 'srv-assigned-id-888');
    assert.equal(reconciled.sender_id, accountAId);
    assert.equal(reconciled.senderId, accountAId);

    const rendered = renderBubbleSimulation(reconciled, accountAId, stateA);
    assert.equal(rendered.isOwn, true);
    assert.equal(rendered.rowClass, 'message-row outgoing');
    assert.equal(rendered.hasTick, true);
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Incoming messages have no ticks
  // ─────────────────────────────────────────────────────────────
  test('9. Incoming messages have no ticks under any receipt update attempts', () => {
    const stateB = new RoomMessagesState(accountBId);
    stateB.roomId = directRoomId;

    const incomingFromA = {
      id: 'srv-a-incoming-test-9',
      room_id: directRoomId,
      sender_id: accountAId,
      body: { text: 'Incoming from A' },
      event_seq: 901
    };

    stateB.appendIncomingMessage(incomingFromA);

    // Attempting to set receipts on an incoming message must be strictly rejected
    stateB.updateReceipt('srv-a-incoming-test-9', 'sent', directRoomId);
    stateB.updateReceipt('srv-a-incoming-test-9', 'delivered', directRoomId);
    stateB.updateReceipt('srv-a-incoming-test-9', 'read', directRoomId);

    // Invariant: incoming message status must not exist in state
    assert.equal(stateB.getStatus('srv-a-incoming-test-9'), null);

    const tickDesc = getTickDescriptor(stateB.getStatus('srv-a-incoming-test-9'), false);
    assert.equal(tickDesc.hasTick, false);
    assert.equal(tickDesc.symbol, '');

    const rendered = renderBubbleSimulation(incomingFromA, accountBId, stateB);
    assert.equal(rendered.isOwn, false);
    assert.equal(rendered.rowClass, 'message-row incoming');
    assert.equal(rendered.hasTick, false);
    assert.equal(rendered.tickSymbol, null);
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Outgoing messages retain receipt state
  // ─────────────────────────────────────────────────────────────
  test('10. Outgoing messages retain receipt state across transitions and state lookups', () => {
    const stateA = new RoomMessagesState(accountAId);
    stateA.roomId = directRoomId;

    const optA = createOptimisticMessage(directRoomId, accountAId, 'Outgoing receipt lifecycle', 'cid-lifecycle-10');
    stateA.addOptimisticMessage(optA);

    // 1. Sending
    assert.equal(stateA.getStatus('cid-lifecycle-10'), 'sending');
    let tick = getTickDescriptor(stateA.getStatus('cid-lifecycle-10'), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');

    // 2. Sent
    stateA.updateReceipt('cid-lifecycle-10', 'sent', directRoomId);
    assert.equal(stateA.getStatus('cid-lifecycle-10'), 'sent');
    tick = getTickDescriptor(stateA.getStatus('cid-lifecycle-10'), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');

    // Server reconciliation with server ID
    stateA.appendIncomingMessage({
      id: 'srv-lifecycle-10',
      client_message_id: 'cid-lifecycle-10',
      room_id: directRoomId,
      sender_id: accountAId,
      body: { text: 'Outgoing receipt lifecycle' }
    });

    // 3. Delivered
    stateA.updateReceipt('srv-lifecycle-10', 'delivered', directRoomId);
    assert.equal(stateA.getStatus('srv-lifecycle-10'), 'delivered');
    tick = getTickDescriptor(stateA.getStatus('srv-lifecycle-10'), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-delivered');

    // 4. Read
    stateA.updateReceipt('srv-lifecycle-10', 'read', directRoomId);
    assert.equal(stateA.getStatus('srv-lifecycle-10'), 'read');
    tick = getTickDescriptor(stateA.getStatus('srv-lifecycle-10'), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');
  });
});


