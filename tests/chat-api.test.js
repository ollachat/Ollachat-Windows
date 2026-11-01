import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatApi,
  RoomTokenCache,
  normalizeConversation,
  normalizeInboxItem,
  normalizeMessage,
  normalizeParticipant
} from '../src/api/chat-api.js';
import { ApiError } from '../src/api/api-error.js';

describe('ChatApi Unit Tests (Conversations & Rooms REST API)', () => {
  const TEST_BASE = 'https://api.test.local/v1';
  const MOCK_SESSION_TOKEN = 'mock_session_token_xyz_123';
  const MOCK_ROOM_TOKEN = 'mock_room_token_abc_456';

  function createMockFetch(status = 200, responseData = {}, headers = {}) {
    const calls = [];
    const mockFn = async (url, options) => {
      calls.push({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null,
        signal: options.signal
      });

      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(headers),
        text: async () => (status === 204 ? '' : JSON.stringify(responseData))
      };
    };
    mockFn.calls = calls;
    return mockFn;
  }

  // ═════════════════════════════════════════════════════════════════
  // 1. Data Normalization Tests
  // ═════════════════════════════════════════════════════════════════
  describe('Data Normalization Helpers', () => {
    test('normalizeConversation maps fields and preserves snake_case', () => {
      const raw = {
        room_id: 'room_101',
        kind: 'direct',
        name: 'Alice',
        created_at: '2026-09-21T10:00:00Z'
      };
      const normalized = normalizeConversation(raw);
      assert.equal(normalized.roomId, 'room_101');
      assert.equal(normalized.room_id, 'room_101');
      assert.equal(normalized.kind, 'direct');
      assert.equal(normalized.name, 'Alice');
      assert.equal(normalized.createdAt, '2026-09-21T10:00:00Z');
      assert.equal(normalized.created_at, '2026-09-21T10:00:00Z');
    });

    test('normalizeInboxItem preserves peer, last_message, and unreadCount', () => {
      const raw = {
        room_id: 'room_202',
        kind: 'direct',
        name: null,
        peer: {
          phone: '+15551234567',
          user_id: 'user_alice',
          display_name: 'Alice Smith'
        },
        last_message: {
          preview: 'See you tomorrow!',
          sender_id: 'user_alice',
          created_at: '2026-09-21T12:00:00Z',
          event_seq: 42,
          kind: 'text'
        },
        unread_count: 3
      };
      const item = normalizeInboxItem(raw);
      assert.equal(item.roomId, 'room_202');
      assert.equal(item.unreadCount, 3);
      assert.equal(item.peer.userId, 'user_alice');
      assert.equal(item.peer.displayName, 'Alice Smith');
      assert.equal(item.lastMessage.preview, 'See you tomorrow!');
      assert.equal(item.lastMessage.eventSeq, 42);
      assert.equal(item.lastMessage.kind, 'text');
    });

    test('normalizeMessage preserves body, event_seq, reactions, and attachments', () => {
      const raw = {
        id: 'msg_999',
        room_id: 'room_303',
        sender_id: 'user_bob',
        kind: 'text',
        body: { text: 'Hello World' },
        created_at: '2026-09-21T14:30:00Z',
        event_seq: 15,
        client_message_id: 'uuid_local',
        reply_to: 'msg_888',
        edited_at: null,
        reactions: { '👍': ['user_1', 'user_2'] },
        attachment_ids: ['att_1'],
        attachments: [
          { attachment_id: 'att_1', mime: 'image/jpeg', filename: 'photo.jpg', byte_size: 45000 }
        ]
      };
      const msg = normalizeMessage(raw);
      assert.equal(msg.id, 'msg_999');
      assert.equal(msg.roomId, 'room_303');
      assert.equal(msg.senderId, 'user_bob');
      assert.deepEqual(msg.body, { text: 'Hello World' });
      assert.equal(msg.eventSeq, 15);
      assert.equal(msg.clientMessageId, 'uuid_local');
      assert.equal(msg.replyTo, 'msg_888');
      assert.deepEqual(msg.reactions['👍'], ['user_1', 'user_2']);
      assert.deepEqual(msg.attachmentIds, ['att_1']);
      assert.equal(msg.attachments.length, 1);
      assert.equal(msg.attachments[0].attachmentId, 'att_1');
      assert.equal(msg.attachments[0].mime, 'image/jpeg');
      assert.equal(msg.attachments[0].byteSize, 45000);
    });

    test('normalizeParticipant parses participant and role', () => {
      const raw = {
        principal_id: 'user_charlie',
        role: 'admin',
        display_name: 'Charlie Admin',
        phone: '+15559876543'
      };
      const p = normalizeParticipant(raw);
      assert.equal(p.principalId, 'user_charlie');
      assert.equal(p.role, 'admin');
      assert.equal(p.displayName, 'Charlie Admin');
      assert.equal(p.phone, '+15559876543');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. Directory Plane Endpoints (Session Token Auth)
  // ═════════════════════════════════════════════════════════════════
  describe('Directory Plane Endpoints', () => {
    test('listConversations sends GET /directory/conversations with Bearer session token', async () => {
      const mockFetch = createMockFetch(200, {
        conversations: [
          { room_id: 'r1', kind: 'direct', name: 'Bob', created_at: '2026-09-20T10:00:00Z' }
        ]
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.listConversations(MOCK_SESSION_TOKEN);

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/conversations`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.equal(result.conversations.length, 1);
      assert.equal(result.conversations[0].roomId, 'r1');
    });

    test('getInbox sends GET /directory/inbox?limit=30 with Bearer session token', async () => {
      const mockFetch = createMockFetch(200, {
        conversations: [
          {
            room_id: 'r2',
            kind: 'direct',
            name: null,
            peer: { phone: '+15551112222', user_id: 'u2', display_name: 'Dave' },
            last_message: { preview: 'Hey there', sender_id: 'u2', event_seq: 5 },
            unread_count: 1
          }
        ]
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.getInbox(MOCK_SESSION_TOKEN, { limit: 15 });

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/inbox?limit=15`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.equal(result.conversations.length, 1);
      assert.equal(result.conversations[0].unreadCount, 1);
      assert.equal(result.conversations[0].peer.displayName, 'Dave');
    });

    test('openDirectConversation sends POST /directory/conversations/direct with peer_user_id', async () => {
      const mockFetch = createMockFetch(200, {
        room_id: 'room_direct_77',
        kind: 'direct',
        name: null
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.openDirectConversation(MOCK_SESSION_TOKEN, 'peer_user_456');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/conversations/direct`);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.deepEqual(call.body, { peer_user_id: 'peer_user_456' });
      assert.equal(result.roomId, 'room_direct_77');
      assert.equal(result.kind, 'direct');
    });

    test('createGroupConversation sends POST /directory/conversations/group with members and name', async () => {
      const mockFetch = createMockFetch(200, {
        room_id: 'room_group_88',
        kind: 'group',
        name: 'Project Alpha'
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.createGroupConversation(MOCK_SESSION_TOKEN, {
        memberUserIds: ['user_a', 'user_b'],
        name: 'Project Alpha'
      });

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/conversations/group`);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.deepEqual(call.body, {
        member_user_ids: ['user_a', 'user_b'],
        name: 'Project Alpha'
      });
      assert.equal(result.roomId, 'room_group_88');
      assert.equal(result.name, 'Project Alpha');
    });

    test('getRoomToken sends GET /directory/conversations/{roomId}/token?device_id={deviceId}', async () => {
      const mockFetch = createMockFetch(200, {
        access_token: 'room_tok_secret_999',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        chat_websocket_url: 'wss://api.ollacore.com/v1/chat/ws',
        rtc_websocket_url: 'wss://api.ollacore.com/v1/rtc/ws',
        ice_servers: [{ urls: ['turn:turn.ollacore.com'] }]
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.getRoomToken(MOCK_SESSION_TOKEN, 'room_101', 'windows-test-uuid');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/conversations/room_101/token?device_id=windows-test-uuid`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.equal(result.access_token, 'room_tok_secret_999');

      // Check that it was cached
      const cached = api.roomTokenCache.get('room_101');
      assert.equal(cached, 'room_tok_secret_999');
    });

    test('lookupContacts sends POST /directory/contacts/lookup with phones array', async () => {
      const mockFetch = createMockFetch(200, {
        contacts: [
          { user_id: 'usr_c1', phone: '+15553334444', display_name: 'Charlie' }
        ]
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.lookupContacts(MOCK_SESSION_TOKEN, ['+15553334444']);

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/directory/contacts/lookup`);
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.body, { phones: ['+15553334444'] });
      assert.equal(result.contacts.length, 1);
      assert.equal(result.contacts[0].userId, 'usr_c1');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Room Plane Endpoints (Room Token Auth & Sequence Cursors)
  // ═════════════════════════════════════════════════════════════════
  describe('Room Plane Endpoints', () => {
    test('listMessages sends GET /rooms/{roomId}/messages with sequence cursors and room token', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [
          { id: 'm1', room_id: 'r1', sender_id: 'u1', kind: 'text', body: { text: 'Hi' }, created_at: '2026-09-21T10:00:00Z', event_seq: 10 }
        ],
        has_more: true
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.listMessages(MOCK_ROOM_TOKEN, 'r1', {
        limit: 25,
        beforeSeq: 50,
        afterSeq: 5
      });

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/rooms/r1/messages?limit=25&after_seq=5&before_seq=50`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_ROOM_TOKEN}`);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].id, 'm1');
      assert.equal(result.hasMore, true);
      assert.equal(result.has_more, true);
    });

    test('listMessages preserves has_more = false when reaching end of history', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [],
        has_more: false
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.listMessages(MOCK_ROOM_TOKEN, 'r1', { limit: 50 });

      assert.equal(result.messages.length, 0);
      assert.equal(result.hasMore, false);
      assert.equal(result.has_more, false);
    });

    test('getParticipants sends GET /rooms/{roomId}/participants with Bearer room token', async () => {
      const mockFetch = createMockFetch(200, {
        participants: [
          { principal_id: 'p1', role: 'admin', display_name: 'Admin Alice' },
          { principal_id: 'p2', role: 'member', display_name: 'Member Bob' }
        ]
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.getParticipants(MOCK_ROOM_TOKEN, 'room_abc');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/rooms/room_abc/participants`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_ROOM_TOKEN}`);
      assert.equal(result.participants.length, 2);
      assert.equal(result.participants[0].principalId, 'p1');
      assert.equal(result.participants[0].role, 'admin');
    });

    test('getUnread sends GET /rooms/{roomId}/unread with Bearer room token', async () => {
      const mockFetch = createMockFetch(200, {
        unread_count: 5,
        last_read_seq: 120
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.getUnread(MOCK_ROOM_TOKEN, 'room_abc');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/rooms/room_abc/unread`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_ROOM_TOKEN}`);
      assert.equal(result.unreadCount, 5);
      assert.equal(result.lastReadSeq, 120);
    });

    test('searchMessages sends GET /rooms/{roomId}/messages/search?q={query}&limit={limit}', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [
          { id: 'm99', room_id: 'r1', sender_id: 'u1', kind: 'text', body: { text: 'lunch plan' }, created_at: '2026-09-21T11:00:00Z', event_seq: 80 }
        ],
        has_more: false
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      const result = await api.searchMessages(MOCK_ROOM_TOKEN, 'r1', 'lunch plan', { limit: 10 });

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.url, `${TEST_BASE}/rooms/r1/messages/search?q=lunch%20plan&limit=10`);
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_ROOM_TOKEN}`);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].body.text, 'lunch plan');
    });

    test('confirmed write operations send correct paths and methods', async () => {
      const mockFetch = createMockFetch(200, {
        id: 'msg_created',
        room_id: 'r1',
        sender_id: 'u1',
        kind: 'text',
        body: { text: 'REST Send' },
        created_at: '2026-09-21T12:00:00Z',
        event_seq: 101
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      // sendMessage
      await api.sendMessage(MOCK_ROOM_TOKEN, 'r1', {
        clientMessageId: 'cli-1',
        body: { text: 'REST Send' }
      });
      assert.equal(mockFetch.calls[0].url, `${TEST_BASE}/rooms/r1/messages`);
      assert.equal(mockFetch.calls[0].method, 'POST');

      // editMessage
      await api.editMessage(MOCK_ROOM_TOKEN, 'r1', 'm1', { text: 'Edited' });
      assert.equal(mockFetch.calls[1].url, `${TEST_BASE}/rooms/r1/messages/m1`);
      assert.equal(mockFetch.calls[1].method, 'PATCH');

      // deleteMessage
      await api.deleteMessage(MOCK_ROOM_TOKEN, 'r1', 'm1');
      assert.equal(mockFetch.calls[2].url, `${TEST_BASE}/rooms/r1/messages/m1`);
      assert.equal(mockFetch.calls[2].method, 'DELETE');
    });

    test('confirmed group management helpers send correct paths and methods', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      await api.addMember(MOCK_ROOM_TOKEN, 'r1', 'user_new');
      assert.equal(mockFetch.calls[0].url, `${TEST_BASE}/rooms/r1/members`);
      assert.equal(mockFetch.calls[0].method, 'POST');
      assert.deepEqual(mockFetch.calls[0].body, { user_id: 'user_new' });

      await api.removeMember(MOCK_ROOM_TOKEN, 'r1', 'user_remove');
      assert.equal(mockFetch.calls[1].url, `${TEST_BASE}/rooms/r1/members/user_remove`);
      assert.equal(mockFetch.calls[1].method, 'DELETE');

      await api.leaveGroup(MOCK_ROOM_TOKEN, 'r1');
      assert.equal(mockFetch.calls[2].url, `${TEST_BASE}/rooms/r1/members/me`);
      assert.equal(mockFetch.calls[2].method, 'DELETE');

      await api.updateGroup(MOCK_ROOM_TOKEN, 'r1', { name: 'New Name' });
      assert.equal(mockFetch.calls[3].url, `${TEST_BASE}/rooms/r1`);
      assert.equal(mockFetch.calls[3].method, 'PATCH');

      await api.setMemberRole(MOCK_ROOM_TOKEN, 'r1', 'user_admin', 'admin');
      assert.equal(mockFetch.calls[4].url, `${TEST_BASE}/rooms/r1/members/user_admin/role`);
      assert.equal(mockFetch.calls[4].method, 'POST');

      await api.createInvite(MOCK_ROOM_TOKEN, 'r1');
      assert.equal(mockFetch.calls[5].url, `${TEST_BASE}/rooms/r1/invites`);
      assert.equal(mockFetch.calls[5].method, 'POST');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Room Token In-Memory Cache
  // ═════════════════════════════════════════════════════════════════
  describe('Room Token Cache', () => {
    test('cache hit reuses token without issuing network call', async () => {
      const mockFetch = createMockFetch(200, {
        access_token: 'room_tok_cached',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        chat_websocket_url: 'wss://api.ollacore.com/v1/chat/ws'
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      // First call (cache miss)
      const token1 = await api.resolveRoomToken(MOCK_SESSION_TOKEN, 'room_cache_1', 'dev-1');
      assert.equal(token1, 'room_tok_cached');
      assert.equal(mockFetch.calls.length, 1);

      // Second call (cache hit)
      const token2 = await api.resolveRoomToken(MOCK_SESSION_TOKEN, 'room_cache_1', 'dev-1');
      assert.equal(token2, 'room_tok_cached');
      assert.equal(mockFetch.calls.length, 1); // No new network call
    });

    test('expired room token is evicted and refreshed via network', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          text: async () => JSON.stringify({
            access_token: `room_token_v${callCount}`,
            // Set expired or near-expired timestamp
            expires_at: new Date(Date.now() + 2000).toISOString()
          })
        };
      };
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      // Cache an already-expired token directly
      api.roomTokenCache.set('room_exp', {
        access_token: 'old_expired_token',
        expires_at: new Date(Date.now() - 5000).toISOString()
      });

      // resolveRoomToken should notice it is expired, evict it, and call network
      const freshToken = await api.resolveRoomToken(MOCK_SESSION_TOKEN, 'room_exp', 'dev-1');
      assert.equal(freshToken, 'room_token_v1');
      assert.equal(callCount, 1);
    });

    test('evict and clear successfully remove cached entries', () => {
      const cache = new RoomTokenCache();
      cache.set('r1', { access_token: 'tok_r1', expires_at: new Date(Date.now() + 3600000).toISOString() });
      cache.set('r2', { access_token: 'tok_r2', expires_at: new Date(Date.now() + 3600000).toISOString() });

      assert.equal(cache.get('r1'), 'tok_r1');
      cache.evict('r1');
      assert.equal(cache.get('r1'), null);
      assert.equal(cache.get('r2'), 'tok_r2');

      cache.clear();
      assert.equal(cache.get('r2'), null);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. Error Handling & Security
  // ═════════════════════════════════════════════════════════════════
  describe('Error Handling and Security', () => {
    test('converts 401 Unauthorized into typed ApiError', async () => {
      const mockFetch = createMockFetch(401, {
        error: { code: 'invalid_token', message: 'Token has expired' }
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      await assert.rejects(
        async () => api.listConversations('expired_token'),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'invalid_token');
          assert.equal(err.httpStatus, 401);
          assert.equal(err.message, 'Token has expired');
          return true;
        }
      );
    });

    test('converts 404 Room Not Found into typed ApiError', async () => {
      const mockFetch = createMockFetch(404, {
        error: { code: 'room_not_found', message: 'Room does not exist' }
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      await assert.rejects(
        async () => api.getParticipants(MOCK_ROOM_TOKEN, 'non_existent_room'),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'room_not_found');
          assert.equal(err.httpStatus, 404);
          return true;
        }
      );
    });

    test('handles request timeout cleanly', async () => {
      const mockFetch = async () => {
        const err = new Error('AbortError');
        err.name = 'AbortError';
        throw err;
      };
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      await assert.rejects(
        async () => api.listConversations(MOCK_SESSION_TOKEN),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.code, 'timeout');
          return true;
        }
      );
    });

    test('handles malformed non-JSON error response', async () => {
      const mockFetch = async () => ({
        status: 502,
        ok: false,
        headers: new Headers(),
        text: async () => '<html>Bad Gateway</html>'
      });
      const api = new ChatApi({ baseUrl: TEST_BASE, fetchFn: mockFetch });

      await assert.rejects(
        async () => api.listConversations(MOCK_SESSION_TOKEN),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.httpStatus, 502);
          return true;
        }
      );
    });

    test('rejection when calling without session token or room token', async () => {
      const api = new ChatApi({ baseUrl: TEST_BASE });

      await assert.rejects(() => api.listConversations(null), /Session token required/);
      await assert.rejects(() => api.listMessages(null, 'r1'), /Room token required/);
    });
  });
});
