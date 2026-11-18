import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatShellState,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';
import {
  sqliteRowToConversation,
  conversationToSqlitePayload
} from '../src/renderer/db-sync.js';
import {
  normalizeInboxItem
} from '../src/api/chat-api.js';

describe('Unread Messages Persistence Across App Reopen', () => {
  test('1. markConversationAsRead resets unreadCount and isMarkedUnread on conversation and state', () => {
    const state = new ChatShellState();
    state.setInbox([
      { roomId: 'room-alice', title: 'Alice Nakamura', unreadCount: 2, unread_count: 2, isMarkedUnread: true, is_marked_unread: true }
    ]);

    state.markConversationAsRead('room-alice');

    const conv = state.conversations.find((c) => c.roomId === 'room-alice');
    assert.equal(conv.unreadCount, 0);
    assert.equal(conv.unread_count, 0);
    assert.equal(conv.isMarkedUnread, false);
    assert.equal(conv.is_marked_unread, false);
    assert.equal(state._markedUnreadRooms.has('room-alice'), false);
  });

  test('2. conversationToSqlitePayload serializes unreadCount 0 and isMarkedUnread 0 after read', () => {
    const conv = {
      roomId: 'room-alice',
      title: 'Alice Nakamura',
      unreadCount: 0,
      unread_count: 0,
      isMarkedUnread: false,
      is_marked_unread: false,
      lastMessage: {
        id: 'msg-100',
        preview: 'See you tomorrow',
        createdAt: '2026-11-17T09:00:00Z',
        eventSeq: 5
      }
    };

    const payload = conversationToSqlitePayload(conv);
    assert.equal(payload.unreadCount, 0);
    assert.equal(payload.isMarkedUnread, 0);
    assert.equal(payload.lastEventSeq, 5);
    assert.equal(payload.lastMessagePreview, 'See you tomorrow');
  });

  test('3. sqliteRowToConversation preserves lastEventSeq, lastMessageId, lastMessageTime on conversation object', () => {
    const row = {
      room_id: 'room-alice',
      kind: 'direct',
      peer_display_name: 'Alice Nakamura',
      last_message_id: 'msg-100',
      last_message_preview: 'Message',
      last_message_time: '2026-11-17T09:00:00Z',
      last_event_seq: 12,
      unread_count: 0,
      is_marked_unread: 0
    };

    const conv = sqliteRowToConversation(row);
    assert.equal(conv.roomId, 'room-alice');
    assert.equal(conv.unreadCount, 0);
    assert.equal(conv.lastEventSeq, 12);
    assert.equal(conv.lastMessageId, 'msg-100');
    assert.equal(conv.lastMessageTime, '2026-11-17T09:00:00Z');
  });

  test('4. normalizeInboxItem preserves lastMessage properties and direct eventSeq and timestamp', () => {
    const raw = {
      room_id: 'room-alice',
      kind: 'direct',
      last_message: {
        preview: 'Message',
        sender_id: 'user-alice',
        created_at: '2026-11-17T09:00:00Z',
        event_seq: 12
      },
      unread_count: 2
    };

    const item = normalizeInboxItem(raw);
    assert.equal(item.roomId, 'room-alice');
    assert.equal(item.lastEventSeq, 12);
    assert.equal(item.lastMessageTime, '2026-11-17T09:00:00Z');
    assert.equal(item.lastMessage.preview, 'Message');
    assert.equal(item.lastMessage.eventSeq, 12);
  });

  test('5. Reopen reconciliation: Stale server unread count (2) does NOT overwrite read local conversation (0)', () => {
    const currentUserId = 'user-me';

    // Simulated local SQLite cached conversation (previously opened & read by user)
    const dbConvs = [
      {
        roomId: 'room-alice',
        title: 'Alice Nakamura',
        unreadCount: 0,
        unread_count: 0,
        isMarkedUnread: false,
        is_marked_unread: false,
        lastMessage: {
          preview: 'Message',
          senderId: 'user-alice',
          createdAt: '2026-11-17T09:00:00Z',
          eventSeq: 12
        },
        lastEventSeq: 12,
        lastMessageTime: '2026-11-17T09:00:00Z'
      },
      {
        roomId: 'room-group',
        title: 'Weekend plans',
        unreadCount: 0,
        unread_count: 0,
        isMarkedUnread: false,
        is_marked_unread: false,
        lastMessage: {
          preview: 'Message',
          senderId: 'user-bob',
          createdAt: '2026-11-17T08:30:00Z',
          eventSeq: 8
        },
        lastEventSeq: 8,
        lastMessageTime: '2026-11-17T08:30:00Z'
      }
    ];

    // Simulated server inbox response on reopen (stale unread_count: 2 from server)
    const serverInbox = [
      {
        roomId: 'room-alice',
        title: 'Alice Nakamura',
        unreadCount: 2,
        unread_count: 2,
        lastMessage: {
          preview: 'Message',
          senderId: 'user-alice',
          createdAt: '2026-11-17T09:00:00Z',
          eventSeq: 12
        },
        lastEventSeq: 12,
        lastMessageTime: '2026-11-17T09:00:00Z'
      },
      {
        roomId: 'room-group',
        title: 'Weekend plans',
        unreadCount: 2,
        unread_count: 2,
        lastMessage: {
          preview: 'Message',
          senderId: 'user-bob',
          createdAt: '2026-11-17T08:30:00Z',
          eventSeq: 8
        },
        lastEventSeq: 8,
        lastMessageTime: '2026-11-17T08:30:00Z'
      }
    ];

    // Execute the reconciliation logic from loadInbox()
    for (const conv of serverInbox) {
      const convId = conv.roomId || conv.room_id || conv.id;
      const localMatch = dbConvs.find((dbC) => (dbC.roomId || dbC.room_id || dbC.id) === convId);
      if (localMatch) {
        const isLastMsgOwn = isOwnMessage(conv.lastMessage, currentUserId);
        const localLastId = localMatch.lastMessage?.id || localMatch.lastMessageId || localMatch.last_message_id;
        const serverLastId = conv.lastMessage?.id || conv.last_message?.id || conv.lastMessage?.message_id || conv.last_message?.message_id;

        const localSeq = Number(localMatch.lastMessage?.eventSeq ?? localMatch.lastMessage?.event_seq ?? localMatch.lastEventSeq ?? localMatch.last_event_seq ?? 0);
        const serverSeq = Number(conv.lastMessage?.eventSeq ?? conv.lastMessage?.event_seq ?? conv.last_message?.event_seq ?? 0);

        const localTime = localMatch.lastMessage?.createdAt || localMatch.lastMessage?.created_at || localMatch.lastMessageTime || localMatch.last_message_time || localMatch.updatedAt || localMatch.updated_at;
        const serverTime = conv.lastMessage?.createdAt || conv.lastMessage?.created_at || conv.lastMessageTime || conv.last_message_time || conv.updatedAt || conv.updated_at;

        const localPreview = (localMatch.lastMessage?.preview || localMatch.preview || localMatch.last_message_preview || '').trim();
        const serverPreview = (conv.lastMessage?.preview || conv.preview || conv.last_message?.preview || '').trim();

        const localUnread = localMatch.unreadCount ?? localMatch.unread_count ?? 0;
        const localMarkedUnread = Boolean(localMatch.isMarkedUnread || localMatch.is_marked_unread);

        const hasNewIncomingMsg = (() => {
          if (isLastMsgOwn) return false;
          if (serverSeq > 0 && localSeq > 0) {
            return serverSeq > localSeq;
          }
          if (serverLastId && localLastId && serverLastId !== localLastId) {
            if (serverTime && localTime) {
              return new Date(serverTime).getTime() > new Date(localTime).getTime() + 1000;
            }
            return true;
          }
          if (serverTime && localTime) {
            const sTime = new Date(serverTime).getTime();
            const lTime = new Date(localTime).getTime();
            if (sTime > lTime + 1000) return true;
            if (sTime <= lTime) return false;
          }
          if (localPreview && serverPreview && localPreview === serverPreview) {
            return false;
          }
          if (!conv.lastMessage) return false;
          return false;
        })();

        if (!localMarkedUnread && !conv.isMarkedUnread) {
          if (isLastMsgOwn) {
            conv.unreadCount = 0;
            conv.unread_count = 0;
          } else if (localUnread === 0 && !hasNewIncomingMsg) {
            conv.unreadCount = 0;
            conv.unread_count = 0;
          }
        }
      }
    }

    // Verify unreadCount is 0 for both conversations
    assert.equal(serverInbox[0].unreadCount, 0, 'Alice Nakamura unreadCount must remain 0');
    assert.equal(serverInbox[0].unread_count, 0, 'Alice Nakamura unread_count must remain 0');
    assert.equal(serverInbox[1].unreadCount, 0, 'Weekend plans unreadCount must remain 0');
    assert.equal(serverInbox[1].unread_count, 0, 'Weekend plans unread_count must remain 0');

    // Verify shellState reflects 0 unread chats
    const state = new ChatShellState();
    state.setInbox(serverInbox);
    assert.equal(state.getUnreadConversationsCount(), 0, 'Total unread conversations count must be 0');
    assert.equal(state.getRoomUnreadCount('room-alice'), 0);
    assert.equal(state.getRoomUnreadCount('room-group'), 0);
  });

  test('6. Reopen reconciliation: Genuinely NEW incoming message updates unread count accurately', () => {
    const currentUserId = 'user-me';

    const dbConvs = [
      {
        roomId: 'room-alice',
        title: 'Alice Nakamura',
        unreadCount: 0,
        unread_count: 0,
        lastMessage: {
          preview: 'Old message',
          senderId: 'user-alice',
          createdAt: '2026-11-17T09:00:00Z',
          eventSeq: 12
        },
        lastEventSeq: 12,
        lastMessageTime: '2026-11-17T09:00:00Z'
      }
    ];

    const serverInbox = [
      {
        roomId: 'room-alice',
        title: 'Alice Nakamura',
        unreadCount: 1,
        unread_count: 1,
        lastMessage: {
          preview: 'Brand new message while app was closed!',
          senderId: 'user-alice',
          createdAt: '2026-11-17T10:00:00Z',
          eventSeq: 13
        },
        lastEventSeq: 13,
        lastMessageTime: '2026-11-17T10:00:00Z'
      }
    ];

    for (const conv of serverInbox) {
      const convId = conv.roomId || conv.room_id || conv.id;
      const localMatch = dbConvs.find((dbC) => (dbC.roomId || dbC.room_id || dbC.id) === convId);
      if (localMatch) {
        const isLastMsgOwn = isOwnMessage(conv.lastMessage, currentUserId);
        const localSeq = Number(localMatch.lastMessage?.eventSeq ?? localMatch.lastMessage?.event_seq ?? localMatch.lastEventSeq ?? 0);
        const serverSeq = Number(conv.lastMessage?.eventSeq ?? conv.lastMessage?.event_seq ?? conv.last_message?.event_seq ?? 0);

        const localTime = localMatch.lastMessage?.createdAt || localMatch.lastMessage?.created_at || localMatch.lastMessageTime;
        const serverTime = conv.lastMessage?.createdAt || conv.lastMessage?.created_at || conv.lastMessageTime;

        const hasNewIncomingMsg = Boolean(!isLastMsgOwn && ((serverSeq > 0 && localSeq > 0 && serverSeq > localSeq) || (serverTime && localTime && new Date(serverTime).getTime() > new Date(localTime).getTime() + 1000)));

        const localUnread = localMatch.unreadCount ?? localMatch.unread_count ?? 0;
        const localMarkedUnread = Boolean(localMatch.isMarkedUnread || localMatch.is_marked_unread);

        if (!localMarkedUnread && !conv.isMarkedUnread) {
          if (isLastMsgOwn) {
            conv.unreadCount = 0;
            conv.unread_count = 0;
          } else if (localUnread === 0 && !hasNewIncomingMsg) {
            conv.unreadCount = 0;
            conv.unread_count = 0;
          }
        }
      }
    }

    assert.equal(serverInbox[0].unreadCount, 1, 'Brand new message must retain unreadCount: 1');
  });
});

