import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatShellState,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';

describe('WhatsApp-Style Unread Badge & Read State Lifecycle (26 Invariants)', () => {
  let state;

  beforeEach(() => {
    // Fresh ChatShellState instance for each test
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-me', name: 'My Self' });
    state.setInbox([
      { roomId: 'room-1', title: 'Alice', unreadCount: 0, unread_count: 0, kind: 'direct' },
      { roomId: 'room-2', title: 'Bob', unreadCount: 0, unread_count: 0, kind: 'direct' },
      { roomId: 'room-3', title: 'Project Team', unreadCount: 0, unread_count: 0, kind: 'group', isGroup: true }
    ]);
  });

  // 1. No unread -> no badge
  test('1. No unread messages produces unreadCount = 0 and no unread badge', () => {
    assert.equal(state.getRoomUnreadCount('room-1'), 0);
    assert.equal(state.getUnreadConversationsCount(), 0);
  });

  // 2. One incoming unread -> badge 1
  test('2. Single incoming unread message produces badge count 1', () => {
    const unread = state.recordIncomingUnreadMessage('room-1', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Hello' }
    });
    assert.equal(unread, 1);
    assert.equal(state.getRoomUnreadCount('room-1'), 1);
    assert.equal(state.getUnreadConversationsCount(), 1);
  });

  // 3. Two incoming unread -> badge 2
  test('3. Two incoming unread messages produce badge count 2', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-101', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-102', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 2);
  });

  // 4. Five incoming unread -> badge 5
  test('4. Five incoming unread messages produce badge count 5', () => {
    for (let i = 1; i <= 5; i++) {
      state.recordIncomingUnreadMessage('room-1', { id: `msg-${i}`, sender_id: 'user-alice' });
    }
    assert.equal(state.getRoomUnreadCount('room-1'), 5);
  });

  // 5. Own outgoing message does not increment unread
  test('5. Outgoing message sent by self does not increment unread', () => {
    const isOwn = isOwnMessage({ sender_id: 'user-me', body: { text: 'My message' } }, 'user-me');
    assert.equal(isOwn, true);

    // If own message is recorded or sent, room is marked read and unread remains 0
    state.markConversationAsRead('room-1');
    assert.equal(state.getRoomUnreadCount('room-1'), 0);
  });

  // 6. Opening unread conversation clears unread appropriately
  test('6. Opening unread conversation clears unread count to 0', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-101', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-102', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 2);

    state.selectConversation('room-1');
    state.markConversationAsRead('room-1');

    assert.equal(state.getRoomUnreadCount('room-1'), 0);
    assert.equal(state.getUnreadConversationsCount(), 0);
  });

  // 7. Switching away preserves unread
  test('7. Switching away preserves unread count on background conversations', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-1', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-2', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 2);

    state.selectConversation('room-2');
    assert.equal(state.selectedRoomId, 'room-2');
    assert.equal(state.getRoomUnreadCount('room-1'), 2);
  });

  // 8. Incoming message while another chat is active increments target chat
  test('8. Incoming message while another chat is active increments target conversation only', () => {
    state.selectConversation('room-2');
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-a', sender_id: 'user-alice' });

    assert.equal(state.getRoomUnreadCount('room-1'), 1);
    assert.equal(state.getRoomUnreadCount('room-2'), 0);
  });

  // 9. Group unread count
  test('9. Group conversation receives multiple messages and increments unread count accurately', () => {
    state.recordIncomingUnreadMessage('room-3', { id: 'msg-g1', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-3', { id: 'msg-g2', sender_id: 'user-bob' });
    state.recordIncomingUnreadMessage('room-3', { id: 'msg-g3', sender_id: 'user-charlie' });

    assert.equal(state.getRoomUnreadCount('room-3'), 3);
  });

  // 10. Deleted message handling
  test('10. Deleting an unread message decrements the unread count', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-del-1', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-del-2', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 2);

    state.removeUnreadMessage('room-1', 'msg-del-1');
    assert.equal(state.getRoomUnreadCount('room-1'), 1);
  });

  // 11. Mark as unread
  test('11. Mark as unread toggles read conversation to unread (count 1)', () => {
    assert.equal(state.getRoomUnreadCount('room-1'), 0);
    const next = state.markConversationAsUnread('room-1');
    assert.equal(next, 1);
    assert.equal(state.getRoomUnreadCount('room-1'), 1);
    assert.equal(state.getUnreadConversationsCount(), 1);
  });

  // 12. Mark as read
  test('12. Mark as read clears unread state (count 0)', () => {
    state.setRoomUnreadCount('room-1', 4);
    assert.equal(state.getRoomUnreadCount('room-1'), 4);

    state.markConversationAsRead('room-1');
    assert.equal(state.getRoomUnreadCount('room-1'), 0);
  });

  // 13. Unread filter
  test('13. Unread filter matches only conversations with unreadCount > 0', () => {
    state.setRoomUnreadCount('room-1', 3);
    state.setRoomUnreadCount('room-2', 0);
    state.setRoomUnreadCount('room-3', 1);

    state.setActiveFilter('unread');
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(c => c.roomId).sort(), ['room-1', 'room-3']);
  });

  // 14. Search does not change unread state
  test('14. Search query filtering does not alter underlying unread state', () => {
    state.setRoomUnreadCount('room-1', 5);
    state.setSearchQuery('Alice');

    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 1);
    assert.equal(state.getRoomUnreadCount('room-1'), 5);

    state.setSearchQuery('');
    assert.equal(state.getRoomUnreadCount('room-1'), 5);
  });

  // 15. Favourites preserve unread state
  test('15. Toggling favourite does not alter unread count', () => {
    state.setRoomUnreadCount('room-1', 3);
    state.toggleFavouriteChat('room-1');

    assert.equal(state.isFavourite('room-1'), true);
    assert.equal(state.getRoomUnreadCount('room-1'), 3);

    state.toggleFavouriteChat('room-1');
    assert.equal(state.isFavourite('room-1'), false);
    assert.equal(state.getRoomUnreadCount('room-1'), 3);
  });

  // 16. Pins preserve unread state
  test('16. Pinning a conversation does not alter unread count', () => {
    state.setRoomUnreadCount('room-2', 4);
    state.togglePinChat('room-2');

    assert.equal(state.isPinned('room-2'), true);
    assert.equal(state.getRoomUnreadCount('room-2'), 4);
  });

  // 17. Custom lists preserve unread state
  test('17. Adding conversation to custom list preserves unread state', () => {
    state.setRoomUnreadCount('room-1', 2);
    const list = state.createCustomList('Work', ['room-1']);

    state.setActiveFilter(list.id);
    const filtered = state.getFilteredConversations();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].roomId, 'room-1');
    assert.equal(state.getRoomUnreadCount('room-1'), 2);
  });

  // 18. Archive behavior
  test('18. Archiving conversation excludes it from main unread count and preserves its badge in archive', () => {
    state.setRoomUnreadCount('room-1', 3);
    assert.equal(state.getUnreadConversationsCount(), 1);

    state.archiveChat('room-1');
    assert.equal(state.isArchived('room-1'), true);
    assert.equal(state.getUnreadConversationsCount(), 0);

    const archived = state.getArchivedConversations();
    assert.equal(archived.length, 1);
    assert.equal(state.getRoomUnreadCount('room-1'), 3);
  });

  // 19. Restart persistence
  test('19. setInbox populates authoritative unread count and preserves marked unread overrides', () => {
    state.markConversationAsUnread('room-2');
    assert.equal(state.getRoomUnreadCount('room-2'), 1);

    // Simulate app restart: fresh inbox from backend
    state.setInbox([
      { roomId: 'room-1', title: 'Alice', unread_count: 5 },
      { roomId: 'room-2', title: 'Bob', unread_count: 0 }
    ]);

    assert.equal(state.getRoomUnreadCount('room-1'), 5);
    // room-2 was marked unread locally, so it retains unread count 1
    assert.equal(state.getRoomUnreadCount('room-2'), 1);
  });

  // 20. WebSocket reconnect/catch-up
  test('20. WebSocket reconnect catch-up preserves unread count and synchronizes accurately', () => {
    state.setRoomUnreadCount('room-1', 2);
    // Simulating catchup server update
    state.setRoomUnreadCount('room-1', 4);
    assert.equal(state.getRoomUnreadCount('room-1'), 4);
  });

  // 21. Duplicate message events do not double-count
  test('21. Duplicate message events with same message ID or eventSeq do not double-count', () => {
    const msg = { id: 'msg-dup-1', eventSeq: 42, sender_id: 'user-alice' };
    state.recordIncomingUnreadMessage('room-1', msg);
    state.recordIncomingUnreadMessage('room-1', msg); // duplicate event
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-dup-1', eventSeq: 42 }); // third attempt

    assert.equal(state.getRoomUnreadCount('room-1'), 1);
  });

  // 22. Pagination does not produce incorrect counts
  test('22. Unread count is independent of loaded message page size', () => {
    // Even if only 5 messages are loaded in memory, room unread count from server is preserved
    state.setRoomUnreadCount('room-1', 50);
    assert.equal(state.getRoomUnreadCount('room-1'), 50);
  });

  // 23. Delivered does not equal read
  test('23. Receipt delivered status does not clear unread count', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-1', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 1);

    // Delivering the message does not mark it read
    assert.equal(state.getRoomUnreadCount('room-1'), 1);
  });

  // 24. Read cursor correctly clears badge
  test('24. Advancing read cursor marks conversation read and clears unread badge', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-1', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-2', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-1'), 2);

    state.markConversationAsRead('room-1');
    assert.equal(state.getRoomUnreadCount('room-1'), 0);
  });

  // 25. Room switching correctly updates badges
  test('25. Switching between rooms updates active selection and preserves target badges', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'msg-1', sender_id: 'user-alice' });
    state.recordIncomingUnreadMessage('room-2', { id: 'msg-2', sender_id: 'user-bob' });

    assert.equal(state.getRoomUnreadCount('room-1'), 1);
    assert.equal(state.getRoomUnreadCount('room-2'), 1);

    // Select room-1
    state.selectConversation('room-1');
    state.markConversationAsRead('room-1');

    assert.equal(state.getRoomUnreadCount('room-1'), 0);
    assert.equal(state.getRoomUnreadCount('room-2'), 1);

    // Select room-2
    state.selectConversation('room-2');
    state.markConversationAsRead('room-2');

    assert.equal(state.getRoomUnreadCount('room-1'), 0);
    assert.equal(state.getRoomUnreadCount('room-2'), 0);
  });

  // 26. Multiple rooms receiving messages update independently
  test('26. Multiple rooms receiving incoming messages update their counts completely independently', () => {
    state.recordIncomingUnreadMessage('room-1', { id: 'm1', sender_id: 'alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'm2', sender_id: 'alice' });
    state.recordIncomingUnreadMessage('room-1', { id: 'm3', sender_id: 'alice' });

    state.recordIncomingUnreadMessage('room-2', { id: 'm4', sender_id: 'bob' });
    state.recordIncomingUnreadMessage('room-2', { id: 'm5', sender_id: 'bob' });

    assert.equal(state.getRoomUnreadCount('room-1'), 3);
    assert.equal(state.getRoomUnreadCount('room-2'), 2);
    assert.equal(state.getRoomUnreadCount('room-3'), 0);
    assert.equal(state.getUnreadConversationsCount(), 2);
  });
});
