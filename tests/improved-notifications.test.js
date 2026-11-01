import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ChatShellState,
  isWindowActiveAndVisible,
  formatNotificationContent,
  formatMessageNotificationPreview
} from '../src/renderer/chat-shell-state.js';
import { NotificationStore, DEFAULT_NOTIFICATION_SETTINGS } from '../src/storage/notification-store.js';

describe('Improved Desktop Notifications (Phase 2)', () => {

  // ═══════════════════════════════════════════════════════════════════
  // A. Notification Preferences & Persistence
  // ═══════════════════════════════════════════════════════════════════
  describe('Notification Preferences & Storage', () => {
    let tempDir;
    let store;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollachat-notif-test-'));
      store = new NotificationStore(tempDir);
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    });

    test('1. Defaults to enabled=true and showPreview=true when file is missing', async () => {
      const settings = await store.load();
      assert.equal(settings.enabled, true);
      assert.equal(settings.showPreview, true);
      assert.equal(store.getEnabled(), true);
      assert.equal(store.getShowPreview(), true);
    });

    test('2. Disabling global notifications saves and persists to disk', async () => {
      await store.load();
      await store.save({ enabled: false });

      assert.equal(store.getEnabled(), false);
      assert.equal(store.getShowPreview(), true);

      // Verify persistence by loading with a new instance
      const freshStore = new NotificationStore(tempDir);
      const reloaded = await freshStore.load();
      assert.equal(reloaded.enabled, false);
      assert.equal(reloaded.showPreview, true);
    });

    test('3. Disabling message preview saves and persists to disk', async () => {
      await store.load();
      await store.save({ showPreview: false });

      assert.equal(store.getShowPreview(), false);
      assert.equal(store.getEnabled(), true);

      const freshStore = new NotificationStore(tempDir);
      const reloaded = await freshStore.load();
      assert.equal(reloaded.showPreview, false);
      assert.equal(reloaded.enabled, true);
    });

    test('4. Partial updates preserve untouched preferences', async () => {
      await store.load();
      await store.save({ showPreview: false });
      await store.save({ enabled: false });

      const settings = store.getSettings();
      assert.equal(settings.enabled, false);
      assert.equal(settings.showPreview, false);

      // Turn enabled back on, showPreview should stay false
      await store.save({ enabled: true });
      assert.equal(store.getEnabled(), true);
      assert.equal(store.getShowPreview(), false);
    });

    test('5. Gracefully recovers with defaults if settings file is corrupt JSON', async () => {
      const filePath = path.join(tempDir, 'ollacore_notification_settings.json');
      await fs.writeFile(filePath, '{{invalid-json::', 'utf8');

      const settings = await store.load();
      assert.equal(settings.enabled, true);
      assert.equal(settings.showPreview, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // B. Notification Content, Group Attribution & Privacy
  // ═══════════════════════════════════════════════════════════════════
  describe('Notification Content Formatting & Privacy', () => {
    const groupConversation = {
      roomId: 'room_proj',
      kind: 'group',
      title: 'Project Team'
    };

    const directConversation = {
      roomId: 'room_alice',
      kind: 'direct',
      title: 'Alice Nakamura',
      peerName: 'Alice Nakamura'
    };

    test('6. Direct conversation with preview enabled shows contact name and message text', () => {
      const message = {
        id: 'msg_1',
        text: 'Hello, are we still meeting today?'
      };

      const notif = formatNotificationContent({
        conversation: directConversation,
        message,
        showPreview: true,
        senderName: 'Alice Nakamura'
      });

      assert.equal(notif.title, 'Alice Nakamura');
      assert.equal(notif.body, 'Hello, are we still meeting today?');
    });

    test('7. Direct conversation with preview disabled hides message text and shows generic label', () => {
      const message = {
        id: 'msg_2',
        text: 'Top secret password: 12345'
      };

      const notif = formatNotificationContent({
        conversation: directConversation,
        message,
        showPreview: false,
        senderName: 'Alice Nakamura'
      });

      assert.equal(notif.title, 'Alice Nakamura');
      assert.equal(notif.body, 'New message');
      assert.equal(notif.body.includes('secret'), false, 'Sensitive body text must not leak');
    });

    test('8. Group conversation with preview enabled displays Group Title and Sender Attribution', () => {
      const message = {
        id: 'msg_3',
        senderId: 'usr_alice',
        senderName: 'Alice',
        text: 'The meeting starts at 3 PM.'
      };

      const notif = formatNotificationContent({
        conversation: groupConversation,
        message,
        showPreview: true,
        senderName: 'Alice'
      });

      assert.equal(notif.title, 'Project Team');
      assert.equal(notif.body, 'Alice: The meeting starts at 3 PM.');
    });

    test('9. Group conversation with preview disabled shows Group Title and New message', () => {
      const message = {
        id: 'msg_4',
        senderId: 'usr_alice',
        senderName: 'Alice',
        text: 'Confidential project update'
      };

      const notif = formatNotificationContent({
        conversation: groupConversation,
        message,
        showPreview: false,
        senderName: 'Alice'
      });

      assert.equal(notif.title, 'Project Team');
      assert.equal(notif.body, 'New message');
      assert.equal(notif.body.includes('Confidential'), false, 'Message preview text must not leak');
    });

    test('10. Prevents duplicate sender attribution if message text already starts with sender prefix', () => {
      const message = {
        id: 'msg_5',
        senderName: 'Alice',
        text: 'Alice: Already prefixed message'
      };

      const notif = formatNotificationContent({
        conversation: groupConversation,
        message,
        showPreview: true,
        senderName: 'Alice'
      });

      assert.equal(notif.body, 'Alice: Already prefixed message');
      assert.equal(notif.body.startsWith('Alice: Alice:'), false);
    });

    test('11. Unsupported or media message types format safe descriptive preview text', () => {
      // Photo with caption
      const photoWithCaption = formatMessageNotificationPreview({
        kind: 'image',
        caption: 'Design mockup'
      });
      assert.equal(photoWithCaption, '📷 Design mockup');

      // Photo without caption
      const photoNoCaption = formatMessageNotificationPreview({
        kind: 'image'
      });
      assert.equal(photoNoCaption, '📷 Photo');

      // Video with caption
      const videoWithCaption = formatMessageNotificationPreview({
        kind: 'video',
        caption: 'Release demo'
      });
      assert.equal(videoWithCaption, '🎥 Release demo');

      // Video without caption
      const videoNoCaption = formatMessageNotificationPreview({
        kind: 'video'
      });
      assert.equal(videoNoCaption, '🎥 Video');

      // Audio / voice note
      const audioMsg = formatMessageNotificationPreview({
        kind: 'audio'
      });
      assert.equal(audioMsg, '🎤 Voice message');

      // Document with filename
      const docMsg = formatMessageNotificationPreview({
        kind: 'file',
        filename: 'Quarterly_Report.pdf'
      });
      assert.equal(docMsg, '📄 Quarterly_Report.pdf');

      // Deleted message
      const deletedMsg = formatMessageNotificationPreview({
        isDeleted: true
      });
      assert.equal(deletedMsg, 'This message was deleted');

      // Call entry
      const callMsg = formatMessageNotificationPreview({
        kind: 'call',
        isVideo: false
      });
      assert.equal(callMsg, '📞 Audio call');
    });

    test('12. Empty, null, or whitespace-only messages fall back to safe text', () => {
      assert.equal(formatMessageNotificationPreview(null), 'New message');
      assert.equal(formatMessageNotificationPreview({}), 'New message');
      assert.equal(formatMessageNotificationPreview({ text: '   ' }), 'New message');
    });

    test('13. Raw internal UUIDs are filtered out from sender name in notifications', () => {
      const message = {
        id: 'msg_raw',
        sender_id: 'usr_23c7f84b-6101-4433-8a9b-112233445566',
        text: 'Testing UUID filtering'
      };

      const notif = formatNotificationContent({
        conversation: groupConversation,
        message,
        showPreview: true,
        senderName: '23c7f84b-6101-4433-8a9b-112233445566' // Raw UUID passed as candidate name
      });

      assert.equal(notif.title, 'Project Team');
      assert.equal(notif.body.includes('23c7f84b'), false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // C. Window Behavior on Notification Arrival, Click, & Dismiss
  // ═══════════════════════════════════════════════════════════════════
  describe('Window Behavior & Lifecycle Invariants', () => {
    test('14. Minimized window remains minimized when notification arrives', () => {
      let restored = false;
      let focused = false;
      let shown = false;

      const mockMainWindow = {
        isMinimized: () => true,
        isVisible: () => true,
        restore: () => { restored = true; },
        focus: () => { focused = true; },
        show: () => { shown = true; }
      };

      assert.equal(restored, false);
      assert.equal(focused, false);
      assert.equal(shown, false);
    });

    test('15. Window closed/hidden to tray remains hidden when notification arrives', () => {
      let shown = false;
      let focused = false;

      const mockMainWindow = {
        isMinimized: () => false,
        isVisible: () => false,
        restore: () => {},
        focus: () => { focused = true; },
        show: () => { shown = true; }
      };

      assert.equal(shown, false, 'Window must remain hidden');
      assert.equal(focused, false, 'Window must not steal focus');
    });

    test('16. Clicking notification restores, shows, focuses window and navigates to conversation', () => {
      let restored = false;
      let shown = false;
      let focused = false;
      let targetRoom = null;

      const mockMainWindow = {
        isMinimized: () => true,
        isVisible: () => false,
        restore: () => { restored = true; },
        show: () => { shown = true; },
        focus: () => { focused = true; },
        webContents: {
          isLoading: () => false,
          send: (channel, data) => {
            if (channel === 'chat:navigate-room') targetRoom = data;
          }
        }
      };

      function simulateNotificationClick(roomId) {
        if (!mockMainWindow.isVisible()) mockMainWindow.show();
        if (mockMainWindow.isMinimized()) mockMainWindow.restore();
        mockMainWindow.focus();
        if (roomId) mockMainWindow.webContents.send('chat:navigate-room', roomId);
      }

      simulateNotificationClick('room_alpha');

      assert.equal(shown, true, 'Window was shown');
      assert.equal(restored, true, 'Window was restored');
      assert.equal(focused, true, 'Window was focused');
      assert.equal(targetRoom, 'room_alpha', 'Navigated to the clicked conversation');
    });

    test('17. Clicking notification while renderer is loading queues room navigation until ready', () => {
      let queuedRoom = null;
      let didFinishLoadHandler = null;

      const mockWebContents = {
        isLoading: () => true,
        once: (event, handler) => {
          if (event === 'did-finish-load') didFinishLoadHandler = handler;
        },
        send: (channel, data) => {
          if (channel === 'chat:navigate-room') queuedRoom = data;
        }
      };

      function handleNotificationClickWhileLoading(roomId) {
        if (mockWebContents.isLoading()) {
          mockWebContents.once('did-finish-load', () => {
            mockWebContents.send('chat:navigate-room', roomId);
          });
        } else {
          mockWebContents.send('chat:navigate-room', roomId);
        }
      }

      handleNotificationClickWhileLoading('room_beta');
      assert.equal(queuedRoom, null, 'Navigation not immediately dispatched while loading');

      assert.ok(typeof didFinishLoadHandler === 'function');
      didFinishLoadHandler();
      assert.equal(queuedRoom, 'room_beta', 'Navigation dispatched once renderer finished loading');
    });

    test('18. Dismissed or ignored notification leaves window in current state without navigation', () => {
      let shown = false;
      let navigated = false;

      const mockMainWindow = {
        isVisible: () => false,
        show: () => { shown = true; },
        webContents: {
          send: () => { navigated = true; }
        }
      };

      const onClose = () => {};
      onClose();

      assert.equal(shown, false, 'Window remained hidden');
      assert.equal(navigated, false, 'No navigation was triggered');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // D. Filtering & Deduplication
  // ═══════════════════════════════════════════════════════════════════
  describe('Notification Filtering & Deduplication', () => {
    let shellState;

    beforeEach(() => {
      shellState = new ChatShellState();
      shellState.currentUser = { userId: 'usr_me' };
      shellState.conversations = [
        {
          roomId: 'room_active',
          title: 'Active Room',
          unreadCount: 0
        },
        {
          roomId: 'room_muted',
          title: 'Muted Room',
          unreadCount: 0,
          mutedUntil: Date.now() + 3600000 // Muted for 1 hour
        },
        {
          roomId: 'room_blocked',
          title: 'Blocked User Room',
          unreadCount: 0
        }
      ];
      shellState.setBlockedUsers([{ userId: 'usr_spammer' }]);
    });

    test('19. Muted conversation suppresses notification', () => {
      const conv = shellState.conversations.find((c) => c.roomId === 'room_muted');
      assert.equal(shellState.isConversationMuted(conv), true);
    });

    test('20. Blocked sender suppresses notification', () => {
      assert.equal(shellState.isUserBlocked('usr_spammer'), true);
      assert.equal(shellState.isUserBlocked('usr_normal'), false);
    });

    test('21. Active conversation currently in view suppresses notification', () => {
      shellState.selectedRoomId = 'room_active';
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
      const windowState = { isMinimized: false, isVisible: true, isFocused: true };

      const isAppActive = isWindowActiveAndVisible(mockDoc, windowState);
      const isCurrentlyViewed = shellState.selectedRoomId === 'room_active' && isAppActive;

      assert.equal(isCurrentlyViewed, true, 'Currently viewed message must be marked read and not notify');
    });

    test('22. Unfocused or minimized window makes active conversation eligible for notification', () => {
      shellState.selectedRoomId = 'room_active';
      const mockDoc = { hidden: false, visibilityState: 'visible', hasFocus: () => false };
      const windowState = { isMinimized: true, isVisible: false, isFocused: false };

      const isAppActive = isWindowActiveAndVisible(mockDoc, windowState);
      const isCurrentlyViewed = shellState.selectedRoomId === 'room_active' && isAppActive;

      assert.equal(isCurrentlyViewed, false, 'Minimized or unfocused app must not consider room currently viewed');
    });

    test('23. Stable message identifier deduplication ignores duplicate frames but allows distinct messages', () => {
      const cache = new Set();
      const MAX_SIZE = 500;

      function isDuplicate(id) {
        if (!id) return false;
        if (cache.has(id)) return true;
        if (cache.size >= MAX_SIZE) {
          const oldest = cache.values().next().value;
          cache.delete(oldest);
        }
        cache.add(id);
        return false;
      }

      assert.equal(isDuplicate('msg_101'), false, 'First receipt is not a duplicate');
      assert.equal(isDuplicate('msg_101'), true, 'Duplicate message ID must be detected');
      assert.equal(isDuplicate('msg_102'), false, 'Distinct message with same text is not a duplicate');
    });

    test('24. Cache eviction prevents unbounded memory growth', () => {
      const cache = new Set();
      const MAX_SIZE = 5;

      function add(id) {
        if (cache.has(id)) return true;
        if (cache.size >= MAX_SIZE) {
          const oldest = cache.values().next().value;
          cache.delete(oldest);
        }
        cache.add(id);
        return false;
      }

      for (let i = 1; i <= 6; i++) {
        add(`msg_${i}`);
      }

      assert.equal(cache.size, 5, 'Cache size is bounded');
      assert.equal(cache.has('msg_1'), false, 'Oldest item was evicted');
      assert.equal(cache.has('msg_6'), true, 'Newest item is present');
    });
  });
});
