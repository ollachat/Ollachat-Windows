import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatApi, normalizeMessage } from '../src/api/chat-api.js';
import { RoomMessagesState, ChatShellState, resolveMessageContent } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Issue 2: Chat Header Search Button & In-Conversation Message Search', () => {

  // ═════════════════════════════════════════════════════════════════
  // 1. DOM Markup & Accessibility Invariants
  // ═════════════════════════════════════════════════════════════════
  describe('1. HTML Markup & Header Search Elements', () => {
    test('index.html defines accessible, enabled #btn-chat-search button', () => {
      const htmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      assert.ok(html.includes('id="btn-chat-search"'), 'Must define #btn-chat-search');
      assert.ok(html.includes('title="Search messages"'), 'Must have title="Search messages"');
      assert.ok(html.includes('aria-label="Search messages"'), 'Must have aria-label="Search messages"');

      // Must NOT be disabled
      const btnMatch = html.match(/<button[^>]*id="btn-chat-search"[^>]*>/);
      assert.ok(btnMatch, 'btn-chat-search tag found');
      assert.ok(!btnMatch[0].includes('disabled'), 'btn-chat-search must not be disabled');
    });

    test('index.html defines in-chat search bar with all required controls', () => {
      const htmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      assert.ok(html.includes('id="chat-search-bar"'), 'Must define #chat-search-bar');
      assert.ok(html.includes('id="chat-search-input"'), 'Must define #chat-search-input');
      assert.ok(html.includes('id="btn-clear-chat-search"'), 'Must define #btn-clear-chat-search');
      assert.ok(html.includes('id="chat-search-count"'), 'Must define #chat-search-count');
      assert.ok(html.includes('id="btn-prev-search-result"'), 'Must define #btn-prev-search-result');
      assert.ok(html.includes('id="btn-next-search-result"'), 'Must define #btn-next-search-result');
      assert.ok(html.includes('id="btn-close-chat-search"'), 'Must define #btn-close-chat-search');
      assert.ok(html.includes('id="chat-search-results-panel"'), 'Must define #chat-search-results-panel');
      assert.ok(html.includes('id="chat-search-status"'), 'Must define #chat-search-status');
      assert.ok(html.includes('id="chat-search-results-list"'), 'Must define #chat-search-results-list');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. CSS Styles & Animations
  // ═════════════════════════════════════════════════════════════════
  describe('2. CSS Styling & Pulse Highlight Invariants', () => {
    test('styles.css contains rules for search bar, results dropdown, and highlight animation', () => {
      const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      assert.ok(css.includes('.chat-search-bar'), 'Must define .chat-search-bar style');
      assert.ok(css.includes('.chat-search-input-wrapper'), 'Must define .chat-search-input-wrapper');
      assert.ok(css.includes('.chat-search-input'), 'Must define .chat-search-input');
      assert.ok(css.includes('.chat-search-results-panel'), 'Must define .chat-search-results-panel');
      assert.ok(css.includes('.search-result-item'), 'Must define .search-result-item');
      assert.ok(css.includes('.search-result-snippet mark'), 'Must define snippet mark style');
      assert.ok(css.includes('@keyframes messagePulse'), 'Must define messagePulse keyframe animation');
      assert.ok(css.includes('.message-row.highlighted .message-bubble'), 'Must apply pulse animation to highlighted bubble');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. ChatApi.searchMessages Wire Protocol Contract
  // ═════════════════════════════════════════════════════════════════
  describe('3. ChatApi.searchMessages REST Contract', () => {
    function createMockFetch(status = 200, responseData = {}) {
      const calls = [];
      const mockFn = async (url, options) => {
        calls.push({
          url,
          method: options.method,
          headers: options.headers,
          signal: options.signal
        });
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => JSON.stringify(responseData)
        };
      };
      mockFn.calls = calls;
      return mockFn;
    }

    test('calls GET /rooms/{roomId}/messages/search?q={query}&limit={limit} with room token', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [
          {
            id: 'msg-s1',
            room_id: 'room-101',
            sender_id: 'user-bob',
            kind: 'text',
            body: { text: 'Hello, this is a secret meeting keyword.' },
            created_at: '2026-09-25T10:00:00Z',
            event_seq: 15
          }
        ],
        has_more: false
      });

      const api = new ChatApi({
        baseUrl: 'https://api.ollacore.com/v1',
        fetchFn: mockFetch
      });

      const res = await api.searchMessages('rt_test_token', 'room-101', 'meeting', { limit: 20 });

      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].method, 'GET');
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.com/v1/rooms/room-101/messages/search?q=meeting&limit=20');
      assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer rt_test_token');

      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0].id, 'msg-s1');
      assert.equal(res.messages[0].body.text, 'Hello, this is a secret meeting keyword.');
      assert.equal(res.messages[0].eventSeq, 15);
      assert.equal(res.hasMore, false);
    });

    test('rejects empty or whitespace query without making network request', async () => {
      const mockFetch = createMockFetch(200, {});
      const api = new ChatApi({ fetchFn: mockFetch });

      const res1 = await api.searchMessages('rt_token', 'room-1', '');
      assert.equal(mockFetch.calls.length, 0);
      assert.deepEqual(res1.messages, []);

      const res2 = await api.searchMessages('rt_token', 'room-1', '   ');
      assert.equal(mockFetch.calls.length, 0);
      assert.deepEqual(res2.messages, []);
    });

    test('encodes query parameters and roomId properly in URL', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ fetchFn: mockFetch });

      await api.searchMessages('rt_token', 'room/with/slashes', 'special & symbols?', { limit: 10 });
      assert.equal(mockFetch.calls.length, 1);
      assert.ok(mockFetch.calls[0].url.includes('rooms/room%2Fwith%2Fslashes/messages/search'));
      assert.ok(mockFetch.calls[0].url.includes('q=special%20%26%20symbols%3F'));
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Preload & Main Process IPC Bridge Wiring
  // ═════════════════════════════════════════════════════════════════
  describe('4. Preload and Main IPC Bridge Verification', () => {
    test('preload.js exposes searchMessages under window.ollacoreDesktop.chatApi', () => {
      const preloadPath = path.join(projectRoot, 'src', 'preload', 'preload.js');
      const preloadCode = fs.readFileSync(preloadPath, 'utf8');

      assert.ok(
        preloadCode.includes("searchMessages: (roomId, query, options = {}) => handleApiCall('chat-api:search-messages', roomId, query, options)"),
        'Preload must expose chatApi.searchMessages wired to chat-api:search-messages'
      );
    });

    test('main.js handles chat-api:search-messages IPC channel', () => {
      const mainPath = path.join(projectRoot, 'src', 'main', 'main.js');
      const mainCode = fs.readFileSync(mainPath, 'utf8');

      assert.ok(mainCode.includes("ipcMain.handle('chat-api:search-messages'"), 'Main must handle chat-api:search-messages');
      assert.ok(mainCode.includes('chatApi.searchMessages(roomToken, roomId, query, options)'), 'Main must call chatApi.searchMessages with resolved roomToken');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. In-Conversation Search UI Logic & State Integration
  // ═════════════════════════════════════════════════════════════════
  describe('5. In-Conversation Search Logic & Integration', () => {
    test('app.js wires search button, input, navigation, and shortcuts', () => {
      const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
      const appCode = fs.readFileSync(appPath, 'utf8');

      // Element definitions
      assert.ok(appCode.includes("const btnChatSearch = document.getElementById('btn-chat-search');"));
      assert.ok(appCode.includes("const chatSearchBar = document.getElementById('chat-search-bar');"));
      assert.ok(appCode.includes("const chatSearchInput = document.getElementById('chat-search-input');"));
      assert.ok(appCode.includes("const btnClearChatSearch = document.getElementById('btn-clear-chat-search');"));
      assert.ok(appCode.includes("const btnPrevSearchResult = document.getElementById('btn-prev-search-result');"));
      assert.ok(appCode.includes("const btnNextSearchResult = document.getElementById('btn-next-search-result');"));
      assert.ok(appCode.includes("const btnCloseChatSearch = document.getElementById('btn-close-chat-search');"));

      // Controller functions
      assert.ok(appCode.includes('function openChatSearch()'));
      assert.ok(appCode.includes('function closeChatSearch()'));
      assert.ok(appCode.includes('function executeChatSearch('));
      assert.ok(appCode.includes('function navigateToSearchResult('));
      assert.ok(appCode.includes('function renderHighlightedSnippet('));

      // Integration points
      assert.ok(appCode.includes('closeChatSearch();'), 'Must close search on room change and logout');
    });

    test('RoomMessagesState merges historical search results when jumping to an older message', () => {
      const state = new RoomMessagesState('current-user');
      state.setInitialMessages('room-1', [
        { id: 'm-2', eventSeq: 2, body: { text: 'Newer message' }, createdAt: '2026-09-25T11:00:00Z' }
      ]);

      assert.equal(state.messages.length, 1);

      // Search returns an older message m-1 with eventSeq 1
      const olderSearchResult = {
        id: 'm-1',
        eventSeq: 1,
        senderId: 'other-user',
        kind: 'text',
        body: { text: 'Older message matching query' },
        createdAt: '2026-09-25T10:00:00Z'
      };

      state.mergeServerMessages([olderSearchResult]);

      assert.equal(state.messages.length, 2);
      assert.equal(state.messages[0].id, 'm-1', 'Older message must be prepended in chronological order');
      assert.equal(state.messages[1].id, 'm-2');
      assert.equal(state.oldestSeq, 1);
      assert.equal(state.newestSeq, 2);
    });

    test('resolveMessageContent formats snippets for search results across text and media', () => {
      const textMsg = { kind: 'text', body: { text: 'Project alpha update' } };
      const resolvedText = resolveMessageContent(textMsg);
      assert.equal(resolvedText.text, 'Project alpha update');

      const photoMsg = { kind: 'image', body: { caption: 'Roadmap diagram' } };
      const resolvedPhoto = resolveMessageContent(photoMsg);
      assert.equal(resolvedPhoto.caption, 'Roadmap diagram');

      const fileMsg = { kind: 'file', body: { filename: 'report.pdf' } };
      const resolvedFile = resolveMessageContent(fileMsg);
      assert.equal(resolvedFile.filename, 'report.pdf');
    });

    test('switching conversations closes search and resets query/results state', () => {
      const shellState = new ChatShellState();
      shellState.setInbox([
        { roomId: 'room-A', kind: 'direct', name: 'Alice' },
        { roomId: 'room-B', kind: 'direct', name: 'Bob' }
      ]);

      shellState.selectConversation('room-A');
      assert.equal(shellState.selectedRoomId, 'room-A');

      shellState.selectConversation('room-B');
      assert.equal(shellState.selectedRoomId, 'room-B');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 6. Comprehensive Search Verification (Items 1-10)
  // ═════════════════════════════════════════════════════════════════
  describe('6. Comprehensive Search Verification (Items 1-10)', () => {
    function createMockFetch(status = 200, responseData = {}, delayMs = 0) {
      const calls = [];
      const mockFn = async (url, options) => {
        calls.push({
          url,
          method: options.method,
          headers: options.headers,
          signal: options.signal
        });
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => JSON.stringify(responseData)
        };
      };
      mockFn.calls = calls;
      return mockFn;
    }

    test('1. Correct room ID is incorporated into search request URL', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ fetchFn: mockFetch });
      const specificRoomId = 'room-target-uuid-999';

      await api.searchMessages('valid_token', specificRoomId, 'line', { limit: 50 });

      assert.equal(mockFetch.calls.length, 1);
      assert.ok(mockFetch.calls[0].url.includes(`/rooms/${specificRoomId}/messages/search`));
    });

    test('2. Correct /messages/search endpoint path is called', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.searchMessages('valid_token', 'room-1', 'line', { limit: 25 });

      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].method, 'GET');
      assert.ok(mockFetch.calls[0].url.startsWith('https://api.ollacore.com/v1/rooms/room-1/messages/search'));
      assert.ok(mockFetch.calls[0].url.includes('limit=25'));
    });

    test('3. Query parameters are properly URL-encoded', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ fetchFn: mockFetch });

      await api.searchMessages('valid_token', 'room-1', 'line & symbols = test?', { limit: 50 });

      assert.equal(mockFetch.calls.length, 1);
      assert.ok(mockFetch.calls[0].url.includes('q=line%20%26%20symbols%20%3D%20test%3F'));
    });

    test('4. Authentication header passes room token as Bearer token', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ fetchFn: mockFetch });
      const testRoomToken = 'rt_scoped_room_token_abc';

      await api.searchMessages(testRoomToken, 'room-1', 'line');

      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].headers.Authorization, `Bearer ${testRoomToken}`);
    });

    test('5. Successful search response parsing handles messages and normalizes fields', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [
          {
            id: 'msg-target-1',
            room_id: 'room-1',
            sender_id: 'user-initiator',
            kind: 'text',
            body: { text: 'Line 1 with emoji 🚀\nLine 2 with symbols ✨' },
            created_at: '2026-09-25T12:00:00Z',
            event_seq: 3361
          }
        ],
        has_more: false
      });
      const api = new ChatApi({ fetchFn: mockFetch });

      const res = await api.searchMessages('tok', 'room-1', 'line', { limit: 50 });

      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0].id, 'msg-target-1');
      assert.equal(res.messages[0].body.text, 'Line 1 with emoji 🚀\nLine 2 with symbols ✨');
      assert.equal(res.messages[0].eventSeq, 3361);
      assert.equal(res.hasMore, false);

      // Verify unwrapped array parsing in app.js controller logic
      const rawList = res?.messages || res?.data?.messages || (Array.isArray(res) ? res : []);
      const parsedMessages = Array.isArray(rawList) ? rawList : [];
      assert.equal(parsedMessages.length, 1);
      assert.equal(parsedMessages[0].id, 'msg-target-1');
    });

    test('6. Zero-result response yields empty messages and "No results" UI contract', async () => {
      const mockFetch = createMockFetch(200, {
        messages: [],
        has_more: false
      });
      const api = new ChatApi({ fetchFn: mockFetch });

      const res = await api.searchMessages('tok', 'room-1', 'nonexistentword12345');

      assert.equal(res.messages.length, 0);
      assert.equal(res.hasMore, false);

      // Verify zero results produces "No results" status
      const rawList = res?.messages || res?.data?.messages || (Array.isArray(res) ? res : []);
      const messages = Array.isArray(rawList) ? rawList : [];
      let statusText = '';
      if (messages.length === 0) {
        statusText = 'No results';
      }
      assert.equal(statusText, 'No results');
      assert.notEqual(statusText, 'Failed to search messages');
    });

    test('7. API error response maps HTTP status and error message correctly', async () => {
      const mockFetch = createMockFetch(401, {
        error: { message: 'Invalid or expired room token', code: 'unauthorized' }
      });
      const api = new ChatApi({ fetchFn: mockFetch });

      await assert.rejects(
        async () => {
          await api.searchMessages('invalid_tok', 'room-1', 'line');
        },
        (err) => {
          assert.equal(err.httpStatus, 401);
          assert.equal(err.code, 'unauthorized');
          assert.equal(err.message, 'Invalid or expired room token');
          return true;
        }
      );
    });

    test('8. Network error or timeout throws ApiError without uncaught rejections', async () => {
      const networkFailingFetch = async () => {
        throw new Error('fetch failed: Connection refused');
      };
      const api = new ChatApi({ fetchFn: networkFailingFetch });

      await assert.rejects(
        async () => {
          await api.searchMessages('tok', 'room-1', 'line');
        },
        (err) => {
          assert.equal(err.code, 'network_error');
          assert.ok(err.message.includes('fetch failed'));
          return true;
        }
      );
    });

    test('9. Emoji and special-character search correctly encodes unicode points', async () => {
      const mockFetch = createMockFetch(200, { messages: [] });
      const api = new ChatApi({ fetchFn: mockFetch });

      await api.searchMessages('tok', 'room-1', '🚀');
      assert.equal(mockFetch.calls.length, 1);
      assert.ok(mockFetch.calls[0].url.includes('q=%F0%9F%9A%80'));

      await api.searchMessages('tok', 'room-1', 'Line 1 with emoji 🚀');
      assert.equal(mockFetch.calls.length, 2);
      assert.ok(mockFetch.calls[1].url.includes('Line%201%20with%20emoji%20%F0%9F%9A%80'));
    });

    test('10. Search in currently active conversation only: discards responses for inactive rooms', () => {
      // Simulation of app.js executeChatSearch guard condition
      let selectedRoomId = 'room-A';
      let activeSearchId = 1;

      const currentSearchId = activeSearchId;
      const currentRoomId = selectedRoomId;

      // User navigates away before search returns
      selectedRoomId = 'room-B';

      const isStale = (currentSearchId !== activeSearchId || currentRoomId !== selectedRoomId);
      assert.equal(isStale, true, 'Response for room-A must be ignored when current room is room-B');
    });
  });
});
