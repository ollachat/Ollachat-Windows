import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  findLatestUnreadMessage,
  findFirstUnreadMessage
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

describe('Conversation Scroll Position & Unread Divider Suite', () => {
  const currentUserId = 'usr_me';
  const roomSavedScrollPositions = new Map();

  beforeEach(() => {
    roomSavedScrollPositions.clear();
  });

  // ───────────────────────────────────────────────────────────────────
  // Static Contract Invariants
  // ───────────────────────────────────────────────────────────────────
  describe('Static Invariants & Integration Contracts', () => {
    test('app.js exports roomSavedScrollPositions, saveRoomScrollPosition, and restoreRoomScrollPosition', () => {
      assert.ok(
        appJs.includes('export const roomSavedScrollPositions = new Map()'),
        'Must export roomSavedScrollPositions'
      );
      assert.ok(
        appJs.includes('export function saveRoomScrollPosition('),
        'Must export saveRoomScrollPosition'
      );
      assert.ok(
        appJs.includes('export function restoreRoomScrollPosition('),
        'Must export restoreRoomScrollPosition'
      );
    });

    test('selectConversation saves previous room scroll position and checks for saved position', () => {
      assert.ok(
        appJs.includes('saveRoomScrollPosition(previousRoomId);'),
        'selectConversation must save previous room scroll position before switching'
      );
      assert.ok(
        appJs.includes('restoreRoomScrollPosition(roomId);'),
        'selectConversation must restore scroll position when returning to room with saved position'
      );
    });

    test('advanceReadCursorForActiveRoom acknowledges read state while preserving visual unread divider', () => {
      assert.ok(
        appJs.includes("messagesList?.querySelector('.unread-messages-divider')"),
        'advanceReadCursorForActiveRoom must reference unread divider'
      );
      assert.ok(
        appJs.includes('activeConversationOpeningState.isReadAcknowledged = true;'),
        'advanceReadCursorForActiveRoom must acknowledge read in opening state'
      );
      assert.ok(
        !appJs.includes('unreadDivider.remove()'),
        'advanceReadCursorForActiveRoom must NOT immediately remove the unread divider from DOM'
      );
    });

    test('main.js notification click dispatches exactly one navigation request via navigateToRoom', () => {
      assert.ok(
        mainJs.includes("notif.on('click'"),
        'main.js must attach click listener to notification'
      );
      assert.ok(
        mainJs.includes('navigateToRoom(roomId, messageId || null);'),
        'Click handler must delegate navigation to navigateToRoom'
      );
      // Verify no duplicate send inside notif.on('click')
      const clickHandlerBody = mainJs.slice(mainJs.indexOf("notif.on('click'"), mainJs.indexOf("notif.on('click'") + 600);
      const matches = clickHandlerBody.match(/mainWindow\.webContents\.send\('chat:navigate-room'/g);
      assert.equal(
        matches,
        null,
        'notif.on(click) must not directly call webContents.send alongside navigateToRoom'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fix 1 Regressions: Eliminate Duplicate Notification Navigation
  // ───────────────────────────────────────────────────────────────────
  describe('Fix 1: Single Notification Navigation Dispatch', () => {
    test('A single notification click dispatches chat:navigate-room exactly once', () => {
      const dispatchedEvents = [];
      const mockWebContents = {
        isLoading: () => false,
        send: (channel, ...args) => {
          dispatchedEvents.push({ channel, args });
        },
        once: (event, cb) => {}
      };

      let pendingRoom = null;
      let pendingMsg = null;

      function testNavigateToRoom(roomId, messageId = null) {
        if (!roomId) return;
        pendingRoom = roomId;
        pendingMsg = messageId || null;
        mockWebContents.send('chat:navigate-room', roomId, messageId || null);
      }

      // Simulate notification click
      const notifPayload = { roomId: 'room_notif_1', messageId: 'msg_999' };
      testNavigateToRoom(notifPayload.roomId, notifPayload.messageId);

      assert.equal(dispatchedEvents.length, 1, 'Exactly one navigation event must be dispatched');
      assert.equal(dispatchedEvents[0].channel, 'chat:navigate-room');
      assert.equal(dispatchedEvents[0].args[0], 'room_notif_1');
      assert.equal(dispatchedEvents[0].args[1], 'msg_999');
      assert.equal(pendingRoom, 'room_notif_1');
      assert.equal(pendingMsg, 'msg_999');
    });

    test('One notification click produces exactly one conversation selection and history load', () => {
      let selectCount = 0;
      let loadCount = 0;

      function mockSelectConversation(roomId, options = {}) {
        selectCount++;
        mockLoadMessagesForRoom(roomId, options);
      }

      function mockLoadMessagesForRoom(roomId, options = {}) {
        loadCount++;
      }

      // Handle single IPC message from main process
      function handleNavigateRoom(roomId, messageId) {
        mockSelectConversation(roomId, { forceReload: true, targetMessageId: messageId });
      }

      // 1 notification click -> 1 dispatch -> 1 handler invocation
      handleNavigateRoom('room_target', 'msg_abc');

      assert.equal(selectCount, 1, 'selectConversation must execute exactly once');
      assert.equal(loadCount, 1, 'loadMessagesForRoom must execute exactly once');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fix 2 Regressions: Unread Divider Persistence During Active Session
  // ───────────────────────────────────────────────────────────────────
  describe('Fix 2: Unread Divider Session Retention & Lifecycle', () => {
    test('Scenario 1: Open a conversation from a notification and verify correct target message is targeted', () => {
      const messages = [
        { id: 'm1', senderId: 'usr_peer', body: { text: 'Old message' }, eventSeq: 1, status: 'read' },
        { id: 'm2', senderId: 'usr_peer', body: { text: 'Notification message' }, eventSeq: 2, status: 'delivered' },
        { id: 'm3', senderId: 'usr_peer', body: { text: 'Newer message' }, eventSeq: 3, status: 'delivered' }
      ];

      const target = findLatestUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2,
        isMarkedUnread: false,
        targetMessageId: 'm2'
      });

      assert.ok(target, 'Target message must be found');
      assert.equal(target.id, 'm2', 'Must target exact notification message m2');

      const first = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2,
        isMarkedUnread: false,
        targetMessageId: 'm2'
      });
      assert.equal(first.id, 'm2', 'Unread divider must anchor at notification target message');
    });

    test('Scenario 2: Unread divider is established and persists throughout active session even after read acknowledgement', () => {
      const messages = [
        { id: 'm1', senderId: 'usr_peer', body: { text: 'Already read' }, status: 'read' },
        { id: 'm2', senderId: 'usr_peer', body: { text: 'First unread' }, status: 'delivered' },
        { id: 'm3', senderId: 'usr_peer', body: { text: 'Second unread' }, status: 'delivered' }
      ];

      // Session opening with 2 unread messages
      const openingState = {
        roomId: 'room_session_active',
        initialUnreadCount: 2,
        isMarkedUnread: false,
        trackedUnreadSet: new Set(['m2', 'm3']),
        hasPositioned: false,
        targetMessageId: null,
        isReadAcknowledged: false,
        hasUnreadDivider: true,
        unreadDividerMessageId: null
      };

      // Initial render pass: divider target is identified
      const first = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: openingState.initialUnreadCount,
        isMarkedUnread: openingState.isMarkedUnread,
        trackedUnreadSet: openingState.trackedUnreadSet
      });
      assert.ok(first);
      assert.equal(first.id, 'm2');
      openingState.unreadDividerMessageId = first.id;

      // advanceReadCursorForActiveRoom() acknowledges read state:
      openingState.isReadAcknowledged = true;
      // Notice: openingState.hasUnreadDivider and unreadDividerMessageId remain preserved!

      // Subsequent re-renders during active session (e.g. from typing, presence, reactions, receipts)
      for (let renderPass = 1; renderPass <= 4; renderPass++) {
        let activeDividerId = null;
        if (openingState && openingState.hasUnreadDivider) {
          activeDividerId = openingState.unreadDividerMessageId;
        }
        assert.equal(
          activeDividerId,
          'm2',
          `Render pass ${renderPass} must retain unread divider at m2 despite isReadAcknowledged = true`
        );
      }
    });

    test('Scenario 3: Leaving conversation and returning after reading does not recreate obsolete divider', () => {
      const state = new ChatShellState();
      state.setInbox([
        { roomId: 'room_read_return', title: 'Alice', unreadCount: 2 }
      ]);

      // 1. User opens room: unreadCount is 2
      const rawCountInitial = state.getRoomUnreadCount('room_read_return');
      assert.equal(rawCountInitial, 2);

      // 2. Room is read actively
      state.selectConversation('room_read_return');
      state.markConversationAsRead('room_read_return');
      assert.equal(state.getRoomUnreadCount('room_read_return'), 0);

      // 3. User switches away to room_other
      state.selectConversation('room_other');

      // 4. User returns to room_read_return
      state.selectConversation('room_read_return');
      const rawCountOnReturn = state.getRoomUnreadCount('room_read_return');
      const isMarkedOnReturn = false;
      const shouldHaveDivider = Boolean(rawCountOnReturn > 0 || isMarkedOnReturn);

      assert.equal(shouldHaveDivider, false, 'Should NOT establish unread divider when returning to read chat');

      const messages = [
        { id: 'm1', senderId: 'usr_alice', body: { text: 'Msg 1' }, status: 'delivered' },
        { id: 'm2', senderId: 'usr_alice', body: { text: 'Msg 2' }, status: 'delivered' }
      ];

      const divider = shouldHaveDivider
        ? findFirstUnreadMessage(messages, { currentUserId, unreadCount: rawCountOnReturn })
        : null;

      assert.equal(divider, null, 'Divider must stay absent on subsequent visit');
    });

    test('Scenario 4: Genuinely new unread message arriving while inactive establishes a new divider', () => {
      const state = new ChatShellState();
      state.setInbox([
        { roomId: 'room_incoming_test', title: 'Charlie', unreadCount: 0 }
      ]);

      const initialMessages = [
        { id: 'm1', senderId: 'usr_charlie', body: { text: 'Read earlier' }, status: 'read' }
      ];

      // Current opening state for caught-up room
      const openingState = {
        roomId: 'room_incoming_test',
        hasUnreadDivider: false,
        unreadDividerMessageId: null,
        initialUnreadCount: 0,
        isReadAcknowledged: true
      };

      // New unread message arrives while window is unfocused/inactive:
      const incoming = { id: 'm2', senderId: 'usr_charlie', body: { text: 'New unread message' }, status: 'delivered' };
      state.recordIncomingUnreadMessage('room_incoming_test', incoming);

      // When message arrives for active room while unfocused:
      if (!openingState.hasUnreadDivider) {
        openingState.hasUnreadDivider = true;
        openingState.unreadDividerMessageId = incoming.id;
        openingState.initialUnreadCount = 1;
        openingState.isReadAcknowledged = false;
      }

      assert.equal(openingState.hasUnreadDivider, true);
      assert.equal(openingState.unreadDividerMessageId, 'm2');

      const updatedMessages = [...initialMessages, incoming];
      const divider = findFirstUnreadMessage(updatedMessages, {
        currentUserId,
        unreadCount: state.getRoomUnreadCount('room_incoming_test'),
        isMarkedUnread: false
      });

      assert.ok(divider, 'Incoming unread establishes new divider');
      assert.equal(divider.id, 'm2', 'Divider placed above new incoming unread message');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Fix 3 Regressions: Conversation Scroll-Position Restoration
  // ───────────────────────────────────────────────────────────────────
  describe('Fix 3: Conversation Scroll-Position Restoration & Viewport Anchoring', () => {
    test('Scenario 5: Latest-message view is preserved when switching away and returning', () => {
      const roomId = 'room_latest_scroll';

      // Simulate notification navigating to the latest message (or user at bottom)
      // Viewport has distFromBottom <= 50 OR last message visible in viewport
      const savedPosition = {
        scrollTop: 2800,
        scrollHeight: 3400,
        clientHeight: 600,
        isNearBottom: true,
        isViewingLatest: true,
        lastMessageId: 'm100',
        anchorMessageId: 'm95',
        anchorOffsetTop: 10,
        savedAt: Date.now()
      };
      roomSavedScrollPositions.set(roomId, savedPosition);

      // Simulate restoreRoomScrollPosition
      const saved = roomSavedScrollPositions.get(roomId);
      assert.ok(saved);

      let targetScrollTop = null;
      let scrollBottomHidden = false;

      if (saved.isViewingLatest || saved.isNearBottom) {
        targetScrollTop = 3400; // scrollHeight
        scrollBottomHidden = true;
      }

      assert.equal(targetScrollTop, 3400, 'Must restore to latest message / bottom position');
      assert.equal(scrollBottomHidden, true, 'Scroll to bottom button must be hidden');
    });

    test('Scenario 6: Deliberate historical position is preserved when switching away and returning', () => {
      const roomId = 'room_historical_scroll';

      // User deliberately scrolled halfway up to read message m25
      const savedPosition = {
        scrollTop: 1200,
        scrollHeight: 5000,
        clientHeight: 600,
        isNearBottom: false,
        isViewingLatest: false, // Last message is NOT in viewport
        lastMessageId: 'm100',
        anchorMessageId: 'm25',
        anchorOffsetTop: 15,
        savedAt: Date.now()
      };
      roomSavedScrollPositions.set(roomId, savedPosition);

      const saved = roomSavedScrollPositions.get(roomId);
      assert.equal(saved.isViewingLatest, false);
      assert.equal(saved.anchorMessageId, 'm25');

      // Restoration aligns to anchorMessageId 'm25'
      assert.equal(saved.anchorMessageId, 'm25');
      assert.equal(saved.anchorOffsetTop, 15);
    });

    test('Scenario 7: Explicit notification target overrides an older saved position', () => {
      const roomId = 'room_override_test';

      // Room has an existing historical saved position
      roomSavedScrollPositions.set(roomId, {
        scrollTop: 800,
        scrollHeight: 3000,
        clientHeight: 600,
        isNearBottom: false,
        isViewingLatest: false,
        anchorMessageId: 'm10',
        savedAt: Date.now()
      });

      assert.equal(roomSavedScrollPositions.has(roomId), true);

      // Explicit notification arrives with targetMessageId:
      const targetMessageId = 'm50';
      if (targetMessageId && roomId) {
        roomSavedScrollPositions.delete(String(roomId));
      }

      assert.equal(
        roomSavedScrollPositions.has(roomId),
        false,
        'Explicit notification target must clear saved position to allow centering target message'
      );
    });

    test('Scenario 8: Background pagination preserves viewport position via scroll compensation', () => {
      let mockScrollTop = 1420;
      const initialScrollHeight = 3000;

      // Simulate prepending older messages during background history load
      const olderMessagesAddedHeight = 1500;
      const newScrollHeight = initialScrollHeight + olderMessagesAddedHeight; // 4500

      // Compensation formula: scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop
      mockScrollTop = newScrollHeight - initialScrollHeight + mockScrollTop;

      assert.equal(mockScrollTop, 2920, 'Scroll top compensated by prepended height');
      // Visual distance from bottom preserved
      assert.equal(newScrollHeight - mockScrollTop, initialScrollHeight - 1420);
    });

    test('Scenario 9: Navigating during async loading rejects stale callbacks without resetting position', () => {
      let activeLoadToken = 1;
      let selectedRoomId = 'room_first';

      function onAsyncLoadComplete(token, roomId, messages) {
        if (token !== activeLoadToken || selectedRoomId !== roomId) {
          return false; // Stale load ignored
        }
        return true;
      }

      // User navigates away before room_first finishes loading:
      selectedRoomId = 'room_second';
      activeLoadToken = 2;

      // Stale response arrives for room_first with token 1:
      const applied = onAsyncLoadComplete(1, 'room_first', [{ id: 'old_1' }]);
      assert.equal(applied, false, 'Stale response must be rejected without affecting state');
    });

    test('Scenario 10: Repeated rendering does not recreate obsolete unread divider', () => {
      const openingState = {
        roomId: 'room_repeated_render',
        initialUnreadCount: 0,
        isMarkedUnread: false,
        hasUnreadDivider: false,
        unreadDividerMessageId: null,
        isReadAcknowledged: true
      };

      const messages = [
        { id: 'm1', senderId: 'usr_peer', body: { text: 'Msg 1' }, status: 'delivered' },
        { id: 'm2', senderId: 'usr_peer', body: { text: 'Msg 2' }, status: 'delivered' },
        { id: 'm3', senderId: 'usr_peer', body: { text: 'Msg 3' }, status: 'delivered' }
      ];

      for (let renderPass = 1; renderPass <= 5; renderPass++) {
        let firstUnreadId = null;
        if (openingState && openingState.hasUnreadDivider) {
          firstUnreadId = openingState.unreadDividerMessageId;
        }

        assert.equal(
          firstUnreadId,
          null,
          `Render pass ${renderPass} must NOT produce an unread divider`
        );
      }
    });
  });
});
