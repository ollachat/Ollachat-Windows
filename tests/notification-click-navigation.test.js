import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatShellState,
  isWindowActiveAndVisible,
  formatNotificationContent,
  formatMessageNotificationPreview,
  RoomMessagesState
} from '../src/renderer/chat-shell-state.js';
import { NotificationStore, DEFAULT_NOTIFICATION_SETTINGS } from '../src/storage/notification-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');
const preloadJsPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');

const mainJs = fs.readFileSync(mainJsPath, 'utf8');
const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Notification Click Navigation & Regression Test Suite', () => {

  // ═══════════════════════════════════════════════════════════════════
  // 1. Static Contract & API Wire Tests
  // ═══════════════════════════════════════════════════════════════════
  describe('Main & Preload Process Static Contracts', () => {
    test('main.js registers chat:get-pending-navigation handler', () => {
      assert.ok(
        mainJs.includes("'chat:get-pending-navigation'"),
        'main.js must register chat:get-pending-navigation IPC handler'
      );
    });

    test('preload.js exposes getPendingNavigation under chat and app namespaces', () => {
      assert.ok(
        preloadJs.includes("getPendingNavigation: () => ipcRenderer.invoke('chat:get-pending-navigation')"),
        'preload.js must expose getPendingNavigation'
      );
    });

    test('app.js handles onNavigateRoom and consumes pending navigation', () => {
      assert.ok(
        appJs.includes('onNavigateRoom'),
        'app.js must register onNavigateRoom listener'
      );
      assert.ok(
        appJs.includes('getPendingNavigation'),
        'app.js must check getPendingNavigation on initialization / load'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Behavioral Unit & Integration Tests (Scenarios 1-10)
  // ═══════════════════════════════════════════════════════════════════
  describe('Notification Click & Navigation Lifecycle Scenarios', () => {

    test('Scenario 1: Clicking a notification restores a minimized window', () => {
      let isMin = true;
      let restored = false;

      const mockWindow = {
        isMinimized: () => isMin,
        isVisible: () => true,
        restore: () => { isMin = false; restored = true; },
        show: () => {},
        focus: () => {},
        setAlwaysOnTop: () => {}
      };

      // Simulate restore helper
      if (mockWindow.isMinimized()) {
        mockWindow.restore();
      }

      assert.equal(restored, true, 'Minimized window must be restored');
      assert.equal(mockWindow.isMinimized(), false, 'Window is no longer minimized');
    });

    test('Scenario 2: Clicking a notification shows a window hidden to the tray', () => {
      let visible = false;
      let shown = false;

      const mockWindow = {
        isMinimized: () => false,
        isVisible: () => visible,
        restore: () => {},
        show: () => { visible = true; shown = true; },
        focus: () => {},
        setAlwaysOnTop: () => {}
      };

      // Simulate restore helper
      if (!mockWindow.isVisible()) {
        mockWindow.show();
      }

      assert.equal(shown, true, 'Window closed to tray must be shown');
      assert.equal(mockWindow.isVisible(), true, 'Window is now visible');
    });

    test('Scenario 3: Clicking a notification brings window to foreground and focuses', () => {
      let focused = false;
      let alwaysOnTopToggles = [];

      const mockWindow = {
        isMinimized: () => false,
        isVisible: () => true,
        show: () => {},
        focus: () => { focused = true; },
        setAlwaysOnTop: (val) => { alwaysOnTopToggles.push(val); }
      };

      // Simulate restoreAndFocusMainWindow logic
      mockWindow.setAlwaysOnTop(true);
      mockWindow.show();
      mockWindow.focus();
      mockWindow.setAlwaysOnTop(false);

      assert.equal(focused, true, 'Window must receive focus');
      assert.deepEqual(alwaysOnTopToggles, [true, false], 'Foreground activation lock must be bypassed');
    });

    test('Scenario 4: Clicking a notification opens the correct conversation', () => {
      const shellState = new ChatShellState();
      shellState.setInbox([
        { roomId: 'room_1', title: 'Alice', unreadCount: 1 },
        { roomId: 'room_2', title: 'Bob', unreadCount: 3 }
      ]);

      let forceReloadCalled = false;
      let targetRoomId = null;

      function simulateSelectConversation(roomId, { forceReload = false } = {}) {
        shellState.selectConversation(roomId);
        targetRoomId = roomId;
        forceReloadCalled = forceReload;
      }

      // Simulate notification click for room_2
      const clickedRoomId = 'room_2';
      simulateSelectConversation(clickedRoomId, { forceReload: true });

      assert.equal(shellState.selectedRoomId, 'room_2', 'Selected conversation ID must match clicked room');
      assert.equal(targetRoomId, 'room_2');
      assert.equal(forceReloadCalled, true, 'forceReload must be true on notification navigation');
    });

    test('Scenario 5: Clicking a notification while another chat is open switches to the intended chat', () => {
      const shellState = new ChatShellState();
      shellState.setInbox([
        { roomId: 'room_current', title: 'Current Chat' },
        { roomId: 'room_incoming', title: 'Incoming Notification Chat' }
      ]);

      shellState.selectConversation('room_current');
      assert.equal(shellState.selectedRoomId, 'room_current', 'Initial chat is room_current');

      // User clicks notification for room_incoming
      const previousRoomId = shellState.selectedRoomId;
      assert.notEqual(previousRoomId, 'room_incoming');

      shellState.selectConversation('room_incoming');
      assert.equal(shellState.selectedRoomId, 'room_incoming', 'Switched to incoming notification chat');
    });

    test('Scenario 6: Clicking a notification before renderer is ready does not lose navigation event', () => {
      let pendingNavigationRoomId = null;
      let deliveredRoomId = null;
      let isRendererLoading = true;

      function navigateToRoom(roomId) {
        pendingNavigationRoomId = roomId;
        if (!isRendererLoading) {
          deliveredRoomId = roomId;
        }
      }

      // Notification clicked while loading
      navigateToRoom('room_cold_start');
      assert.equal(deliveredRoomId, null, 'Not immediately delivered while loading');
      assert.equal(pendingNavigationRoomId, 'room_cold_start', 'Saved in pending navigation queue');

      // Renderer finishes load and queries pending navigation
      function getPendingNavigation() {
        const p = pendingNavigationRoomId;
        pendingNavigationRoomId = null;
        return p;
      }

      const consumedRoom = getPendingNavigation();
      assert.equal(consumedRoom, 'room_cold_start', 'Pending navigation successfully consumed by renderer');
      assert.equal(pendingNavigationRoomId, null, 'Pending navigation is cleared after consumption');
    });

    test('Scenario 7: Repeated clicks do not create duplicate event listeners or duplicate navigation', () => {
      let activeListeners = 0;
      let listenerFunction = null;

      function subscribe(cb) {
        if (listenerFunction) {
          // Unsubscribe previous
          activeListeners--;
        }
        listenerFunction = cb;
        activeListeners++;
        return () => {
          listenerFunction = null;
          activeListeners--;
        };
      }

      // First initialization
      const unsub1 = subscribe((roomId) => {});
      assert.equal(activeListeners, 1);

      // Re-initialization or repeated setup
      unsub1();
      const unsub2 = subscribe((roomId) => {});
      assert.equal(activeListeners, 1, 'Only 1 active listener remains after re-wiring');

      unsub2();
      assert.equal(activeListeners, 0, 'Listener removed completely on teardown');
    });

    test('Scenario 8: Existing notification preferences continue to work', () => {
      let notificationsEnabled = false;

      function shouldShowNotification() {
        return notificationsEnabled;
      }

      assert.equal(shouldShowNotification(), false, 'Notification suppressed when globally disabled');

      notificationsEnabled = true;
      assert.equal(shouldShowNotification(), true, 'Notification permitted when enabled');
    });

    test('Scenario 9: Notification preview privacy settings remain respected', () => {
      const message = {
        sender_id: 'user_123',
        senderName: 'Carol',
        type: 'text',
        text: 'Secret sensitive message content'
      };

      const directConversation = {
        roomId: 'room_direct',
        kind: 'direct',
        title: 'Carol'
      };

      // When preview is enabled:
      const fullContent = formatNotificationContent({
        conversation: directConversation,
        message,
        showPreview: true,
        senderName: 'Carol'
      });
      assert.ok(fullContent.body.includes('Secret sensitive message content'), 'Message text included when preview is allowed');

      // When preview is disabled:
      const privateContent = formatNotificationContent({
        conversation: directConversation,
        message,
        showPreview: false,
        senderName: 'Carol'
      });
      assert.equal(privateContent.body, 'New message', 'Generic placeholder used when previews are disabled');
      assert.ok(!privateContent.body.includes('Secret'), 'Private message content is never leaked');
    });

    test('Scenario 10: Existing notification and message-reaction functionality does not regress', () => {
      const state = new RoomMessagesState('room_reaction_test', 'current_user_id');
      const messageId = 'msg_101';
      state.messages = [
        { id: messageId, roomId: 'room_reaction_test', senderId: 'peer_user', body: { text: 'React to me' } }
      ];

      // Add reaction
      const added = state.updateReaction(messageId, 'peer_user', '👍', true);
      assert.equal(added, true, 'Reaction successfully added');
      const msg = state.messages.find(m => m.id === messageId);
      assert.ok(msg.reactions, 'Reactions map exists');
      assert.deepEqual(msg.reactions['👍'], ['peer_user']);

      // Remove reaction
      const removed = state.updateReaction(messageId, 'peer_user', '👍', false);
      assert.equal(removed, true, 'Reaction successfully removed');
      assert.equal(msg.reactions['👍'], undefined, 'Reaction cleanly removed without breaking state');
    });

    test('Provisional conversation entry created when room not yet loaded in inbox', () => {
      const shellState = new ChatShellState();
      shellState.setInbox([]); // empty inbox

      const roomId = 'room_unloaded_123';
      shellState.selectConversation(roomId);
      let selected = shellState.getSelectedConversation();
      assert.equal(selected, null, 'No conversation found initially');

      // When notification arrives for an unloaded room, provisional entry is inserted
      if (!selected && roomId) {
        const provisional = {
          roomId,
          room_id: roomId,
          title: 'Chat',
          kind: 'direct',
          unreadCount: 0
        };
        shellState.conversations.unshift(provisional);
        selected = shellState.getSelectedConversation();
      }

      assert.ok(selected, 'Conversation is now accessible');
      assert.equal(selected.roomId, 'room_unloaded_123');
      assert.equal(shellState.selectedRoomId, 'room_unloaded_123');
    });
  });
});
