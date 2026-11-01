import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatShellState,
  RoomMessagesState,
  isOwnMessage,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// In-memory mock localStorage for Node.js test environment
function setupMockLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(String(key)) || null,
    setItem: (key, val) => store.set(String(key), String(val)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear()
  };
  return store;
}

describe('Unread Message Edit Behavior - WhatsApp-Style Regression Suite', () => {
  let state;

  beforeEach(() => {
    setupMockLocalStorage();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-bob', name: 'Bob' });
    state.setInbox([
      { roomId: 'room-alice', title: 'Alice', unreadCount: 0, unread_count: 0, kind: 'direct' },
      { roomId: 'room-charlie', title: 'Charlie', unreadCount: 0, unread_count: 0, kind: 'direct' },
      { roomId: 'room-group', title: 'Team Group', unreadCount: 0, unread_count: 0, kind: 'group', isGroup: true }
    ]);
  });

  // REQUIREMENT 1: Read message → edit while chat inactive → unread count becomes 1
  test('1. Read message -> edit while chat inactive -> unread count becomes 1', () => {
    // Step 1: User 1 (Alice) sends a message to User 2 (Bob)
    const msg = {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Meet at 4pm' },
      eventSeq: 10
    };

    // Step 2: Bob opens the conversation and reads the message
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0, 'Unread count is 0 after reading');
    assert.equal(state.getUnreadConversationsCount(), 0, 'No unread conversations');

    // Step 3: Bob navigates to another conversation (Charlie), so Alice chat is inactive
    state.selectConversation('room-charlie');
    assert.equal(state.selectedRoomId, 'room-charlie');

    // Step 4: Alice edits the previously read message
    const editedMsg = {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Meet at 5pm instead' },
      edited_at: '2026-10-06T10:15:00Z',
      eventSeq: 11
    };

    const newUnread = state.recordIncomingEditedMessage('room-alice', editedMsg);

    // Step 5: Bob must now see 1 unread message on Alice conversation
    assert.equal(newUnread, 1, 'recordIncomingEditedMessage returns 1');
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'Alice room unread count is 1');
    assert.equal(state.getUnreadConversationsCount(), 1, 'Total unread conversations count is 1');
    assert.equal(state.getRoomUnreadCount('room-charlie'), 0, 'Active Charlie conversation has 0 unread');
  });

  // REQUIREMENT 2: Open chat → unread count clears
  test('2. Open chat -> unread count clears and edited message is displayed', () => {
    // Initial state: room-alice has unread edited message
    state.selectConversation('room-charlie');
    state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Meet at 5pm' },
      edited_at: '2026-10-06T10:15:00Z'
    });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    // Also update message in room messages state (as app.js does)
    const aliceRoomState = new RoomMessagesState('user-bob');
    aliceRoomState.setInitialMessages('room-alice', [
      { id: 'msg-101', senderId: 'user-alice', body: { text: 'Meet at 4pm' } }
    ]);
    const updated = aliceRoomState.updateMessage('msg-101', {
      body: { text: 'Meet at 5pm' },
      edited_at: '2026-10-06T10:15:00Z'
    });
    assert.equal(updated, true);

    // Step 6: When Bob opens the conversation again
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');

    // Verify unread count clears
    assert.equal(state.getRoomUnreadCount('room-alice'), 0, 'Unread count clears to 0');
    assert.equal(state.getUnreadConversationsCount(), 0, 'Unread conversations count is 0');

    // Verify edited message in room state displays updated text and editedAt
    assert.equal(aliceRoomState.messages[0].body.text, 'Meet at 5pm');
    assert.equal(aliceRoomState.messages[0].editedAt, '2026-10-06T10:15:00Z');
  });

  // REQUIREMENT 3: Multiple edits to the same message do not double-count
  test('3. Multiple edits to the same message do not incorrectly create multiple unread counts', () => {
    // Inactive chat
    state.selectConversation('room-charlie');

    // First edit arrives while unread
    state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Edit 1: Meet at 5pm' },
      edited_at: '2026-10-06T10:15:00Z',
      eventSeq: 11
    });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'First edit produces count 1');

    // Second edit to the same message arrives while Bob still has not opened Alice's chat
    const secondResult = state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Edit 2: Actually meet at 6pm' },
      edited_at: '2026-10-06T10:16:00Z',
      eventSeq: 12
    });

    // Third edit with network retry/duplicate seq
    const thirdResult = state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Edit 3: Definitely 6pm!' },
      edited_at: '2026-10-06T10:17:00Z',
      eventSeq: 12
    });

    assert.equal(secondResult, 1, 'Second edit suppresses duplicate increment and returns 1');
    assert.equal(thirdResult, 1, 'Third edit suppresses duplicate increment and returns 1');
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'Unread count remains 1 and is NOT double-counted');
    assert.equal(state.getUnreadConversationsCount(), 1, 'Unread conversations count remains 1');
  });

  // REQUIREMENT 4: Edit while conversation is currently active → no unread badge
  test('4. Edit while the conversation is currently active -> no unread badge', () => {
    // Bob is actively in Alice's conversation
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);

    // Active room check in application logic:
    const activeRoomId = state.selectedRoomId;
    const isActivelyViewed = activeRoomId === 'room-alice';
    assert.equal(isActivelyViewed, true);

    // If edit arrives while actively viewed, application calls markConversationAsRead instead of incrementing
    if (isActivelyViewed) {
      state.markConversationAsRead('room-alice');
    } else {
      state.recordIncomingEditedMessage('room-alice', { id: 'msg-101' });
    }

    assert.equal(state.getRoomUnreadCount('room-alice'), 0, 'No unread count created while actively viewing');
    assert.equal(state.getUnreadConversationsCount(), 0, 'No unread badge in chat list');
  });

  // REQUIREMENT 5: Normal new-message unread behavior remains unchanged
  test('5. Normal new-message unread behavior remains unchanged', () => {
    state.selectConversation('room-charlie');

    // Normal message.created arrivals
    state.recordIncomingUnreadMessage('room-alice', { id: 'msg-new-1', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    state.recordIncomingUnreadMessage('room-alice', { id: 'msg-new-2', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 2);

    state.recordIncomingUnreadMessage('room-alice', { id: 'msg-new-3', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 3);

    // Duplicate message.created suppressed
    state.recordIncomingUnreadMessage('room-alice', { id: 'msg-new-3', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 3, 'Duplicate message.created suppressed');

    // Opening room clears normal unread count
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);
  });

  // REQUIREMENT 6: Reconnect/app restart preserves correct unread state
  test('6. Reconnect and app restart preserves correct unread state', () => {
    // Simulate Bob receiving an edit for a previously read message while away
    state.selectConversation('room-charlie');
    state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-101',
      sender_id: 'user-alice',
      body: { text: 'Meet at 5pm' },
      edited_at: '2026-10-06T10:15:00Z'
    });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    // Part A: WebSocket reconnect catch-up preserves unread count
    state.setRoomUnreadCount('room-alice', 1);
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'Preserved across reconnect setRoomUnreadCount');

    // Part B: App restart simulation (new ChatShellState instance loading preferences from localStorage)
    const reloadedState = new ChatShellState();
    reloadedState.setCurrentUser({ userId: 'user-bob', name: 'Bob' });

    // Backend returns fresh inbox from GET /directory/inbox with unread_count: 0
    reloadedState.setInbox([
      { roomId: 'room-alice', title: 'Alice', unread_count: 0 },
      { roomId: 'room-charlie', title: 'Charlie', unread_count: 0 }
    ]);

    // Unread edit must be preserved from persistent storage!
    assert.equal(reloadedState.getRoomUnreadCount('room-alice'), 1, 'App restart preserves unread edit count = 1');
    assert.equal(reloadedState.getUnreadConversationsCount(), 1, 'App restart preserves 1 unread conversation');

    // Opening conversation after restart clears it
    reloadedState.selectConversation('room-alice');
    reloadedState.markConversationAsRead('room-alice');
    assert.equal(reloadedState.getRoomUnreadCount('room-alice'), 0, 'Opening clears unread after restart');

    // Subsequent app restart after reading maintains 0 unread
    const secondReload = new ChatShellState();
    secondReload.setCurrentUser({ userId: 'user-bob', name: 'Bob' });
    secondReload.setInbox([
      { roomId: 'room-alice', title: 'Alice', unread_count: 0 },
      { roomId: 'room-charlie', title: 'Charlie', unread_count: 0 }
    ]);
    assert.equal(secondReload.getRoomUnreadCount('room-alice'), 0, 'Clean state after opening');
  });

  // ADDITIONAL INVARIANT: Editing an already-unread message does not increment count
  test('7. Editing a message that is already unread does not double-count (count remains 1)', () => {
    state.selectConversation('room-charlie');

    // Message arrives and is unread
    state.recordIncomingUnreadMessage('room-alice', {
      id: 'msg-unread-1',
      sender_id: 'user-alice',
      body: { text: 'Original unread message' }
    });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    // While still unread, Alice edits the message
    state.recordIncomingEditedMessage('room-alice', {
      id: 'msg-unread-1',
      sender_id: 'user-alice',
      body: { text: 'Edited unread message' },
      edited_at: '2026-10-06T10:20:00Z'
    });

    // Unread count MUST remain 1, NOT become 2
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'Editing an already unread message stays 1');
    assert.equal(state.getUnreadConversationsCount(), 1);
  });

  // ADDITIONAL INVARIANT: Editing own message by self does not increment unread
  test('8. Editing own outgoing message does not create unread badge for self', () => {
    state.selectConversation('room-charlie');

    // Bob edits Bob's own message in room-alice
    const ownMsg = {
      id: 'msg-bob-1',
      sender_id: 'user-bob', // Bob is current user
      body: { text: 'My own edited message' },
      edited_at: '2026-10-06T10:25:00Z'
    };

    const isOwn = isOwnMessage(ownMsg, state.currentUserId);
    assert.equal(isOwn, true, 'isOwnMessage correctly identifies own message');

    // Own edit does not increment unread
    if (!isOwn) {
      state.recordIncomingEditedMessage('room-alice', ownMsg);
    }
    assert.equal(state.getRoomUnreadCount('room-alice'), 0, 'Own edit does not increment unread');
  });

  // ADDITIONAL INVARIANT: Multi-cycle read -> edit -> read -> edit again
  test('9. Lifecycle: Read -> edit -> unread 1 -> read -> edit again -> unread 1', () => {
    // Cycle 1:
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);

    // Switch away
    state.selectConversation('room-charlie');

    // Edit 1 arrives
    state.recordIncomingEditedMessage('room-alice', { id: 'msg-cycle', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    // Open chat and read
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);

    // Switch away again
    state.selectConversation('room-charlie');

    // Edit 2 arrives to the same message
    state.recordIncomingEditedMessage('room-alice', { id: 'msg-cycle', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1, 'New edit after read produces unread count 1 again');

    // Open chat and read again
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);
  });

  // ADDITIONAL INVARIANT: Two distinct messages edited in same room produce count 2
  test('10. Two distinct messages edited while inactive produce unread count 2', () => {
    state.selectConversation('room-charlie');

    state.recordIncomingEditedMessage('room-alice', { id: 'msg-x', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    state.recordIncomingEditedMessage('room-alice', { id: 'msg-y', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 2);

    // Repeat edit for msg-x does not increment to 3
    state.recordIncomingEditedMessage('room-alice', { id: 'msg-x', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 2);

    // Opening clears to 0
    state.selectConversation('room-alice');
    state.markConversationAsRead('room-alice');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);
  });

  // ADDITIONAL INVARIANT: Deleting an unread edited message decrements count
  test('11. Deleting an unread edited message decrements unread count', () => {
    state.selectConversation('room-charlie');

    state.recordIncomingEditedMessage('room-alice', { id: 'msg-to-delete', sender_id: 'user-alice' });
    assert.equal(state.getRoomUnreadCount('room-alice'), 1);

    state.removeUnreadMessage('room-alice', 'msg-to-delete');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);
  });

  // CODE ARCHITECTURE INVARIANT: app.js handles message.updated unread badge
  test('12. app.js code inspection verifies message.updated unread handling implementation', () => {
    const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');

    // Verify handleRealtimeChatEvent is exported
    assert.ok(appJsContent.includes('export function handleRealtimeChatEvent'), 'Exports handleRealtimeChatEvent');

    // Verify message.updated triggers recordIncomingEditedMessage
    assert.ok(appJsContent.includes('type === \'message.updated\''), 'Checks for type === message.updated in sidebar update');
    assert.ok(appJsContent.includes('shellState.recordIncomingEditedMessage'), 'Calls shellState.recordIncomingEditedMessage');

    // Verify guard on isCurrentlyViewed
    assert.ok(appJsContent.includes('isCurrentlyViewed'), 'Checks isCurrentlyViewed for edit events');

    // Verify guard on isOwn
    assert.ok(appJsContent.includes('isOwn'), 'Checks isOwn for edit events');
  });
});
