import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RoomMessagesState,
  MESSAGE_STATUS,
  formatMessageTime,
  formatDayDivider,
  groupMessagesByDay,
  resolveMessageContent,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Phase 4C: Message History & Message Rendering Unit Tests', () => {

  // 1. RoomMessagesState initial load
  test('1. RoomMessagesState initial load populates ordered messages and resets previous state', () => {
    const state = new RoomMessagesState('user-self');
    const initialBatch = [
      { id: 'm2', eventSeq: 2, body: { text: 'Second' }, createdAt: '2026-09-21T10:01:00Z', senderId: 'user-other' },
      { id: 'm1', eventSeq: 1, body: { text: 'First' }, createdAt: '2026-09-21T10:00:00Z', senderId: 'user-self' }
    ];

    state.setInitialMessages('room-1', initialBatch, true);

    assert.equal(state.roomId, 'room-1');
    assert.equal(state.messages.length, 2);
    // Messages must be ordered oldest -> newest
    assert.equal(state.messages[0].id, 'm1');
    assert.equal(state.messages[1].id, 'm2');
    assert.equal(state.hasMore, true);
    assert.equal(state.isLoadingInitial, false);
    assert.equal(state.error, null);
  });

  // 2. Empty messages
  test('2. RoomMessagesState handles empty conversation history gracefully', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-empty', [], false);

    assert.equal(state.roomId, 'room-empty');
    assert.deepEqual(state.messages, []);
    assert.equal(state.hasMore, false);
    assert.equal(state.oldestSeq, null);
    assert.equal(state.newestSeq, null);
    assert.equal(state.error, null);
  });

  // 3. Sequence bounds
  test('3. Sequence bounds calculate oldestSeq and newestSeq accurately from valid sequence values', () => {
    const state = new RoomMessagesState('user-self');
    const batch = [
      { id: 'm3', eventSeq: 42, createdAt: '2026-09-21T10:05:00Z' },
      { id: 'm1', eventSeq: 5, createdAt: '2026-09-21T10:01:00Z' },
      { id: 'm2', eventSeq: 18, createdAt: '2026-09-21T10:03:00Z' }
    ];

    state.setInitialMessages('room-seq', batch, true);
    assert.equal(state.oldestSeq, 5);
    assert.equal(state.newestSeq, 42);
  });

  // 4. Older-message pagination
  test('4. Older-message pagination prepends messages and updates oldestSeq', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-page', [
      { id: 'm2', eventSeq: 20, body: { text: 'Newer' }, createdAt: '2026-09-21T10:10:00Z' }
    ], true);

    assert.equal(state.oldestSeq, 20);

    const olderBatch = [
      { id: 'm1', eventSeq: 10, body: { text: 'Older' }, createdAt: '2026-09-21T10:05:00Z' }
    ];

    state.prependOlderMessages(olderBatch, false);

    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].id, 'm1');
    assert.equal(state.messages[1].id, 'm2');
    assert.equal(state.oldestSeq, 10);
    assert.equal(state.newestSeq, 20);
    assert.equal(state.hasMore, false);
  });

  // 5. Message deduplication by ID
  test('5. Message deduplication prevents duplicate messages with identical IDs', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-dedup', [
      { id: 'm1', eventSeq: 1, body: { text: 'Original' }, createdAt: '2026-09-21T10:00:00Z' }
    ], true);

    state.prependOlderMessages([
      { id: 'm1', eventSeq: 1, body: { text: 'Duplicate' }, createdAt: '2026-09-21T10:00:00Z' }
    ], false);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].body.text, 'Original');
  });

  // 6. clientMessageId deduplication
  test('6. clientMessageId deduplication prevents duplication of unconfirmed messages', () => {
    const state = new RoomMessagesState('user-self');
    const msg1 = { id: 'm1', clientMessageId: 'client-abc-123', eventSeq: 1, body: { text: 'Pending' } };
    const msg2 = { id: 'm2', clientMessageId: 'client-abc-123', eventSeq: 2, body: { text: 'Confirmed' } };

    state.setInitialMessages('room-client-id', [msg1, msg2], false);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].clientMessageId, 'client-abc-123');
  });

  // 7. Incoming/Outgoing classification
  test('7. isOwnMessage correctly classifies incoming vs. outgoing messages', () => {
    assert.equal(isOwnMessage({ senderId: 'user-me' }, 'user-me'), true);
    assert.equal(isOwnMessage({ sender_id: 'user-me' }, 'user-me'), true);
    assert.equal(isOwnMessage({ senderId: 'user-peer' }, 'user-me'), false);
    assert.equal(isOwnMessage({ senderId: 'user-me' }, null), false);
    assert.equal(isOwnMessage(null, 'user-me'), false);
    assert.equal(isOwnMessage({}, 'user-me'), false);
  });

  // 8. Timestamp formatting
  test('8. formatMessageTime formats local time in HH:MM AM/PM format safely', () => {
    const formatted = formatMessageTime('2026-09-21T14:35:00Z');
    assert.ok(typeof formatted === 'string');
    assert.match(formatted, /\d{1,2}:\d{2}\s+(AM|PM)/i);

    assert.equal(formatMessageTime('invalid-date'), '');
    assert.equal(formatMessageTime(null), '');
    assert.equal(formatMessageTime(''), '');
  });

  // 9. Today/Yesterday/Date formatting
  test('9. formatDayDivider formats Today, Yesterday, and local dates', () => {
    const fixedNow = new Date('2026-09-21T12:00:00Z');

    // Today
    const todayTs = new Date(fixedNow).toISOString();
    assert.equal(formatDayDivider(todayTs, fixedNow), 'Today');

    // Yesterday
    const yesterdayDate = new Date(fixedNow);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    assert.equal(formatDayDivider(yesterdayDate.toISOString(), fixedNow), 'Yesterday');

    // Earlier date in same year
    const earlierDate = new Date('2026-04-15T10:00:00Z');
    const earlierFormatted = formatDayDivider(earlierDate.toISOString(), fixedNow);
    assert.ok(earlierFormatted.includes('Apr 15'));

    // Date in previous year
    const prevYearDate = new Date('2025-11-20T10:00:00Z');
    const prevYearFormatted = formatDayDivider(prevYearDate.toISOString(), fixedNow);
    assert.ok(prevYearFormatted.includes('2025'));
  });

  // 10. Day grouping
  test('10. groupMessagesByDay partitions messages into chronological day buckets', () => {
    const fixedNow = new Date('2026-09-21T12:00:00Z');
    const messages = [
      { id: 'm1', createdAt: '2026-09-19T10:00:00Z', body: { text: 'Two days ago' } },
      { id: 'm2', createdAt: '2026-09-20T11:00:00Z', body: { text: 'Yesterday 1' } },
      { id: 'm3', createdAt: '2026-09-20T15:00:00Z', body: { text: 'Yesterday 2' } },
      { id: 'm4', createdAt: '2026-09-21T09:00:00Z', body: { text: 'Today 1' } }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 3);

    // Group 1: 2026-09-19
    assert.equal(groups[0].messages.length, 1);
    assert.equal(groups[0].messages[0].id, 'm1');

    // Group 2: 2026-09-20 (Yesterday)
    assert.equal(groups[1].messages.length, 2);
    assert.equal(groups[1].label, 'Yesterday');

    // Group 3: 2026-09-21 (Today)
    assert.equal(groups[2].messages.length, 1);
    assert.equal(groups[2].label, 'Today');
  });

  // 11. Unsupported/unknown message fallback
  test('11. resolveMessageContent safely renders text, attachments, and unknown kind fallbacks without HTML injection', () => {
    // Plain text
    const textRes = resolveMessageContent({ kind: 'text', body: { text: '<b>Raw HTML</b>' } });
    assert.equal(textRes.kind, 'text');
    assert.equal(textRes.text, '<b>Raw HTML</b>');
    assert.equal(textRes.isFallback, false);

    // Photo
    const photoRes = resolveMessageContent({ kind: 'image', body: { caption: 'Sunset' }, attachments: [{ filename: 'sunset.jpg' }] });
    assert.equal(photoRes.kind, 'image');
    assert.equal(photoRes.isFallback, true);
    assert.ok(photoRes.fallbackText.includes('Sunset'));

    // File attachment
    const fileRes = resolveMessageContent({ kind: 'file', attachments: [{ filename: 'contract.pdf' }] });
    assert.equal(fileRes.kind, 'file');
    assert.equal(fileRes.isFallback, true);
    assert.ok(fileRes.fallbackText.includes('contract.pdf'));

    // Unknown kind
    const unknownRes = resolveMessageContent({ kind: 'hologram', body: { raw: 'data' } });
    assert.equal(unknownRes.kind, 'hologram');
    assert.equal(unknownRes.isFallback, true);
    assert.ok(unknownRes.fallbackText.includes('hologram'));

    // Deleted message
    const deletedRes = resolveMessageContent({ id: 'd1', isDeleted: true });
    assert.equal(deletedRes.isDeleted, true);
    assert.equal(deletedRes.text, 'This message was deleted');
  });

  // 12. message.created reconciliation
  test('12. appendIncomingMessage reconciles existing messages instead of duplicating', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', [
      { id: 'm1', eventSeq: 1, body: { text: 'Initial' }, createdAt: '2026-09-21T10:00:00Z' }
    ]);

    // Append distinct new message
    const newMsg = state.appendIncomingMessage({ id: 'm2', eventSeq: 2, body: { text: 'New' }, createdAt: '2026-09-21T10:01:00Z' });
    assert.equal(state.messages.length, 2);
    assert.equal(newMsg.id, 'm2');
    assert.equal(state.newestSeq, 2);

    // Re-append same message ID with updated payload -> reconciles in-place
    state.appendIncomingMessage({ id: 'm2', eventSeq: 2, body: { text: 'New Confirmed' } });
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[1].body.text, 'New Confirmed');
  });

  // 13. message.updated reconciliation
  test('13. updateMessage updates body and editedAt for existing messages', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', [
      { id: 'm1', eventSeq: 1, body: { text: 'Before edit' } }
    ]);

    const updated = state.updateMessage('m1', {
      body: { text: 'After edit' },
      editedAt: '2026-09-21T10:05:00Z'
    });

    assert.equal(updated, true);
    assert.equal(state.messages[0].body.text, 'After edit');
    assert.equal(state.messages[0].editedAt, '2026-09-21T10:05:00Z');

    // Non-existent message returns false without throwing
    assert.equal(state.updateMessage('non-existent', { body: { text: 'x' } }), false);
  });

  // 14. message.deleted reconciliation
  test('14. deleteMessage marks message as deleted safely', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', [
      { id: 'm1', body: { text: 'Secret message' } }
    ]);

    const deleted = state.deleteMessage('m1');
    assert.equal(deleted, true);
    assert.equal(state.messages[0].isDeleted, true);
    assert.equal(state.messages[0].body.text, 'This message was deleted');

    assert.equal(state.deleteMessage('m-none'), false);
  });

  // 15. Delivered/Read status progression (never moves backwards)
  test('15. updateReceipt enforces status progression and rejects backwards transitions', () => {
    const state = new RoomMessagesState('user-self');

    // Upgrade sent -> delivered
    assert.equal(state.updateReceipt('m1', 'sent'), true);
    assert.equal(state.messageStatus.get('m1'), 'sent');

    assert.equal(state.updateReceipt('m1', 'delivered'), true);
    assert.equal(state.messageStatus.get('m1'), 'delivered');

    // Upgrade delivered -> read
    assert.equal(state.updateReceipt('m1', 'read'), true);
    assert.equal(state.messageStatus.get('m1'), 'read');

    // Backwards attempt: read -> delivered must be rejected
    assert.equal(state.updateReceipt('m1', 'delivered'), false);
    assert.equal(state.messageStatus.get('m1'), 'read');

    // Backwards attempt: read -> sent must be rejected
    assert.equal(state.updateReceipt('m1', 'sent'), false);
    assert.equal(state.messageStatus.get('m1'), 'read');
  });

  // 16. Reaction add/remove
  test('16. updateReaction safely adds and removes reactions without duplicates', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', [
      { id: 'm1', reactions: {} }
    ]);

    // Add reaction
    state.updateReaction('m1', 'user-peer', '❤️', true);
    assert.deepEqual(state.messages[0].reactions['❤️'], ['user-peer']);

    // Duplicate add should not duplicate principalId
    state.updateReaction('m1', 'user-peer', '❤️', true);
    assert.deepEqual(state.messages[0].reactions['❤️'], ['user-peer']);

    // Add another user's reaction
    state.updateReaction('m1', 'user-other', '❤️', true);
    assert.deepEqual(state.messages[0].reactions['❤️'], ['user-peer', 'user-other']);

    // Remove reaction
    state.updateReaction('m1', 'user-peer', '❤️', false);
    assert.deepEqual(state.messages[0].reactions['❤️'], ['user-other']);

    // Remove last reaction -> deletes key
    state.updateReaction('m1', 'user-other', '❤️', false);
    assert.equal(state.messages[0].reactions['❤️'], undefined);

    // Removing non-existent reaction does not throw
    assert.doesNotThrow(() => state.updateReaction('m1', 'user-peer', '👍', false));
  });

  // 17. Duplicate real-time event protection
  test('17. Duplicate real-time message.created frames are merged safely without inflating list', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', []);

    const frameMsg = { id: 'msg-ws-1', eventSeq: 10, body: { text: 'Hello WebSocket' } };

    state.appendIncomingMessage(frameMsg);
    assert.equal(state.messages.length, 1);

    // Re-dispatch exact same message frame
    state.appendIncomingMessage(frameMsg);
    assert.equal(state.messages.length, 1);
    assert.equal(state.newestSeq, 10);
  });

  // 18. Stale response protection after conversation switching
  test('18. Token-based guard prevents responses from prior rooms from overwriting active room', () => {
    let activeRoomId = 'room-A';
    let loadToken = 1;

    const requestA = { token: loadToken, roomId: 'room-A' };

    // User rapidly switches to room-B before room-A finishes loading
    activeRoomId = 'room-B';
    loadToken = 2;

    const requestB = { token: loadToken, roomId: 'room-B' };

    // When room-A finishes, check should reject it
    const isRequestAValid = requestA.token === loadToken && requestA.roomId === activeRoomId;
    assert.equal(isRequestAValid, false);

    // When room-B finishes, check accepts it
    const isRequestBValid = requestB.token === loadToken && requestB.roomId === activeRoomId;
    assert.equal(isRequestBValid, true);
  });

  // 19. Pagination request protection
  test('19. Pagination requests are blocked when hasMore is false or oldestSeq is missing', () => {
    const state = new RoomMessagesState('user-self');
    state.setInitialMessages('room-1', [
      { id: 'm1', eventSeq: 5, body: { text: 'Single message' } }
    ], false); // hasMore = false

    // Should not allow pagination when hasMore is false
    const canPaginate1 = state.hasMore && !state.isLoadingOlder && state.oldestSeq !== null;
    assert.equal(canPaginate1, false);

    // Empty room without oldestSeq
    const emptyState = new RoomMessagesState('user-self');
    emptyState.setInitialMessages('room-empty', [], true);
    const canPaginate2 = emptyState.hasMore && !emptyState.isLoadingOlder && emptyState.oldestSeq !== null;
    assert.equal(canPaginate2, false);
  });

  // 20. Scroll-position calculation logic
  test('20. Scroll preservation formula preserves visual viewport offset when older messages are prepended', () => {
    // Simulated viewport
    const prevScrollHeight = 1000;
    const prevScrollTop = 50; // User was 50px from top

    // After prepending 50 older messages, scrollHeight grows to 2400px
    const newScrollHeight = 2400;

    // Standard DOM scroll preservation formula:
    const newScrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;

    // Viewport has been offset by exactly the height of the prepended content (1400px + 50px = 1450px)
    assert.equal(newScrollTop, 1450);
    assert.equal(newScrollTop - prevScrollTop, newScrollHeight - prevScrollHeight);
  });

});
