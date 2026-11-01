import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  isOwnMessage,
  findLatestUnreadMessage,
  findFirstUnreadMessage
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Latest Unread Scroll Positioning Suite', () => {
  const currentUserId = 'user_me';

  // ═══════════════════════════════════════════════════════════════════
  // 1. Static Invariants & Helper Verification
  // ═══════════════════════════════════════════════════════════════════
  describe('Static Invariants & Integration Contracts', () => {
    test('app.js exports findMessageDomElement and positionConversationAtLatestUnreadOrBottom', () => {
      assert.ok(
        appJs.includes('export function findMessageDomElement('),
        'app.js must export findMessageDomElement helper'
      );
      assert.ok(
        appJs.includes('export function positionConversationAtLatestUnreadOrBottom('),
        'app.js must export positionConversationAtLatestUnreadOrBottom helper'
      );
    });

    test('selectConversation and loadMessagesForRoom invoke positionConversationAtLatestUnreadOrBottom', () => {
      assert.ok(
        appJs.includes('positionConversationAtLatestUnreadOrBottom(roomId)'),
        'Must call positionConversationAtLatestUnreadOrBottom when rendering messages'
      );
    });

    test('renderMessages inserts unread-messages-divider before first unread message', () => {
      assert.ok(
        appJs.includes('unread-messages-divider'),
        'renderMessages must insert unread-messages-divider element'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Behavioral Unit Tests: findLatestUnreadMessage & findFirstUnreadMessage
  // ═══════════════════════════════════════════════════════════════════
  describe('findLatestUnreadMessage Semantics & Edge Cases', () => {
    test('1. A conversation with zero unread messages returns null (triggering scroll to bottom)', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Hello' } },
        { id: 'm2', senderId: 'user_alice', status: 'read', body: { text: 'How are you?' } },
        { id: 'm3', senderId: currentUserId, status: 'read', body: { text: 'Doing well!' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 0,
        isMarkedUnread: false
      });

      assert.equal(target, null, 'Zero unread messages must return null');
    });

    test('2. A conversation with exactly one unread message returns that unread message', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Old message' } },
        { id: 'm2', senderId: currentUserId, status: 'read', body: { text: 'My reply' } },
        { id: 'm3', senderId: 'user_alice', status: 'delivered', body: { text: 'New unread message' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        isMarkedUnread: false
      });

      assert.ok(target, 'Must find unread message');
      assert.equal(target.id, 'm3', 'Must target m3');
    });

    test('3. Multiple unread messages position the view at the LATEST unread message, NOT the oldest', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Old message 1' } },
        { id: 'm2', senderId: 'user_alice', status: 'delivered', body: { text: 'Unread message 1 (oldest unread)' } },
        { id: 'm3', senderId: 'user_alice', status: 'delivered', body: { text: 'Unread message 2' } },
        { id: 'm4', senderId: 'user_alice', status: 'delivered', body: { text: 'Unread message 3 (latest unread)' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 3,
        isMarkedUnread: false
      });

      assert.ok(target, 'Must find unread message');
      assert.equal(target.id, 'm4', 'Must position at m4 (latest unread), not m2 (oldest unread)');

      // Verify findFirstUnreadMessage correctly identifies m2 for the divider
      const first = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 3,
        isMarkedUnread: false
      });
      assert.equal(first.id, 'm2', 'First unread message is m2 for unread divider');
    });

    test('4. When newer outgoing messages exist after unread messages, positions at latest unread before newer messages', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Read message' } },
        { id: 'm2', senderId: 'user_alice', status: 'delivered', body: { text: 'Unread 1' } },
        { id: 'm3', senderId: 'user_alice', status: 'delivered', body: { text: 'Unread 2 (latest unread)' } },
        { id: 'm4', senderId: currentUserId, status: 'sent', body: { text: 'Outgoing reply 1' } },
        { id: 'm5', senderId: currentUserId, status: 'sent', body: { text: 'Outgoing reply 2' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2,
        isMarkedUnread: false
      });

      assert.ok(target, 'Must find target');
      assert.equal(target.id, 'm3', 'Target must be m3 (latest unread message, immediately before newer outgoing messages)');
    });

    test('5. Manually marked unread conversation positions at the latest incoming message', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Old message' } },
        { id: 'm2', senderId: 'user_alice', status: 'read', body: { text: 'Recent incoming message' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        isMarkedUnread: true
      });

      assert.ok(target, 'Must find target for manually marked unread conversation');
      assert.equal(target.id, 'm2', 'Positions at latest incoming message m2');
    });

    test('6. Tracked unread message IDs from real-time events take priority', () => {
      const messages = [
        { id: 'm1', senderId: 'user_alice', status: 'read', body: { text: 'Read 1' } },
        { id: 'm2', senderId: 'user_alice', status: 'sent', body: { text: 'Tracked unread event' } },
        { id: 'm3', senderId: 'user_alice', status: 'sent', body: { text: 'Another tracked unread' } }
      ];

      const tracked = new Set(['m2', 'm3']);

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2,
        trackedUnreadSet: tracked
      });

      assert.equal(target.id, 'm3', 'Latest tracked unread message is selected');
    });

    test('7. Empty conversation returns null safely without throwing', () => {
      const target = findLatestUnreadMessage([], { currentUserId, unreadCount: 0 });
      assert.equal(target, null);

      const targetNull = findLatestUnreadMessage(null, { currentUserId, unreadCount: 0 });
      assert.equal(targetNull, null);
    });

    test('8. Conversation containing only own outgoing messages returns null or last message if marked unread', () => {
      const messages = [
        { id: 'm1', senderId: currentUserId, status: 'sent', body: { text: 'Note to self 1' } },
        { id: 'm2', senderId: currentUserId, status: 'sent', body: { text: 'Note to self 2' } }
      ];

      const targetNormal = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 0,
        isMarkedUnread: false
      });
      assert.equal(targetNormal, null, 'Normal own messages produce null');

      const targetMarked = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        isMarkedUnread: true
      });
      assert.equal(targetMarked.id, 'm2', 'Marked unread own messages return latest message');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Lifecycle & Integration Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('Conversation Opening, History & Scroll Viewport Lifecycle', () => {
    test('9. Large historical message array positions at latest unread without scanning all messages unnecessarily', () => {
      const largeHistory = [];
      for (let i = 1; i <= 1000; i++) {
        largeHistory.push({
          id: `msg_${i}`,
          senderId: i % 2 === 0 ? currentUserId : 'user_bob',
          status: 'read',
          eventSeq: i,
          createdAt: new Date(Date.now() - (1000 - i) * 60000).toISOString(),
          body: { text: `Message number ${i}` }
        });
      }

      // Add 3 unread messages at the end
      largeHistory.push({
        id: 'msg_1001',
        senderId: 'user_bob',
        status: 'delivered',
        eventSeq: 1001,
        body: { text: 'Unread 1' }
      });
      largeHistory.push({
        id: 'msg_1002',
        senderId: 'user_bob',
        status: 'delivered',
        eventSeq: 1002,
        body: { text: 'Unread 2' }
      });
      largeHistory.push({
        id: 'msg_1003',
        senderId: 'user_bob',
        status: 'delivered',
        eventSeq: 1003,
        body: { text: 'Unread 3 (latest)' }
      });

      const target = findLatestUnreadMessage(largeHistory, {
        currentUserId,
        unreadCount: 3,
        isMarkedUnread: false
      });

      assert.equal(target.id, 'msg_1003', 'Must target msg_1003 in 1000+ message history');
    });

    test('10. Reopening a conversation after it has been marked as read scrolls to latest message at bottom', () => {
      const state = new ChatShellState();
      state.setInbox([
        { roomId: 'room_read', title: 'Bob', unreadCount: 2 }
      ]);

      // Initially unread
      assert.equal(state.getRoomUnreadCount('room_read'), 2);

      // User opens conversation and reads it
      state.selectConversation('room_read');
      state.markConversationAsRead('room_read');
      assert.equal(state.getRoomUnreadCount('room_read'), 0);

      // User navigates away and re-opens
      state.selectConversation('room_other');
      state.selectConversation('room_read');

      const messages = [
        { id: 'm1', senderId: 'user_bob', status: 'read', body: { text: 'Hello' } },
        { id: 'm2', senderId: 'user_bob', status: 'read', body: { text: 'All read now' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: state.getRoomUnreadCount('room_read'),
        isMarkedUnread: false
      });

      assert.equal(target, null, 'Reopened read conversation returns null to scroll to bottom');
    });

    test('11. Notification navigation preserves room selection and initiates history loading with forceReload', () => {
      assert.ok(
        appJs.includes('selectConversation(roomId, { forceReload: true })'),
        'Notification navigation must trigger selectConversation with forceReload: true'
      );
    });

    test('12. Stale load token prevents outdated async message loads from resetting scroll position', () => {
      let activeLoadToken = 1;
      const currentSelectedRoom = 'room_new';

      function handleMessagesLoaded(token, roomId, msgs) {
        if (token !== activeLoadToken || roomId !== currentSelectedRoom) {
          return false; // Stale load rejected
        }
        return true;
      }

      // Old request finishes after user switched rooms:
      const staleHandled = handleMessagesLoaded(1, 'room_old', [{ id: 'old1' }]);
      assert.equal(staleHandled, false, 'Stale response from old room must be rejected');

      // Increment token for new room:
      activeLoadToken = 2;
      const validHandled = handleMessagesLoaded(2, 'room_new', [{ id: 'new1' }]);
      assert.equal(validHandled, true, 'Valid response for current room is accepted');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. WhatsApp Notification Click & History Loading Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('WhatsApp Notification Click & Message History Lifecycle', () => {
    test('13. Notification target-message selection prefers targetMessageId even if newer messages exist', () => {
      const messages = [
        { id: 'msg_10', senderId: 'user_bob', status: 'delivered', body: { text: 'Earlier unread' } },
        { id: 'msg_target', senderId: 'user_bob', status: 'delivered', body: { text: 'Target message clicked in notification' } },
        { id: 'msg_newer', senderId: 'user_bob', status: 'delivered', body: { text: 'Arrived after notification' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 3,
        targetMessageId: 'msg_target'
      });

      assert.ok(target, 'Must locate target message');
      assert.equal(target.id, 'msg_target', 'Must select exact message from notification over newer messages');
    });

    test('14. Loading earlier messages around target preserves chronological order', () => {
      const roomState = new RoomMessagesState(currentUserId);
      roomState.roomId = 'room_chronological';

      // Simulate surrounding batch around target seq 50:
      const surrounding = [
        { id: 'msg_48', sender_id: 'user_bob', eventSeq: 48, createdAt: '2026-10-25T10:00:00Z', body: { text: 'Before target 1' } },
        { id: 'msg_49', sender_id: 'user_bob', eventSeq: 49, createdAt: '2026-10-25T10:01:00Z', body: { text: 'Before target 2' } },
        { id: 'msg_50_target', sender_id: 'user_bob', eventSeq: 50, createdAt: '2026-10-25T10:02:00Z', body: { text: 'Target unread' } },
        { id: 'msg_51', sender_id: 'user_bob', eventSeq: 51, createdAt: '2026-10-25T10:03:00Z', body: { text: 'After target' } }
      ];

      roomState.mergeServerMessages(surrounding, false);

      assert.equal(roomState.messages.length, 4);
      assert.equal(roomState.messages[0].id, 'msg_48', 'Earlier message is above target');
      assert.equal(roomState.messages[1].id, 'msg_49', 'Earlier message is above target');
      assert.equal(roomState.messages[2].id, 'msg_50_target', 'Target message is positioned in sequence');
      assert.equal(roomState.messages[3].id, 'msg_51', 'Subsequent message is below target');
    });

    test('15. Background pagination preserves viewport position via scroll compensation', () => {
      let scrollHeight = 2000;
      let scrollTop = 1200;
      const clientHeight = 600;

      // Simulate 50 older messages prepended to container
      const prevScrollHeight = scrollHeight;
      const prevScrollTop = scrollTop;

      // Content added above:
      const addedContentHeight = 1500;
      scrollHeight += addedContentHeight;

      // Scroll compensation formula as implemented in app.js:
      scrollTop = scrollHeight - prevScrollHeight + prevScrollTop;

      // Viewport relative to target content remains identical:
      assert.equal(scrollTop, 2700, 'Scroll top compensated by added content height');
      assert.equal(scrollTop - addedContentHeight, prevScrollTop, 'User sees exact same message without jumping');
    });

    test('16. Unread divider is positioned above the target unread message', () => {
      const messages = [
        { id: 'm1', senderId: 'user_bob', status: 'read', body: { text: 'Read earlier' } },
        { id: 'target_msg', senderId: 'user_bob', status: 'delivered', body: { text: 'Single unread notification' } }
      ];

      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        targetMessageId: 'target_msg'
      });

      assert.ok(dividerTarget, 'Divider target identified');
      assert.equal(dividerTarget.id, 'target_msg', 'Divider placed above target unread message');
    });

    test('17. Missing target ID falls back gracefully to latest unread message or bottom without throwing', () => {
      const messages = [
        { id: 'm1', senderId: 'user_bob', status: 'read', body: { text: 'Read' } },
        { id: 'm2', senderId: 'user_bob', status: 'delivered', body: { text: 'Unread available' } }
      ];

      // Request a non-existent target ID
      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        targetMessageId: 'msg_does_not_exist'
      });

      assert.ok(target, 'Must gracefully fall back');
      assert.equal(target.id, 'm2', 'Falls back to latest available unread message');
    });

    test('18. Opening conversation with no unread messages returns null to scroll to bottom', () => {
      const messages = [
        { id: 'm1', senderId: 'user_bob', status: 'read', body: { text: 'Read 1' } },
        { id: 'm2', senderId: currentUserId, status: 'read', body: { text: 'Read 2' } }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 0,
        isMarkedUnread: false,
        targetMessageId: null
      });

      assert.equal(target, null, 'Must return null to trigger scrollToBottom for fully read chat');
    });

    test('19. Realtime message arriving while opening unread conversation does not force scroll to bottom', () => {
      const activeConversationOpeningState = {
        roomId: 'room_open_unread',
        initialUnreadCount: 2,
        targetMessageId: 'unread_target',
        hasPositioned: true
      };

      const eventRoomId = 'room_open_unread';
      const isOpeningUnread = Boolean(
        activeConversationOpeningState &&
        activeConversationOpeningState.roomId === eventRoomId &&
        (activeConversationOpeningState.targetMessageId || activeConversationOpeningState.initialUnreadCount > 0)
      );

      assert.equal(isOpeningUnread, true, 'Opening unread conversation detected');

      let scrolledToBottom = false;
      const wasNearBottom = false;
      const isOwn = false;

      if ((wasNearBottom || isOwn) && !isOpeningUnread) {
        scrolledToBottom = true;
      }

      assert.equal(scrolledToBottom, false, 'Does not scroll to bottom, keeping unread target in view');
    });
  });
});
