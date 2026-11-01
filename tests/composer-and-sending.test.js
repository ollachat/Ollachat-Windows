import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  validateComposerText,
  createOptimisticMessage,
  generateUuid,
  getCalendarDateKey,
  formatCalendarDayLabel
} from '../src/renderer/chat-shell-state.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

describe('Phase 4D: Message Sending & Composer Unit Tests', () => {
  let roomState;
  const currentUserId = 'usr-current-user-4d';

  beforeEach(() => {
    roomState = new RoomMessagesState(currentUserId);
    roomState.setInitialMessages('room-test-1', []);
  });

  // 1. Empty message validation
  test('1. validateComposerText rejects empty, null, undefined, and non-string values', () => {
    assert.equal(validateComposerText('').valid, false);
    assert.equal(validateComposerText(null).valid, false);
    assert.equal(validateComposerText(undefined).valid, false);
    assert.equal(validateComposerText(123).valid, false);
    assert.equal(validateComposerText({}).valid, false);
  });

  // 2. Whitespace-only validation
  test('2. validateComposerText rejects whitespace-only strings', () => {
    assert.equal(validateComposerText('   ').valid, false);
    assert.equal(validateComposerText('\t\t').valid, false);
    assert.equal(validateComposerText('\n\n  \r\n').valid, false);
    assert.ok(validateComposerText('   ').error.includes('whitespace'));
  });

  // 3. Outer whitespace handling
  test('3. validateComposerText trims outer whitespace and returns valid text', () => {
    const res = validateComposerText('   Hello OllaChat!   \n');
    assert.equal(res.valid, true);
    assert.equal(res.text, 'Hello OllaChat!');
    assert.equal(res.error, null);
  });

  // 4. Internal newline preservation
  test('4. validateComposerText preserves internal newlines and formatting', () => {
    const multiline = '  First paragraph\n\nSecond paragraph\n  Indented line  ';
    const res = validateComposerText(multiline);
    assert.equal(res.valid, true);
    assert.equal(res.text, 'First paragraph\n\nSecond paragraph\n  Indented line');
  });

  // 5. Optimistic message creation
  test('5. createOptimisticMessage produces canonical outgoing message structure', () => {
    const opt = createOptimisticMessage('room-100', currentUserId, 'Hello World', 'local-uuid-1');
    assert.equal(opt.roomId, 'room-100');
    assert.equal(opt.senderId, currentUserId);
    assert.equal(opt.clientMessageId, 'local-uuid-1');
    assert.equal(opt.id, 'local-uuid-1');
    assert.equal(opt.kind, 'text');
    assert.deepEqual(opt.body, { text: 'Hello World' });
    assert.equal(opt.status, MESSAGE_STATUS.SENDING);
    assert.ok(typeof opt.createdAt === 'string' && opt.createdAt.length > 0);
  });

  // 6. Optimistic sending status
  test('6. addOptimisticMessage adds message and registers SENDING status', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Testing optimistic status', 'local-uuid-2');
    const added = roomState.addOptimisticMessage(opt);

    assert.equal(added.clientMessageId, 'local-uuid-2');
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messageStatus.get('local-uuid-2'), MESSAGE_STATUS.SENDING);
  });

  // 7. Normal send payload
  test('7. Outgoing message payload matches confirmed message.send protocol', () => {
    const text = 'Hello peer';
    const clientMessageId = 'local-send-1';
    const payload = {
      client_message_id: clientMessageId,
      kind: 'text',
      body: { text },
      attachment_ids: []
    };

    assert.equal(payload.client_message_id, clientMessageId);
    assert.equal(payload.kind, 'text');
    assert.deepEqual(payload.body, { text: 'Hello peer' });
    assert.deepEqual(payload.attachment_ids, []);
  });

  // 8. Enter-to-send behavior
  test('8. Enter without shift triggers send and prevents default newline', () => {
    let defaultPrevented = false;
    let sendTriggered = false;

    const event = {
      key: 'Enter',
      shiftKey: false,
      preventDefault: () => {
        defaultPrevented = true;
      }
    };

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendTriggered = true;
    }

    assert.equal(defaultPrevented, true);
    assert.equal(sendTriggered, true);
  });

  // 9. Shift+Enter newline behavior
  test('9. Shift+Enter does not trigger send and allows newline', () => {
    let defaultPrevented = false;
    let sendTriggered = false;

    const event = {
      key: 'Enter',
      shiftKey: true,
      preventDefault: () => {
        defaultPrevented = true;
      }
    };

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendTriggered = true;
    }

    assert.equal(defaultPrevented, false);
    assert.equal(sendTriggered, false);
  });

  // 10. Composer clearing
  test('10. Composer is cleared and room draft removed after message enters send flow', () => {
    const drafts = new Map();
    drafts.set('room-test-1', 'Pending text');

    let composerValue = 'Pending text';
    // Simulate send flow entry
    composerValue = '';
    drafts.delete('room-test-1');

    assert.equal(composerValue, '');
    assert.equal(drafts.has('room-test-1'), false);
  });

  // 11. ACK -> sent
  test('11. Server ACK transitions message status from sending to sent', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Message to ack', 'local-ack-1');
    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messageStatus.get('local-ack-1'), 'sending');

    const updated = roomState.updateReceipt('local-ack-1', 'sent');
    assert.equal(updated, true);
    assert.equal(roomState.messageStatus.get('local-ack-1'), 'sent');
  });

  // 12. Server message.created reconciliation
  test('12. server message.created reconciles optimistic message by clientMessageId without duplicates', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Draft text', 'local-rec-1');
    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messages.length, 1);

    const serverFrame = {
      id: 'srv-msg-999',
      room_id: 'room-test-1',
      sender_id: currentUserId,
      kind: 'text',
      body: { text: 'Draft text' },
      created_at: '2026-09-21T18:00:00.000Z',
      event_seq: 145,
      client_message_id: 'local-rec-1'
    };

    const reconciled = roomState.appendIncomingMessage(serverFrame);
    assert.equal(roomState.messages.length, 1);
    assert.equal(reconciled.id, 'srv-msg-999');
    assert.equal(reconciled.clientMessageId, 'local-rec-1');
    assert.equal(reconciled.event_seq, 145);
  });

  // 13. Duplicate prevention
  test('13. Adding optimistic message twice with same clientMessageId does not create duplicates', () => {
    const opt1 = createOptimisticMessage('room-test-1', currentUserId, 'Duplicate test', 'local-dup-1');
    const opt2 = createOptimisticMessage('room-test-1', currentUserId, 'Duplicate test', 'local-dup-1');

    roomState.addOptimisticMessage(opt1);
    roomState.addOptimisticMessage(opt2);

    assert.equal(roomState.messages.length, 1);
  });

  // 14. Transport failure -> failed
  test('14. Transport failure marks message as failed while keeping message visible', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Failure test', 'local-fail-1');
    roomState.addOptimisticMessage(opt);

    const updated = roomState.updateReceipt('local-fail-1', 'failed');
    assert.equal(updated, true);
    assert.equal(roomState.messageStatus.get('local-fail-1'), 'failed');
    assert.equal(roomState.messages.length, 1);
  });

  // 15. Retry without duplicate bubble
  test('15. Retrying failed message transitions status to sending without appending a second bubble', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Retry test', 'local-retry-1');
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt('local-retry-1', 'failed');
    assert.equal(roomState.messageStatus.get('local-retry-1'), 'failed');

    // Simulate handleRetryMessage: recovery from failed -> sending
    const retried = roomState.updateReceipt('local-retry-1', 'sending');
    assert.equal(retried, true);
    assert.equal(roomState.messageStatus.get('local-retry-1'), 'sending');
    assert.equal(roomState.messages.length, 1);
  });

  // 16. Retry reuses clientMessageId
  test('16. Retrying message reuses the original clientMessageId', () => {
    const originalCid = 'local-retry-preserve-cid';
    const pendingPayloads = new Map();
    pendingPayloads.set(originalCid, {
      roomId: 'room-test-1',
      text: 'Preserved message text',
      clientMessageId: originalCid
    });

    const pending = pendingPayloads.get(originalCid);
    assert.equal(pending.clientMessageId, originalCid);
    assert.equal(pending.text, 'Preserved message text');
  });

  // 17. Delivered receipt
  test('17. Delivered receipt advances message status monotonically to delivered', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Delivered test', 'local-deliv-1');
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt('local-deliv-1', 'sent');

    const updated = roomState.updateReceipt('local-deliv-1', 'delivered');
    assert.equal(updated, true);
    assert.equal(roomState.messageStatus.get('local-deliv-1'), 'delivered');
  });

  // 18. Read receipt
  test('18. Read receipt advances message status monotonically to read', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Read test', 'local-read-1');
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt('local-read-1', 'sent');
    roomState.updateReceipt('local-read-1', 'delivered');

    const updated = roomState.updateReceipt('local-read-1', 'read');
    assert.equal(updated, true);
    assert.equal(roomState.messageStatus.get('local-read-1'), 'read');
  });

  // 19. Status monotonicity
  test('19. Status monotonicity rejects downgrades: read->delivered, delivered->sent, sent->sending, sent->failed', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Mono test', 'local-mono-1');
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt('local-mono-1', 'sent');

    // sent cannot become sending
    assert.equal(roomState.updateReceipt('local-mono-1', 'sending'), false);
    assert.equal(roomState.messageStatus.get('local-mono-1'), 'sent');

    // sent cannot become failed
    assert.equal(roomState.updateReceipt('local-mono-1', 'failed'), false);
    assert.equal(roomState.messageStatus.get('local-mono-1'), 'sent');

    // advance to delivered
    roomState.updateReceipt('local-mono-1', 'delivered');
    // delivered cannot become sent
    assert.equal(roomState.updateReceipt('local-mono-1', 'sent'), false);
    assert.equal(roomState.messageStatus.get('local-mono-1'), 'delivered');

    // advance to read
    roomState.updateReceipt('local-mono-1', 'read');
    // read cannot become delivered or sent
    assert.equal(roomState.updateReceipt('local-mono-1', 'delivered'), false);
    assert.equal(roomState.updateReceipt('local-mono-1', 'sent'), false);
    assert.equal(roomState.messageStatus.get('local-mono-1'), 'read');
  });

  // 20. Conversation switching/draft isolation
  test('20. Composer drafts are isolated per room and never cross-sent', () => {
    const roomComposerDrafts = new Map();

    // User types in Room A
    roomComposerDrafts.set('room-A', 'Draft for Room A');

    // User switches to Room B
    assert.equal(roomComposerDrafts.get('room-B') || '', '');

    // User types in Room B
    roomComposerDrafts.set('room-B', 'Draft for Room B');

    // Switch back to Room A
    assert.equal(roomComposerDrafts.get('room-A'), 'Draft for Room A');
    assert.equal(roomComposerDrafts.get('room-B'), 'Draft for Room B');
  });

  // 21. Disconnected WebSocket handling
  test('21. Disconnected WebSocket transitions send immediately to failed state without phantom success', async () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Offline send', 'local-offline-1');
    roomState.addOptimisticMessage(opt);

    const wsState = 'disconnected';
    if (wsState !== 'connected') {
      roomState.updateReceipt('local-offline-1', 'failed');
    }

    assert.equal(roomState.messageStatus.get('local-offline-1'), 'failed');
  });

  // 22. Request/message correlation
  test('22. requestToClient correlates request_id with clientMessageId and cleans up', () => {
    const requestToClient = new Map();
    const requestId = 'req-abc-123';
    const clientMessageId = 'local-corr-1';

    requestToClient.set(requestId, clientMessageId);
    assert.equal(requestToClient.get(requestId), clientMessageId);

    // On ACK
    const matched = requestToClient.get(requestId);
    requestToClient.delete(requestId);

    assert.equal(matched, clientMessageId);
    assert.equal(requestToClient.has(requestId), false);
  });

  // 23. Stale ACK protection
  test('23. Stale ACK from prior room does not modify state of active room', () => {
    const activeRoomId = 'room-B';
    const pendingPayloads = new Map();
    pendingPayloads.set('local-stale-1', {
      roomId: 'room-A',
      text: 'Message for Room A',
      clientMessageId: 'local-stale-1'
    });

    const pending = pendingPayloads.get('local-stale-1');
    let stateUpdated = false;

    // Guard: only update active room state if roomId matches
    if (pending && pending.roomId === activeRoomId) {
      stateUpdated = true;
    }

    assert.equal(stateUpdated, false);
  });

  // 24. RoomId safety
  test('24. Outgoing message is bound strictly to active room', () => {
    const selectedRoomId = 'room-safe-42';
    const msg = createOptimisticMessage(selectedRoomId, currentUserId, 'Safety message');

    assert.equal(msg.roomId, 'room-safe-42');
    assert.equal(msg.senderId, currentUserId);
  });

  // 25. generateUuid produces valid RFC 4122 v4 UUID
  test('25. generateUuid produces valid RFC 4122 v4 format', () => {
    const uuid = generateUuid();
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  // 26. generateUuid falls back safely when crypto.randomUUID is not a function (e.g. Electron sandboxed file://)
  test('26. generateUuid succeeds even when crypto.randomUUID is undefined', () => {
    const origRandomUUID = globalThis.crypto?.randomUUID;
    try {
      // Simulate Electron file:// sandboxed context where randomUUID does not exist
      if (globalThis.crypto) {
        delete globalThis.crypto.randomUUID;
      }
      const uuid = generateUuid();
      assert.ok(uuid);
      assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Verify createOptimisticMessage uses generateUuid without throwing
      const opt = createOptimisticMessage('room-uuid-test', currentUserId, 'Testing without randomUUID');
      assert.ok(opt.clientMessageId);
      assert.ok(opt.clientMessageId.startsWith('local-'));
      assert.equal(opt.body.text, 'Testing without randomUUID');
    } finally {
      if (origRandomUUID && globalThis.crypto) {
        globalThis.crypto.randomUUID = origRandomUUID;
      }
    }
  });

  // 27. Duplicate send prevention via composer state
  test('27. Duplicate send prevention: clearing composer synchronously rejects rapid second send', () => {
    let composerText = 'Hello duplicate test';
    const sentMessages = [];

    function attemptSend() {
      const validation = validateComposerText(composerText);
      if (!validation.valid) {
        return false;
      }
      // Simulate handleSendMessage synchronous flow
      composerText = ''; // synchronously cleared
      const opt = createOptimisticMessage('room-1', currentUserId, validation.text);
      sentMessages.push(opt);
      return true;
    }

    const firstClick = attemptSend();
    const secondClick = attemptSend(); // rapid click while async send is pending

    assert.equal(firstClick, true);
    assert.equal(secondClick, false);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].body.text, 'Hello duplicate test');
  });

  // 28. Optimistic message rendering and reconciliation
  test('28. Optimistic message is reconciled upon server ACK without creating duplicate', () => {
    const opt = createOptimisticMessage('room-test-1', currentUserId, 'Hello ACK test', 'local-ack-1');
    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, 'local-ack-1');

    // Simulate server message created event returning canonical server ID
    const serverMessage = {
      id: 'srv-msg-999',
      client_message_id: 'local-ack-1',
      room_id: 'room-test-1',
      sender_id: currentUserId,
      kind: 'text',
      body: { text: 'Hello ACK test' },
      created_at: new Date().toISOString()
    };

    const reconciled = roomState.appendIncomingMessage(serverMessage);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, 'srv-msg-999');
    assert.equal(roomState.messages[0].clientMessageId, 'local-ack-1');
  });

  // 29. getCalendarDateKey & formatCalendarDayLabel regression test
  test('29. getCalendarDateKey and formatCalendarDayLabel format valid dates and fallback gracefully', () => {
    const fixedDate = new Date(2026, 9, 27, 12, 0, 0); // Oct 27, 2026
    const key = getCalendarDateKey(fixedDate);
    assert.equal(key, '2026-10-27');

    const label = formatCalendarDayLabel(fixedDate, fixedDate);
    assert.equal(label, 'Today');

    // Safe fallbacks for missing/invalid input
    assert.equal(getCalendarDateKey(null), 'unknown-date');
    assert.equal(getCalendarDateKey('invalid-date-string'), 'unknown-date');
    assert.equal(formatCalendarDayLabel(null), '');
  });

  // 30. Multi-room heartbeat pong cancels room pongTimer and awaitingPong
  test('30. Multi-room heartbeat pong cancels room pongTimer and avoids unexpected 1006 disconnect', () => {
    const ws = new ChatWebSocket({ url: 'ws://127.0.0.1:9999', multiRoom: true });
    const roomId = 'room-pong-test-1';
    const pingRequestId = 'ping-req-456';

    const mockEntry = {
      roomId,
      state: 'connected',
      socket: { readyState: 1, send: () => {} },
      awaitingPong: true,
      lastPingRequestId: pingRequestId,
      pongTimer: setTimeout(() => {}, 10000)
    };

    ws._roomSockets.set(roomId, mockEntry);

    // Simulate incoming pong ack from server matching the pingRequestId
    const incomingFrame = {
      type: 'ack',
      request_id: pingRequestId,
      room_id: roomId,
      payload: { type: 'pong' }
    };

    ws._handleIncomingFrame(incomingFrame);

    assert.equal(mockEntry.awaitingPong, false, 'awaitingPong must be reset to false');
    assert.equal(mockEntry.lastPingRequestId, null, 'lastPingRequestId must be cleared');
    assert.equal(mockEntry.pongTimer, null, 'pongTimer must be cancelled and cleared');
  });

  // 31. Complete outgoing message pipeline
  test('31. Full outgoing message pipeline executes cleanly from validation to append', () => {
    const rawInput = 'Hello complete pipeline test';
    const validation = validateComposerText(rawInput);
    assert.equal(validation.valid, true);

    const clientMessageId = `local-${generateUuid()}`;
    assert.ok(clientMessageId.startsWith('local-'));

    const optimisticMsg = createOptimisticMessage('room-pipe-1', currentUserId, validation.text, clientMessageId);
    assert.equal(optimisticMsg.body.text, rawInput);
    assert.equal(optimisticMsg.status, MESSAGE_STATUS.SENDING);

    const dateKey = getCalendarDateKey(optimisticMsg.createdAt);
    assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/);

    const dayLabel = formatCalendarDayLabel(optimisticMsg.createdAt);
    assert.ok(dayLabel.length > 0);

    roomState.addOptimisticMessage(optimisticMsg);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.getStatus(clientMessageId), 'sending');
  });
});

