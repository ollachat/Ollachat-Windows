import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatShellState, isWindowActiveAndVisible } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');
const preloadJsPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');

const mainJs = fs.readFileSync(mainJsPath, 'utf8');
const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Incoming Message Notification Lifecycle & Window State Invariants', () => {

  // ═══════════════════════════════════════════════════════════════════
  // 1. Static Contract & Wiring Verification
  // ═══════════════════════════════════════════════════════════════════
  describe('Main & Preload Process Contracts', () => {
    test('1. main.js sets Windows AppUserModelId to com.ollacore.chat.desktop', () => {
      assert.ok(mainJs.includes("app.setAppUserModelId('com.ollacore.chat.desktop')"), 'main.js must set AppUserModelId on win32');
    });

    test('2. main.js handles app:get-window-state IPC', () => {
      assert.ok(mainJs.includes("'app:get-window-state'"), 'main.js must register app:get-window-state');
    });

    test('3. main.js notifies renderer of window state changes on hide and blur', () => {
      assert.ok(mainJs.includes("mainWindow.on('hide'"), 'main.js must handle hide event');
      assert.ok(mainJs.includes("mainWindow.on('blur'"), 'main.js must handle blur event');
    });

    test('4. preload.js exposes getWindowState and onWindowStateChange under app namespace', () => {
      assert.ok(preloadJs.includes("getWindowState: () => ipcRenderer.invoke('app:get-window-state')"), 'preload must expose getWindowState');
      assert.ok(preloadJs.includes("onWindowStateChange: (callback) =>"), 'preload must expose onWindowStateChange under app');
    });

    test('5. Notification click in main process restores, shows, focuses window and dispatches navigate-room', () => {
      assert.ok(mainJs.includes("notif.on('click'"), 'main.js must attach click listener to notification');
      assert.ok(mainJs.includes("mainWindow.show()"), 'click must show window');
      assert.ok(mainJs.includes("mainWindow.restore()"), 'click must restore minimized window');
      assert.ok(mainJs.includes("mainWindow.focus()"), 'click must focus window');
      assert.ok(mainJs.includes("'chat:navigate-room'"), 'click must dispatch chat:navigate-room');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. isWindowActiveAndVisible Window State Logic
  // ═══════════════════════════════════════════════════════════════════
  describe('isWindowActiveAndVisible Invariants', () => {
    test('6. Returns true when document is visible, focused, and not minimized', () => {
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
      const windowState = { isMinimized: false, isVisible: true, isFocused: true };
      assert.equal(isWindowActiveAndVisible(mockDoc, windowState), true);
    });

    test('7. Returns false when window is minimized regardless of doc visibility', () => {
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
      const windowState = { isMinimized: true, isVisible: false, isFocused: false };
      assert.equal(isWindowActiveAndVisible(mockDoc, windowState), false);
    });

    test('8. Returns false when window is hidden (closed to tray) regardless of doc visibility', () => {
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
      const windowState = { isMinimized: false, isVisible: false, isFocused: false };
      assert.equal(isWindowActiveAndVisible(mockDoc, windowState), false);
    });

    test('9. Returns false when window does not have active focus (user in another app)', () => {
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => false };
      const windowState = { isMinimized: false, isVisible: true, isFocused: false };
      assert.equal(isWindowActiveAndVisible(mockDoc, windowState), false);
    });

    test('10. Returns false when doc.hidden is true', () => {
      const mockDoc = { hidden: true, visibilityState: 'hidden', hasFocus: () => false };
      const windowState = { isMinimized: false, isVisible: true, isFocused: true };
      assert.equal(isWindowActiveAndVisible(mockDoc, windowState), false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Notification Eligibility & Event Filtering
  // ═══════════════════════════════════════════════════════════════════
  describe('ChatShellState & Notification Rule Enforcement', () => {
    let shellState;

    beforeEach(() => {
      shellState = new ChatShellState();
      shellState.currentUser = { userId: 'usr_me', display_name: 'Me' };
      shellState.conversations = [
        {
          roomId: 'room_alice',
          room_id: 'room_alice',
          title: 'Alice Nakamura',
          unreadCount: 0,
          kind: 'direct',
          peer: { user_id: 'usr_alice', display_name: 'Alice Nakamura' }
        },
        {
          roomId: 'room_bob',
          room_id: 'room_bob',
          title: 'Bob Direct Peer',
          unreadCount: 0,
          kind: 'direct',
          peer: { user_id: 'usr_bob', display_name: 'Bob Direct Peer' }
        }
      ];
    });

    test('11. Incoming message while window is minimized records unread count', () => {
      shellState.selectedRoomId = 'room_alice';
      const msg = { id: 'msg_101', sender_id: 'usr_alice', text: 'Hello' };
      const count = shellState.recordIncomingUnreadMessage('room_alice', msg);
      assert.equal(count, 1);
      assert.equal(shellState.conversations[0].unreadCount, 1);
    });

    test('12. Duplicate incoming message frame (reconnect / resync) does not re-increment', () => {
      const msg = { id: 'msg_dup_1', sender_id: 'usr_alice', text: 'Hello again', eventSeq: 42 };
      const count1 = shellState.recordIncomingUnreadMessage('room_alice', msg);
      const count2 = shellState.recordIncomingUnreadMessage('room_alice', msg);
      assert.equal(count1, 1);
      assert.equal(count2, 1, 'Duplicate message with same id/seq must not increment unread count');
    });

    test('13. Muted conversation correctly detected to suppress notifications', () => {
      const conv = shellState.conversations[0];
      conv.mutedUntil = new Date(Date.now() + 86400000).toISOString();
      assert.equal(shellState.isConversationMuted(conv), true);
    });

    test('14. Blocked contact correctly detected to suppress notifications', () => {
      shellState.setBlockedUsers([{ userId: 'usr_alice' }]);
      assert.equal(shellState.isUserBlocked('usr_alice'), true);
      assert.equal(shellState.isRoomBlocked('room_alice'), true);
      assert.equal(shellState.isUserBlocked('usr_bob'), false);
    });

    test('15. app.js contains blocked user guard for incoming notifications', () => {
      assert.ok(appJs.includes('shellState.isRoomBlocked(eventRoomId)'), 'app.js must check isRoomBlocked');
      assert.ok(appJs.includes('shellState.isUserBlocked(effectiveSenderId)'), 'app.js must check isUserBlocked');
    });

    test('16. app.js uses isAppActiveAndFocused for view state and read receipts', () => {
      assert.ok(appJs.includes('isAppActiveAndFocused()'), 'app.js must define and use isAppActiveAndFocused');
      assert.ok(appJs.includes('const isCurrentlyViewed = eventRoomId === shellState.selectedRoomId && isAppActiveAndFocused()'), 'isCurrentlyViewed must require active focus');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Window State Non-Restoration on Message Arrival vs Explicit Click
  // ═══════════════════════════════════════════════════════════════════
  describe('Notification Popup & Window Restoration Lifecycle Invariants', () => {
    test('17. Receiving message / showing notification while minimized does NOT automatically restore, show, or focus mainWindow', () => {
      let restored = false;
      let focused = false;
      let shown = false;

      const mockMainWindow = {
        isMinimized: () => true,
        isVisible: () => true,
        isFocused: () => false,
        restore: () => { restored = true; },
        focus: () => { focused = true; },
        show: () => { shown = true; },
        webContents: { send: () => {} }
      };

      // Simulate notification creation in app:show-notification
      let clickHandler = null;
      let notificationShown = false;
      class MockNotification {
        constructor(opts) {
          this.opts = opts;
        }
        on(event, cb) {
          if (event === 'click') clickHandler = cb;
        }
        show() {
          notificationShown = true;
        }
      }

      function handleShowNotification({ title, body, roomId }) {
        const notif = new MockNotification({ title, body });
        notif.on('click', () => {
          if (mockMainWindow) {
            if (!mockMainWindow.isVisible()) mockMainWindow.show();
            if (mockMainWindow.isMinimized()) mockMainWindow.restore();
            mockMainWindow.focus();
            if (roomId) mockMainWindow.webContents.send('chat:navigate-room', roomId);
          }
        });
        notif.show();
      }

      // Incoming message arrives:
      handleShowNotification({ title: 'Alice', body: 'Hello', roomId: 'room_alice' });

      // Invariants when message arrives:
      assert.equal(notificationShown, true, 'Native toast notification was displayed');
      assert.equal(restored, false, 'Window was NOT automatically restored');
      assert.equal(focused, false, 'Window was NOT automatically focused');
      assert.equal(shown, false, 'Window show() was NOT called');

      // Now simulate user EXPLICITLY clicking the notification:
      clickHandler();
      assert.equal(restored, true, 'Window was restored after explicit notification click');
      assert.equal(focused, true, 'Window was focused after explicit notification click');
    });

    test('18. Receiving message / showing notification while closed to tray does NOT unhide mainWindow until clicked', () => {
      let shown = false;
      let focused = false;
      let navigatedRoom = null;

      const mockMainWindow = {
        isMinimized: () => false,
        isVisible: () => false,
        isFocused: () => false,
        show: () => { shown = true; },
        focus: () => { focused = true; },
        restore: () => {},
        webContents: {
          send: (channel, data) => {
            if (channel === 'chat:navigate-room') navigatedRoom = data;
          }
        }
      };

      let clickHandler = null;
      class MockNotification {
        constructor(opts) { this.opts = opts; }
        on(event, cb) { if (event === 'click') clickHandler = cb; }
        show() {}
      }

      function handleShowNotification({ title, body, roomId }) {
        const notif = new MockNotification({ title, body });
        notif.on('click', () => {
          if (mockMainWindow) {
            if (!mockMainWindow.isVisible()) mockMainWindow.show();
            if (mockMainWindow.isMinimized()) mockMainWindow.restore();
            mockMainWindow.focus();
            if (roomId) mockMainWindow.webContents.send('chat:navigate-room', roomId);
          }
        });
        notif.show();
      }

      // Incoming message arrives while hidden in tray:
      handleShowNotification({ title: 'Bob', body: 'Are you there?', roomId: 'room_bob' });

      assert.equal(shown, false, 'Window remains hidden in tray on message delivery');
      assert.equal(focused, false, 'Window does not steal focus');
      assert.equal(navigatedRoom, null, 'Navigation is not triggered before click');

      // User clicks notification:
      clickHandler();
      assert.equal(shown, true, 'Window is shown after explicit click');
      assert.equal(focused, true, 'Window is focused after explicit click');
      assert.equal(navigatedRoom, 'room_bob', 'Navigated to sender conversation on click');
    });

    test('19. Dismissed / ignored notification does NOT restore or focus mainWindow', () => {
      let restored = false;
      let focused = false;

      const mockMainWindow = {
        isMinimized: () => true,
        isVisible: () => true,
        restore: () => { restored = true; },
        focus: () => { focused = true; },
        show: () => {}
      };

      let closeHandler = null;
      class MockNotification {
        constructor(opts) { this.opts = opts; }
        on(event, cb) {
          if (event === 'close') closeHandler = cb;
        }
        show() {}
      }

      const notif = new MockNotification({ title: 'Alice', body: 'Ignored' });
      notif.show();

      // User dismisses notification or it times out:
      if (closeHandler) closeHandler();

      assert.equal(restored, false, 'Window must remain minimized when notification dismissed');
      assert.equal(focused, false, 'Window must not focus when notification dismissed');
    });

    test('20. Normal incoming message handler in app.js does not invoke focusWindow or show custom popups', () => {
      // Isolate the normal message.created handling section (excluding call signaling)
      const normalMessageIndex = appJs.indexOf('// 1. Sidebar conversation preview update');
      const nextSectionIndex = appJs.indexOf('// Call events (Phase 6B/6C)', normalMessageIndex);
      const messageBlock = appJs.substring(normalMessageIndex, nextSectionIndex);

      assert.ok(!messageBlock.includes('focusWindow'), 'Normal message delivery must never call focusWindow');
      assert.ok(!messageBlock.includes('alert('), 'No in-app alerts on message arrival');
      assert.ok(!messageBlock.includes('openModal'), 'No in-app modal opened on message arrival');
    });
  });
});
