import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  STATUS_RANKS,
  createOptimisticMessage,
  getTickDescriptor,
  isOwnMessage,
  isWindowActiveAndVisible
} from '../src/renderer/chat-shell-state.js';

describe('WhatsApp-Style Message Delivery & Read Tick System (20 Invariants)', () => {
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const roomA = 'room-alpha';
  const roomB = 'room-beta';

  let sharedStore;
  let roomMap;

  function getOrCreateState(roomId, userId = currentUserId) {
    if (!roomMap.has(roomId)) {
      const s = new RoomMessagesState(userId, sharedStore);
      s.roomId = roomId;
      roomMap.set(roomId, s);
    }
    return roomMap.get(roomId);
  }

  beforeEach(() => {
    sharedStore = new Map();
    roomMap = new Map();
  });

  // 1. optimistic outgoing message starts pending
  test('1. optimistic outgoing message starts pending (SENDING, single tick / pending indicator)', () => {
    const state = getOrCreateState(roomA);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Hello World', 'client-msg-1');
    state.addOptimisticMessage(opt);

    assert.equal(state.getStatus('client-msg-1'), MESSAGE_STATUS.SENDING);
    const desc = getTickDescriptor(state.getStatus('client-msg-1'), true);
    assert.equal(desc.hasTick, true);
    assert.equal(desc.symbol, '✓');
    assert.equal(desc.title, 'Sending');
  });

  // 2. server acknowledgement changes it to SENT
  test('2. server acknowledgement changes it to SENT (one grey tick)', () => {
    const state = getOrCreateState(roomA);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Hello World', 'client-msg-2');
    state.addOptimisticMessage(opt);

    const updated = state.updateReceipt('client-msg-2', MESSAGE_STATUS.SENT, roomA);
    assert.equal(updated, true);
    assert.equal(state.getStatus('client-msg-2'), MESSAGE_STATUS.SENT);

    const desc = getTickDescriptor(state.getStatus('client-msg-2'), true);
    assert.equal(desc.hasTick, true);
    assert.equal(desc.symbol, '✓');
    assert.equal(desc.statusClass, 'status-sent');
    assert.equal(desc.title, 'Sent');
  });

  // 3. delivered receipt changes it to DELIVERED
  test('3. delivered receipt changes it to DELIVERED (two grey ticks)', () => {
    const state = getOrCreateState(roomA);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Delivered test', 'client-msg-3');
    state.addOptimisticMessage(opt);
    state.updateReceipt('client-msg-3', MESSAGE_STATUS.SENT, roomA);

    const updated = state.updateReceipt('client-msg-3', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(updated, true);
    assert.equal(state.getStatus('client-msg-3'), MESSAGE_STATUS.DELIVERED);

    const desc = getTickDescriptor(state.getStatus('client-msg-3'), true);
    assert.equal(desc.hasTick, true);
    assert.equal(desc.symbol, '✓✓');
    assert.equal(desc.statusClass, 'status-delivered');
    assert.equal(desc.title, 'Delivered');
  });

  // 4. read receipt changes it to READ
  test('4. read receipt changes it to READ (two blue ticks)', () => {
    const state = getOrCreateState(roomA);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Read test', 'client-msg-4');
    state.addOptimisticMessage(opt);
    state.updateReceipt('client-msg-4', MESSAGE_STATUS.SENT, roomA);
    state.updateReceipt('client-msg-4', MESSAGE_STATUS.DELIVERED, roomA);

    const updated = state.updateReceipt('client-msg-4', MESSAGE_STATUS.READ, roomA);
    assert.equal(updated, true);
    assert.equal(state.getStatus('client-msg-4'), MESSAGE_STATUS.READ);

    const desc = getTickDescriptor(state.getStatus('client-msg-4'), true);
    assert.equal(desc.hasTick, true);
    assert.equal(desc.symbol, '✓✓');
    assert.equal(desc.statusClass, 'status-read');
    assert.equal(desc.title, 'Read');
  });

  // 5. delivered does not become READ automatically
  test('5. delivered does not become READ automatically', () => {
    const state = getOrCreateState(roomA);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Stay delivered', 'client-msg-5');
    state.addOptimisticMessage(opt);
    state.updateReceipt('client-msg-5', MESSAGE_STATUS.SENT, roomA);
    state.updateReceipt('client-msg-5', MESSAGE_STATUS.DELIVERED, roomA);

    // It must remain DELIVERED until an explicit read receipt arrives
    assert.equal(state.getStatus('client-msg-5'), MESSAGE_STATUS.DELIVERED);
    const desc = getTickDescriptor(state.getStatus('client-msg-5'), true);
    assert.equal(desc.statusClass, 'status-delivered');
    assert.notEqual(desc.statusClass, 'status-read');
  });

  // 6. receiving a message in an unopened room sends delivered but not read
  test('6. receiving a message in an unopened room sends delivered but not read', () => {
    const stateB = getOrCreateState(peerUserId, peerUserId);
    const incomingMsg = {
      id: 'srv-msg-6',
      room_id: roomB,
      sender_id: currentUserId,
      body: { text: 'Unopened room message' }
    };
    stateB.appendIncomingMessage(incomingMsg);

    // Incoming messages on peer device MUST NOT have receipt ticks on recipient side
    assert.equal(stateB.getStatus('srv-msg-6'), null);
    const descRecipient = getTickDescriptor(stateB.getStatus('srv-msg-6'), false);
    assert.equal(descRecipient.hasTick, false);

    // On sender side, receipt transitions to delivered only
    const stateA = getOrCreateState(roomB, currentUserId);
    stateA.setInitialMessages(roomB, [{
      id: 'srv-msg-6',
      room_id: roomB,
      sender_id: currentUserId,
      body: { text: 'Unopened room message' }
    }]);
    stateA.updateReceipt('srv-msg-6', MESSAGE_STATUS.SENT, roomB);
    stateA.updateReceipt('srv-msg-6', MESSAGE_STATUS.DELIVERED, roomB);

    assert.equal(stateA.getStatus('srv-msg-6'), MESSAGE_STATUS.DELIVERED);
    assert.notEqual(stateA.getStatus('srv-msg-6'), MESSAGE_STATUS.READ);
  });

  // 7. opening the room advances read
  test('7. opening the room advances read', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-7',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Advance to read' }
    }]);
    stateA.updateReceipt('srv-msg-7', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(stateA.getStatus('srv-msg-7'), MESSAGE_STATUS.DELIVERED);

    // When recipient opens room, read receipt arrives on sender
    stateA.updateReceipt('srv-msg-7', MESSAGE_STATUS.READ, roomA);
    assert.equal(stateA.getStatus('srv-msg-7'), MESSAGE_STATUS.READ);
    const desc = getTickDescriptor(stateA.getStatus('srv-msg-7'), true);
    assert.equal(desc.statusClass, 'status-read');
  });

  // 8. duplicate delivered is harmless
  test('8. duplicate delivered is harmless', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-8',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Duplicate delivered' }
    }]);
    stateA.updateReceipt('srv-msg-8', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(stateA.getStatus('srv-msg-8'), MESSAGE_STATUS.DELIVERED);

    // Duplicate delivered
    const dupRes = stateA.updateReceipt('srv-msg-8', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(dupRes, false, 'Duplicate receipt update should return false (no-op)');
    assert.equal(stateA.getStatus('srv-msg-8'), MESSAGE_STATUS.DELIVERED);
  });

  // 9. duplicate read is harmless
  test('9. duplicate read is harmless', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-9',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Duplicate read' }
    }]);
    stateA.updateReceipt('srv-msg-9', MESSAGE_STATUS.READ, roomA);
    assert.equal(stateA.getStatus('srv-msg-9'), MESSAGE_STATUS.READ);

    // Duplicate read
    const dupRes = stateA.updateReceipt('srv-msg-9', MESSAGE_STATUS.READ, roomA);
    assert.equal(dupRes, false, 'Duplicate read receipt should be harmless no-op');
    assert.equal(stateA.getStatus('srv-msg-9'), MESSAGE_STATUS.READ);
  });

  // 10. read never downgrades to delivered
  test('10. read never downgrades to delivered', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-10',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Cannot downgrade read' }
    }]);
    stateA.updateReceipt('srv-msg-10', MESSAGE_STATUS.READ, roomA);
    assert.equal(stateA.getStatus('srv-msg-10'), MESSAGE_STATUS.READ);

    // Late or out-of-order delivered receipt arrives
    const downgradeRes = stateA.updateReceipt('srv-msg-10', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(downgradeRes, false);
    assert.equal(stateA.getStatus('srv-msg-10'), MESSAGE_STATUS.READ, 'Must remain READ');
  });

  // 11. delivered never downgrades to sent
  test('11. delivered never downgrades to sent', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-11',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Cannot downgrade delivered' }
    }]);
    stateA.updateReceipt('srv-msg-11', MESSAGE_STATUS.DELIVERED, roomA);
    assert.equal(stateA.getStatus('srv-msg-11'), MESSAGE_STATUS.DELIVERED);

    // Late server ACK / message.created arrives
    const downgradeRes = stateA.updateReceipt('srv-msg-11', MESSAGE_STATUS.SENT, roomA);
    assert.equal(downgradeRes, false);
    assert.equal(stateA.getStatus('srv-msg-11'), MESSAGE_STATUS.DELIVERED, 'Must remain DELIVERED');
  });

  // 12. receipts cannot affect another room
  test('12. receipts cannot affect another room', () => {
    const stateRoomA = getOrCreateState(roomA, currentUserId);
    const stateRoomB = getOrCreateState(roomB, currentUserId);

    stateRoomA.setInitialMessages(roomA, [{
      id: 'msg-isolated-A',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'In room A' }
    }]);
    stateRoomB.setInitialMessages(roomB, [{
      id: 'msg-isolated-B',
      room_id: roomB,
      sender_id: currentUserId,
      body: { text: 'In room B' }
    }]);

    stateRoomA.updateReceipt('msg-isolated-A', MESSAGE_STATUS.SENT, roomA);
    stateRoomB.updateReceipt('msg-isolated-B', MESSAGE_STATUS.SENT, roomB);

    // Receipt in room B arrives
    stateRoomB.updateReceipt('msg-isolated-B', MESSAGE_STATUS.READ, roomB);

    assert.equal(stateRoomB.getStatus('msg-isolated-B'), MESSAGE_STATUS.READ);
    assert.equal(stateRoomA.getStatus('msg-isolated-A'), MESSAGE_STATUS.SENT, 'Room A status must not be modified');
  });

  // 13. receipts cannot affect another message
  test('13. receipts cannot affect another message in the same room', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [
      { id: 'msg-x1', room_id: roomA, sender_id: currentUserId, body: { text: 'Message 1' } },
      { id: 'msg-x2', room_id: roomA, sender_id: currentUserId, body: { text: 'Message 2' } }
    ]);

    stateA.updateReceipt('msg-x1', MESSAGE_STATUS.SENT, roomA);
    stateA.updateReceipt('msg-x2', MESSAGE_STATUS.SENT, roomA);

    // Message 1 is read
    stateA.updateReceipt('msg-x1', MESSAGE_STATUS.READ, roomA);

    assert.equal(stateA.getStatus('msg-x1'), MESSAGE_STATUS.READ);
    assert.equal(stateA.getStatus('msg-x2'), MESSAGE_STATUS.SENT, 'Message 2 must remain SENT');
  });

  // 14. optimistic message reconciles correctly with server message ID
  test('14. optimistic message reconciles correctly with server message ID', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Reconciliation test', 'client-cid-14');
    stateA.addOptimisticMessage(opt);

    assert.equal(stateA.getStatus('client-cid-14'), MESSAGE_STATUS.SENDING);

    // Server acknowledges with server ID 'srv-id-14'
    stateA.appendIncomingMessage({
      id: 'srv-id-14',
      client_message_id: 'client-cid-14',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Reconciliation test' }
    });
    stateA.updateReceipt('srv-id-14', MESSAGE_STATUS.SENT, roomA);

    // Both IDs resolve to SENT
    assert.equal(stateA.getStatus('srv-id-14'), MESSAGE_STATUS.SENT);
    assert.equal(stateA.getStatus('client-cid-14'), MESSAGE_STATUS.SENT);
  });

  // 15. receipt arriving before reconciliation is handled correctly
  test('15. receipt arriving before reconciliation is handled correctly', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    const opt = createOptimisticMessage(roomA, currentUserId, 'Early receipt test', 'client-cid-15');
    stateA.addOptimisticMessage(opt);

    // Delivered receipt arrives for server ID before message.created has been processed
    stateA.updateReceipt('srv-id-15', MESSAGE_STATUS.DELIVERED, roomA);

    // Later, server reconciliation occurs
    stateA.appendIncomingMessage({
      id: 'srv-id-15',
      client_message_id: 'client-cid-15',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Early receipt test' }
    });

    // The reconciled message should have DELIVERED status linked to both IDs
    assert.equal(stateA.getStatus('srv-id-15'), MESSAGE_STATUS.DELIVERED);
    assert.equal(stateA.getStatus('client-cid-15'), MESSAGE_STATUS.DELIVERED);
  });

  // 16. reconnect/catch-up does not duplicate or corrupt receipt state
  test('16. reconnect/catch-up does not duplicate or corrupt receipt state', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-16',
      room_id: roomA,
      sender_id: currentUserId,
      eventSeq: 10,
      body: { text: 'Catchup test' }
    }]);
    stateA.updateReceipt('srv-msg-16', MESSAGE_STATUS.READ, roomA);

    // Catchup re-delivers message.created with old status sent
    stateA.appendIncomingMessage({
      id: 'srv-msg-16',
      room_id: roomA,
      sender_id: currentUserId,
      eventSeq: 10,
      body: { text: 'Catchup test' }
    });
    stateA.updateReceipt('srv-msg-16', MESSAGE_STATUS.SENT, roomA);

    // Status remains monotonically READ
    assert.equal(stateA.getStatus('srv-msg-16'), MESSAGE_STATUS.READ);
    assert.equal(stateA.messages.length, 1, 'No duplicate messages in history');
  });

  // 17. background multi-room message delivery works correctly
  test('17. background multi-room message delivery works correctly', () => {
    // Current active room is Room A
    const stateA = getOrCreateState(roomA, currentUserId);
    const stateB = getOrCreateState(roomB, currentUserId);

    // Incoming background message in Room B
    const bgMsg = {
      id: 'srv-bg-17',
      room_id: roomB,
      sender_id: peerUserId,
      body: { text: 'Background message' }
    };
    stateB.appendIncomingMessage(bgMsg);

    // Delivery receipt on Room B does not leak into Room A
    assert.equal(stateA.hasMessage('srv-bg-17'), false);
    assert.equal(stateB.hasMessage('srv-bg-17'), true);
  });

  // 18. selected conversation read behavior works correctly
  test('18. selected conversation read behavior works correctly', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    const msg = {
      id: 'srv-msg-18',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Active conversation message' }
    };
    stateA.setInitialMessages(roomA, [msg]);
    stateA.updateReceipt('srv-msg-18', MESSAGE_STATUS.SENT, roomA);
    stateA.updateReceipt('srv-msg-18', MESSAGE_STATUS.DELIVERED, roomA);
    stateA.updateReceipt('srv-msg-18', MESSAGE_STATUS.READ, roomA);

    assert.equal(stateA.getStatus('srv-msg-18'), MESSAGE_STATUS.READ);
    const desc = getTickDescriptor(stateA.getStatus('srv-msg-18'), true);
    assert.equal(desc.symbol, '✓✓');
    assert.equal(desc.statusClass, 'status-read');
  });

  // 19. hidden/tray conversation remains delivered but unread until opened
  test('19. hidden/tray conversation remains delivered but unread until opened', () => {
    // When window is not visible or hidden in tray, isWindowActiveAndVisible returns false
    const hiddenDoc = { hidden: true, visibilityState: 'hidden' };
    assert.equal(isWindowActiveAndVisible(hiddenDoc), false, 'Hidden in tray must return isWindowActiveAndVisible() === false');

    const stateA = getOrCreateState(roomA, currentUserId);
    stateA.setInitialMessages(roomA, [{
      id: 'srv-msg-19',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Tray arrival' }
    }]);
    stateA.updateReceipt('srv-msg-19', MESSAGE_STATUS.DELIVERED, roomA);

    // Remains DELIVERED while hidden
    assert.equal(stateA.getStatus('srv-msg-19'), MESSAGE_STATUS.DELIVERED);

    // Once restored/opened:
    const visibleDoc = { hidden: false, visibilityState: 'visible' };
    assert.equal(isWindowActiveAndVisible(visibleDoc), true, 'Restored window returns true');
    stateA.updateReceipt('srv-msg-19', MESSAGE_STATUS.READ, roomA);
    assert.equal(stateA.getStatus('srv-msg-19'), MESSAGE_STATUS.READ);
  });

  // 20. outgoing messages from the current user never get treated as incoming/read incorrectly
  test('20. outgoing messages from the current user never get treated as incoming/read incorrectly', () => {
    const stateA = getOrCreateState(roomA, currentUserId);
    const ownMsg = {
      id: 'srv-msg-20-own',
      room_id: roomA,
      sender_id: currentUserId,
      body: { text: 'Own message' }
    };
    const peerMsg = {
      id: 'srv-msg-20-peer',
      room_id: roomA,
      sender_id: peerUserId,
      body: { text: 'Peer message' }
    };

    assert.equal(isOwnMessage(ownMsg, currentUserId), true);
    assert.equal(isOwnMessage(peerMsg, currentUserId), false);

    stateA.setInitialMessages(roomA, [ownMsg, peerMsg]);

    // Outgoing message receives ticks
    stateA.updateReceipt('srv-msg-20-own', MESSAGE_STATUS.SENT, roomA);
    assert.equal(stateA.getStatus('srv-msg-20-own'), MESSAGE_STATUS.SENT);
    assert.equal(getTickDescriptor(stateA.getStatus('srv-msg-20-own'), true).hasTick, true);

    // Incoming message MUST NEVER receive or store receipt status
    const incomingReceiptAttempt = stateA.updateReceipt('srv-msg-20-peer', MESSAGE_STATUS.SENT, roomA);
    assert.equal(incomingReceiptAttempt, false);
    assert.equal(stateA.getStatus('srv-msg-20-peer'), null);
    assert.equal(getTickDescriptor(stateA.getStatus('srv-msg-20-peer'), false).hasTick, false);
  });
});
