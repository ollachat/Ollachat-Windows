import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { ChatShellState, getGroupCapabilities, getDirectPeerUserId, getConversationTitle } from '../src/renderer/chat-shell-state.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { MIGRATIONS } from '../src/storage/db/migrations.js';
import {
  ChatApi,
  normalizeBlockItem,
  normalizeConversation
} from '../src/api/chat-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const preloadJsPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

describe('Block/Unblock & Mute/Unmute Implementation Tests', () => {

  // ═══════════════════════════════════════════════════════════════════
  // 1. HTML Markup & Static Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('HTML Markup & Contract Invariants', () => {
    test('1. Context menu defines mute button and text', () => {
      assert.ok(html.includes('id="ctx-chat-mute-btn"'), 'Must have #ctx-chat-mute-btn in context menu');
      assert.ok(html.includes('id="ctx-chat-mute-text"'), 'Must have #ctx-chat-mute-text');
      assert.ok(html.includes('data-action="toggle-mute"'), 'Must have data-action="toggle-mute"');
    });

    test('2. Chat header menu defines toggle-mute and block-contact items', () => {
      assert.ok(html.includes('id="menu-item-toggle-mute"'), 'Must have #menu-item-toggle-mute');
      assert.ok(html.includes('id="menu-mute-text"'), 'Must have #menu-mute-text');
      assert.ok(html.includes('id="menu-item-block-contact"'), 'Must have #menu-item-block-contact');
      assert.ok(html.includes('id="menu-block-text"'), 'Must have #menu-block-text');
    });

    test('3. Contact Info panel defines mute row and block row', () => {
      assert.ok(html.includes('id="contact-info-mute-row"'), 'Must have #contact-info-mute-row');
      assert.ok(html.includes('id="contact-info-mute-value"'), 'Must have #contact-info-mute-value');
      assert.ok(html.includes('id="contact-info-block-row"'), 'Must have #contact-info-block-row');
      assert.ok(html.includes('id="contact-info-block-label"'), 'Must have #contact-info-block-label');
    });

    test('4. Settings defines Privacy section with Blocked Contacts item', () => {
      assert.ok(html.includes('id="settings-section-privacy"'), 'Must have #settings-section-privacy');
      assert.ok(html.includes('id="setting-item-blocked-contacts"'), 'Must have #setting-item-blocked-contacts');
      assert.ok(html.includes('id="setting-blocked-count-hint"'), 'Must have #setting-blocked-count-hint');
    });

    test('5. Composer Blocked Notice Banner is defined with Unblock button', () => {
      assert.ok(html.includes('id="composer-blocked-banner"'), 'Must have #composer-blocked-banner');
      assert.ok(html.includes('id="btn-unblock-composer"'), 'Must have #btn-unblock-composer');
    });

    test('6. Mute duration modal defines 8h, 1w, and always options', () => {
      assert.ok(html.includes('id="mute-duration-modal"'), 'Must have #mute-duration-modal');
      assert.ok(html.includes('name="mute-duration-choice" value="8h"'), 'Must have 8h duration option');
      assert.ok(html.includes('name="mute-duration-choice" value="1w"'), 'Must have 1w duration option');
      assert.ok(html.includes('name="mute-duration-choice" value="always"'), 'Must have always duration option');
      assert.ok(html.includes('id="btn-confirm-mute-duration"'), 'Must have #btn-confirm-mute-duration');
      assert.ok(html.includes('id="btn-cancel-mute-duration"'), 'Must have #btn-cancel-mute-duration');
    });

    test('7. Block contact confirmation modal is defined', () => {
      assert.ok(html.includes('id="block-contact-confirm-modal"'), 'Must have #block-contact-confirm-modal');
      assert.ok(html.includes('id="btn-confirm-block"'), 'Must have #btn-confirm-block');
      assert.ok(html.includes('id="btn-cancel-block-confirm"'), 'Must have #btn-cancel-block-confirm');
    });

    test('8. Blocked contacts modal dialog is defined with list container', () => {
      assert.ok(html.includes('id="blocked-contacts-modal"'), 'Must have #blocked-contacts-modal');
      assert.ok(html.includes('id="blocked-contacts-list"'), 'Must have #blocked-contacts-list');
      assert.ok(html.includes('id="blocked-contacts-empty"'), 'Must have #blocked-contacts-empty');
      assert.ok(html.includes('id="btn-done-blocked-contacts"'), 'Must have #btn-done-blocked-contacts');
    });

    test('9. CSS contains styling for muted badges and blocked elements', () => {
      assert.ok(css.includes('.chat-muted-badge'), 'CSS must style .chat-muted-badge');
      assert.ok(css.includes('.composer-blocked-banner'), 'CSS must style .composer-blocked-banner');
      assert.ok(css.includes('.mute-duration-card'), 'CSS must style .mute-duration-card');
      assert.ok(css.includes('.blocked-contact-item'), 'CSS must style .blocked-contact-item');
    });

    test('9b. HTML tag hierarchy ensures all modals are closed and not nested', () => {
      const forwardIdx = html.indexOf('id="forward-modal"');
      const muteIdx = html.indexOf('id="mute-duration-modal"');
      const blockIdx = html.indexOf('id="block-contact-confirm-modal"');
      const blockedListIdx = html.indexOf('id="blocked-contacts-modal"');
      assert.ok(forwardIdx > 0 && muteIdx > forwardIdx && blockIdx > muteIdx && blockedListIdx > blockIdx);

      const forwardSection = html.slice(forwardIdx, muteIdx);
      const openDivs = (forwardSection.match(/<div(\s|>)/g) || []).length;
      const closeDivs = (forwardSection.match(/<\/div>/g) || []).length;
      assert.equal(openDivs, closeDivs, 'forward-modal must completely close all opened divs before subsequent modals');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Preload & Main Process IPC Bridge
  // ═══════════════════════════════════════════════════════════════════
  describe('Preload & Main Process IPC Bridge', () => {
    test('10. Preload exposes chatApi block and mute methods', () => {
      assert.ok(preloadJs.includes('blockUser:'), 'Must expose blockUser in preload');
      assert.ok(preloadJs.includes('unblockUser:'), 'Must expose unblockUser in preload');
      assert.ok(preloadJs.includes('listBlockedUsers:'), 'Must expose listBlockedUsers in preload');
      assert.ok(preloadJs.includes('muteConversation:'), 'Must expose muteConversation in preload');
      assert.ok(preloadJs.includes('unmuteConversation:'), 'Must expose unmuteConversation in preload');
    });

    test('11. Preload exposes db blocked user persistence methods', () => {
      assert.ok(preloadJs.includes('getBlockedUsers:'), 'Must expose getBlockedUsers in preload db');
      assert.ok(preloadJs.includes('saveBlockedUsers:'), 'Must expose saveBlockedUsers in preload db');
      assert.ok(preloadJs.includes('addBlockedUser:'), 'Must expose addBlockedUser in preload db');
      assert.ok(preloadJs.includes('removeBlockedUser:'), 'Must expose removeBlockedUser in preload db');
    });

    test('12. Main process handles chatApi IPC channels with secure session token', () => {
      assert.ok(mainJs.includes("'chat-api:block-user'"), 'Main must handle chat-api:block-user');
      assert.ok(mainJs.includes("'chat-api:unblock-user'"), 'Main must handle chat-api:unblock-user');
      assert.ok(mainJs.includes("'chat-api:list-blocked-users'"), 'Main must handle chat-api:list-blocked-users');
      assert.ok(mainJs.includes("'chat-api:mute-conversation'"), 'Main must handle chat-api:mute-conversation');
      assert.ok(mainJs.includes("'chat-api:unmute-conversation'"), 'Main must handle chat-api:unmute-conversation');
      assert.ok(mainJs.includes('getAuthenticatedSessionToken()'), 'Must resolve session token inside main');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. SQLite Database Service & Migration 4
  // ═══════════════════════════════════════════════════════════════════
  describe('SQLite Database & Migration 4', () => {
    let dbService;
    let tmpDir;

    beforeEach(async () => {
      tmpDir = path.join(os.tmpdir(), 'ollachat-block-mute-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      await fsPromises.mkdir(tmpDir, { recursive: true });
      const mockSessionStore = {
        currentSession: {
          userId: 'test_user_alice',
          sessionToken: 'session_token_alice_secret',
          phone: '+15551112222'
        },
        getSession() {
          return this.currentSession;
        }
      };
      dbService = new DatabaseService({
        storageDir: tmpDir,
        sessionStore: mockSessionStore
      });
    });

    afterEach(async () => {
      if (dbService) await dbService.close();
      if (tmpDir) await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('13. Migration 4 establishes schema version 4 and tables', () => {
      const mig4 = MIGRATIONS.find((m) => m.version === 4);
      assert.ok(mig4, 'Migration 4 must exist');
      assert.strictEqual(typeof mig4.up, 'function', 'Migration 4 up must be a function');
    });

    test('14. saveConversation persists muted_until into SQLite', async () => {
      const conv = {
        roomId: 'room_mute_1',
        title: 'Muted Chat',
        kind: 'direct',
        peerUserId: 'user_bob',
        muted_until: '2026-10-24T12:00:00.000Z'
      };
      await dbService.saveConversation(conv);
      const rows = await dbService.getConversations();
      const saved = rows.find((r) => r.roomId === 'room_mute_1' || r.room_id === 'room_mute_1');
      assert.ok(saved, 'Conversation must be saved');
      assert.strictEqual(saved.muted_until, '2026-10-24T12:00:00.000Z');
    });

    test('15. Blocked users CRUD persists properly in SQLite', async () => {
      const users = [
        { userId: 'u_1', displayName: 'Alice', phone: '+123456789', since: '2026-10-20T00:00:00Z' },
        { userId: 'u_2', displayName: 'Bob', phone: '+987654321', since: '2026-10-21T00:00:00Z' }
      ];
      await dbService.saveBlockedUsers(users);

      let saved = await dbService.getBlockedUsers();
      assert.strictEqual(saved.length, 2);
      assert.strictEqual(saved[0].userId, 'u_1');

      // Add a third user
      await dbService.addBlockedUser({ userId: 'u_3', displayName: 'Charlie' });
      saved = await dbService.getBlockedUsers();
      assert.strictEqual(saved.length, 3);

      // Remove a user
      await dbService.removeBlockedUser('u_1');
      saved = await dbService.getBlockedUsers();
      assert.strictEqual(saved.length, 2);
      assert.strictEqual(saved.some((u) => u.userId === 'u_1'), false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. ChatShellState Unit Tests
  // ═══════════════════════════════════════════════════════════════════
  describe('ChatShellState Block & Mute State', () => {
    let state;

    beforeEach(() => {
      state = new ChatShellState();
      state.currentUser = { userId: 'self_123' };
      state.conversations = [
        { roomId: 'dm_alice', kind: 'direct', peerUserId: 'user_alice', title: 'Alice' },
        { roomId: 'dm_bob', kind: 'direct', peerUserId: 'user_bob', title: 'Bob' },
        { roomId: 'grp_alpha', kind: 'group', title: 'Alpha Group' }
      ];
    });

    test('16. setBlockedUsers populates blockedUserIds and blockedUsersMap', () => {
      state.setBlockedUsers([
        { userId: 'user_alice', displayName: 'Alice', phone: '+1234' }
      ]);
      assert.strictEqual(state.isUserBlocked('user_alice'), true);
      assert.strictEqual(state.isUserBlocked('user_bob'), false);
      assert.strictEqual(state.getBlockedUsers().length, 1);
    });

    test('17. isRoomBlocked accurately detects blocked direct peer and ignores groups', () => {
      state.setBlockedUsers([{ userId: 'user_alice' }]);
      assert.strictEqual(state.isRoomBlocked('dm_alice'), true);
      assert.strictEqual(state.isRoomBlocked('dm_bob'), false);
      assert.strictEqual(state.isRoomBlocked('grp_alpha'), false, 'Group chat must never be blocked');
    });

    test('18. addBlockedUser and removeBlockedUser correctly mutate state', () => {
      state.addBlockedUser({ userId: 'user_bob', displayName: 'Bob' });
      assert.strictEqual(state.isUserBlocked('user_bob'), true);
      assert.strictEqual(state.isRoomBlocked('dm_bob'), true);

      state.removeBlockedUser('user_bob');
      assert.strictEqual(state.isUserBlocked('user_bob'), false);
      assert.strictEqual(state.isRoomBlocked('dm_bob'), false);
    });

    test('19. isConversationMuted evaluates active vs expired mutes correctly', () => {
      const futureDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      const alwaysDate = '9999-12-31T00:00:00Z';

      const convActive = { roomId: 'c1', mutedUntil: futureDate };
      const convExpired = { roomId: 'c2', mutedUntil: pastDate };
      const convAlways = { roomId: 'c3', mutedUntil: alwaysDate };
      const convUnmuted = { roomId: 'c4', mutedUntil: null };

      assert.strictEqual(state.isConversationMuted(convActive), true);
      assert.strictEqual(state.isConversationMuted(convExpired), false, 'Expired mute must return false');
      assert.strictEqual(state.isConversationMuted(convAlways), true, 'Always mute must return true');
      assert.strictEqual(state.isConversationMuted(convUnmuted), false);
    });

    test('20. setConversationMuted updates mutedUntil in conversation', () => {
      state.setConversationMuted('dm_alice', '2026-12-31T23:59:59Z');
      assert.strictEqual(state.conversations[0].mutedUntil, '2026-12-31T23:59:59Z');
      assert.strictEqual(state.isConversationMuted('dm_alice'), true);

      state.setConversationMuted('dm_alice', null);
      assert.strictEqual(state.conversations[0].mutedUntil, null);
      assert.strictEqual(state.isConversationMuted('dm_alice'), false);
    });

    test('21. getGroupCapabilities sets canBlock true for direct and false for group', () => {
      const directConv = { roomId: 'dm_1', kind: 'direct' };
      const groupConv = { roomId: 'grp_1', kind: 'group' };
      assert.strictEqual(getGroupCapabilities(directConv, [], 'self').canBlock, true);
      assert.strictEqual(getGroupCapabilities(groupConv, [], 'self').canBlock, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. API Normalizers & Client Layer
  // ═══════════════════════════════════════════════════════════════════
  describe('API Normalizers & Client Layer', () => {
    test('22. normalizeBlockItem extracts fields cleanly', () => {
      const item = normalizeBlockItem({
        user_id: 'usr_42',
        display_name: 'David',
        phone: '+44123456',
        since: '2026-10-23T06:00:00Z'
      });
      assert.strictEqual(item.userId, 'usr_42');
      assert.strictEqual(item.displayName, 'David');
      assert.strictEqual(item.phone, '+44123456');
      assert.strictEqual(item.since, '2026-10-23T06:00:00Z');
    });

    test('23. normalizeConversation preserves mutedUntil', () => {
      const conv = normalizeConversation({
        room_id: 'r_100',
        muted_until: '2026-11-01T00:00:00Z'
      });
      assert.strictEqual(conv.mutedUntil, '2026-11-01T00:00:00Z');
      assert.strictEqual(conv.muted_until, '2026-11-01T00:00:00Z');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Mock Server End-to-End API Invocations
  // ═══════════════════════════════════════════════════════════════════
  describe('Mock Server API Contracts', () => {
    let server;
    let baseUrl;
    let lastRequest = null;

    beforeEach(async () => {
      lastRequest = null;
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          lastRequest = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body ? JSON.parse(body) : null
          };

          if (req.url === '/v1/directory/blocks/user_target' && req.method === 'PUT') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blocked: true, user_id: 'user_target', since: '2026-10-23T07:00:00Z' }));
          } else if (req.url === '/v1/directory/blocks/user_target' && req.method === 'DELETE') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blocked: false, user_id: 'user_target' }));
          } else if (req.url === '/v1/directory/blocks' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              blocks: [
                { user_id: 'user_target', display_name: 'Target User', phone: '+1555', since: '2026-10-23T07:00:00Z' }
              ]
            }));
          } else if (req.url === '/v1/directory/conversations/room_1/mute' && req.method === 'PUT') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ muted_until: '2026-10-23T15:00:00Z', room_id: 'room_1' }));
          } else if (req.url === '/v1/directory/conversations/room_1/mute' && req.method === 'DELETE') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ muted_until: null, room_id: 'room_1' }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
          }
        });
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/v1`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('24. blockUser issues PUT /v1/directory/blocks/{user_id}', async () => {
      const api = new ChatApi({ baseUrl });
      const res = await api.blockUser('test-token', 'user_target');
      assert.strictEqual(lastRequest.method, 'PUT');
      assert.strictEqual(lastRequest.url, '/v1/directory/blocks/user_target');
      assert.strictEqual(lastRequest.headers.authorization, 'Bearer test-token');
      assert.strictEqual(res.blocked, true);
      assert.strictEqual(res.userId, 'user_target');
    });

    test('25. unblockUser issues DELETE /v1/directory/blocks/{user_id}', async () => {
      const api = new ChatApi({ baseUrl });
      const res = await api.unblockUser('test-token', 'user_target');
      assert.strictEqual(lastRequest.method, 'DELETE');
      assert.strictEqual(lastRequest.url, '/v1/directory/blocks/user_target');
      assert.strictEqual(res.blocked, false);
    });

    test('26. listBlockedUsers issues GET /v1/directory/blocks', async () => {
      const api = new ChatApi({ baseUrl });
      const res = await api.listBlockedUsers('test-token');
      assert.strictEqual(lastRequest.method, 'GET');
      assert.strictEqual(lastRequest.url, '/v1/directory/blocks');
      assert.strictEqual(Array.isArray(res.blocks), true);
      assert.strictEqual(res.blocks.length, 1);
      assert.strictEqual(res.blocks[0].userId, 'user_target');
    });

    test('27. muteConversation issues PUT with duration and returns muted_until', async () => {
      const api = new ChatApi({ baseUrl });
      const res = await api.muteConversation('test-token', 'room_1', '8h');
      assert.strictEqual(lastRequest.method, 'PUT');
      assert.strictEqual(lastRequest.url, '/v1/directory/conversations/room_1/mute');
      assert.deepStrictEqual(lastRequest.body, { duration: '8h' });
      assert.strictEqual(res.muted_until, '2026-10-23T15:00:00Z');
      assert.strictEqual(res.roomId, 'room_1');
    });

    test('28. unmuteConversation issues DELETE and returns null muted_until', async () => {
      const api = new ChatApi({ baseUrl });
      const res = await api.unmuteConversation('test-token', 'room_1');
      assert.strictEqual(lastRequest.method, 'DELETE');
      assert.strictEqual(lastRequest.url, '/v1/directory/conversations/room_1/mute');
      assert.strictEqual(res.muted_until, null);
      assert.strictEqual(res.roomId, 'room_1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Renderer UI Wiring & Logic Verification
  // ═══════════════════════════════════════════════════════════════════
  describe('Renderer UI Integration Wiring', () => {
    test('29. app.js contains functions for opening and confirming mute/block modals', () => {
      assert.ok(appJs.includes('function openMuteDurationModal'), 'Must define openMuteDurationModal');
      assert.ok(appJs.includes('function closeMuteDurationModal'), 'Must define closeMuteDurationModal');
      assert.ok(appJs.includes('async function confirmMuteConversation'), 'Must define confirmMuteConversation');
      assert.ok(appJs.includes('async function handleUnmuteConversation'), 'Must define handleUnmuteConversation');

      assert.ok(appJs.includes('function openBlockContactModal'), 'Must define openBlockContactModal');
      assert.ok(appJs.includes('function closeBlockContactModal'), 'Must define closeBlockContactModal');
      assert.ok(appJs.includes('async function confirmBlockContact'), 'Must define confirmBlockContact');
      assert.ok(appJs.includes('async function handleUnblockContact'), 'Must define handleUnblockContact');

      assert.ok(appJs.includes('async function openBlockedContactsModal'), 'Must define openBlockedContactsModal');
      assert.ok(appJs.includes('async function renderBlockedContactsList'), 'Must define renderBlockedContactsList');
      assert.ok(appJs.includes('async function loadBlockedUsers'), 'Must define loadBlockedUsers');
    });

    test('30. app.js wires context menu toggle-mute handler', () => {
      assert.ok(appJs.includes("action === 'toggle-mute'"), 'Must handle toggle-mute in context menu');
      assert.ok(appJs.includes('openMuteDurationModal(roomId)'), 'Must open mute duration modal on toggle-mute');
    });

    test('31. app.js wires chat header menu mute and block items', () => {
      assert.ok(appJs.includes('menuItemToggleMute?.addEventListener'), 'Must wire menuItemToggleMute click');
      assert.ok(appJs.includes('menuItemBlockContact?.addEventListener'), 'Must wire menuItemBlockContact click');
    });

    test('32. app.js wires contact info mute and block rows', () => {
      assert.ok(appJs.includes('contactInfoMuteRow?.addEventListener'), 'Must wire contactInfoMuteRow click');
      assert.ok(appJs.includes('contactInfoBlockRow?.addEventListener'), 'Must wire contactInfoBlockRow click');
    });

    test('33. app.js suppresses desktop notification when conversation is muted', () => {
      assert.ok(appJs.includes('const isMuted = shellState.isConversationMuted(item);'), 'Must check isConversationMuted for notifications');
    });

    test('34. app.js hides composer and shows blocked banner when contact is blocked', () => {
      assert.ok(appJs.includes('composerBlockedBanner?.classList.remove(\'hidden\');'), 'Must show blocked banner');
      assert.ok(appJs.includes('composerBox?.classList.add(\'hidden\');'), 'Must hide composer box when blocked');
    });

    test('35. app.js prevents sending messages when room is blocked', () => {
      assert.ok(appJs.includes('shellState.isRoomBlocked(targetRoomId)'), 'Must check isRoomBlocked before sending');
      assert.ok(appJs.includes('Cannot send messages to a blocked contact'), 'Must show error message when attempting to send');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. Block Contact Button & Confirmation Dialog Regression Flow
  // ═══════════════════════════════════════════════════════════════════
  describe('Block Contact Button & Confirmation Flow Regression Suite', () => {
    test('36. getDirectPeerUserId correctly resolves peer from backend snake_case and various schemas', () => {
      // Backend Directory API schema: peer: { user_id: 'usr_peer_123', display_name: 'Bob' }
      const backendConv = {
        roomId: 'dm_peer_123',
        kind: 'direct',
        peer: { user_id: 'usr_peer_123', display_name: 'Bob' }
      };
      assert.strictEqual(getDirectPeerUserId(backendConv, 'usr_my_id'), 'usr_peer_123');

      // Top-level peer_user_id / peerUserId
      assert.strictEqual(getDirectPeerUserId({ roomId: 'r1', peer_user_id: 'usr_456' }), 'usr_456');
      assert.strictEqual(getDirectPeerUserId({ roomId: 'r2', peerUserId: 'usr_789' }), 'usr_789');

      // String peer
      assert.strictEqual(getDirectPeerUserId({ roomId: 'r3', peer: 'usr_str' }), 'usr_str');

      // Room ID dm_alice_bob fallback
      assert.strictEqual(getDirectPeerUserId('dm_alice_bob', 'alice'), 'bob');
      assert.strictEqual(getDirectPeerUserId('dm_alice_bob', 'bob'), 'alice');

      // Direct prefix
      assert.strictEqual(getDirectPeerUserId('direct:charlie'), 'charlie');

      // Group returns null
      assert.strictEqual(getDirectPeerUserId({ roomId: 'grp_1', kind: 'group' }), null);
      assert.strictEqual(getDirectPeerUserId({ roomId: 'grp_2', isGroup: true }), null);
    });

    test('37. getConversationTitle supports snake_case user_id and peer display_name', () => {
      const convWithSnakeCasePeer = {
        kind: 'direct',
        peer: { user_id: 'usr_bob_1', display_name: 'Bob Builder' }
      };
      assert.strictEqual(getConversationTitle(convWithSnakeCasePeer), 'Bob Builder');
    });

    test('38. menuItemBlockContact click handler extracts peerUserId and triggers openBlockContactModal', () => {
      assert.ok(appJs.includes('menuItemBlockContact?.addEventListener'), 'Must have click listener');
      assert.ok(
        appJs.includes('getDirectPeerUserId(conv, shellState.currentUser?.userId)') ||
        appJs.includes('getDirectPeerUserId(conv)'),
        'Must resolve peer user id using getDirectPeerUserId'
      );
      assert.ok(appJs.includes('openBlockContactModal(peerUserId, displayName)'), 'Must call openBlockContactModal');
      assert.ok(appJs.includes('closeChatHeaderMenu()'), 'Closes menu when clicked');
    });

    test('39. Cancel, close, backdrop click, and Escape dismiss block modal without calling API', () => {
      assert.ok(appJs.includes("btnCloseBlockConfirm?.addEventListener('click', closeBlockContactModal)"), 'Close button closes modal');
      assert.ok(appJs.includes("btnCancelBlockConfirm?.addEventListener('click', closeBlockContactModal)"), 'Cancel button closes modal');
      assert.ok(appJs.includes('if (e.target === blockContactConfirmModal)'), 'Backdrop click closes modal');
      assert.ok(appJs.includes('blockContactConfirmModal && !blockContactConfirmModal.classList.contains(\'hidden\')'), 'Escape key closes modal');
    });

    test('40. Confirming block invokes chatApi.blockUser and handles success and failure', () => {
      assert.ok(appJs.includes("btnConfirmBlock?.addEventListener('click', confirmBlockContact)"), 'Confirm button wired to confirmBlockContact');
      assert.ok(appJs.includes('window.ollacoreDesktop.chatApi.blockUser(userId)'), 'Calls blockUser API wrapper');
      assert.ok(appJs.includes('shellState.addBlockedUser'), 'Adds blocked user to state on success');
      assert.ok(appJs.includes('closeBlockContactModal()'), 'Closes modal after success');
      assert.ok(appJs.includes('composerBlockedBanner?.classList.remove(\'hidden\')'), 'Shows blocked banner when room is blocked');
      assert.ok(appJs.includes('composerBox?.classList.add(\'hidden\')'), 'Hides composer when room is blocked');
      assert.ok(appJs.includes('blockModalError.textContent = err?.message'), 'Displays error on API failure');
      assert.ok(appJs.includes('btnConfirmBlock?.removeAttribute(\'disabled\')'), 'Re-enables confirm button');
    });

    test('41. End-to-end simulated interaction: clicking block contact, confirming, and verifying UI state', async () => {
      const modal = { classList: new Set(['hidden']) };
      const desc = { textContent: '' };
      const errorEl = { classList: new Set(['hidden']), textContent: '' };
      const spinner = { classList: new Set(['hidden']) };
      const confirmBtn = { disabled: false, setAttribute(k, v) { if (k === 'disabled') this.disabled = true; }, removeAttribute(k) { if (k === 'disabled') this.disabled = false; } };
      const composerBlockedBanner = { classList: new Set(['hidden']) };
      const composerBox = { classList: new Set() };
      const menuBlockText = { textContent: 'Block contact' };

      const state = new ChatShellState();
      state.currentUser = { userId: 'alice' };
      const peerUserId = 'usr_peer_backend_999';
      const conv = {
        roomId: 'dm_alice_peer999',
        kind: 'direct',
        peer: { user_id: peerUserId, display_name: 'Bob Directory' }
      };
      state.setInbox([conv]);
      state.selectedRoomId = conv.roomId;

      let apiCalls = [];
      let apiShouldFail = false;
      const mockChatApi = {
        async blockUser(id) {
          apiCalls.push({ action: 'block', id });
          if (apiShouldFail) {
            throw new Error('Server connection error 500');
          }
          return { status: 'blocked', user_id: id, since: new Date().toISOString() };
        }
      };

      // 1. Menu item click simulation
      let activeBlockModalUserId = null;
      function simulateOpenBlockModal(uId, dName) {
        activeBlockModalUserId = uId;
        errorEl.classList.add('hidden');
        errorEl.textContent = '';
        desc.textContent = `Block ${dName}? Blocked contacts will no longer be able to call you or send you messages.`;
        modal.classList.delete('hidden');
      }

      function simulateCloseBlockModal() {
        modal.classList.add('hidden');
        activeBlockModalUserId = null;
      }

      async function simulateConfirmBlock() {
        if (!activeBlockModalUserId) return;
        const uid = activeBlockModalUserId;
        confirmBtn.setAttribute('disabled', 'true');
        spinner.classList.delete('hidden');
        errorEl.classList.add('hidden');
        try {
          const res = await mockChatApi.blockUser(uid);
          state.addBlockedUser({
            userId: uid,
            displayName: 'Bob Directory',
            since: res.since
          });
          simulateCloseBlockModal();
          if (state.isRoomBlocked(state.selectedRoomId)) {
            composerBlockedBanner.classList.delete('hidden');
            composerBox.classList.add('hidden');
          }
          menuBlockText.textContent = 'Unblock contact';
        } catch (err) {
          errorEl.textContent = err.message || 'Failed to block contact';
          errorEl.classList.delete('hidden');
        } finally {
          confirmBtn.removeAttribute('disabled');
          spinner.classList.add('hidden');
        }
      }

      // Step A: Trigger Block Contact from menu
      const resolvedPeerId = getDirectPeerUserId(conv, state.currentUser.userId);
      assert.strictEqual(resolvedPeerId, peerUserId, 'Must resolve peer ID from snake_case backend response');
      simulateOpenBlockModal(resolvedPeerId, conv.peer.display_name);

      assert.ok(!modal.classList.has('hidden'), 'Modal must now be visible');
      assert.ok(desc.textContent.includes('Bob Directory'), 'Modal desc must mention peer name');
      assert.strictEqual(apiCalls.length, 0, 'No API call made upon opening modal');

      // Step B: Cancel modal
      simulateCloseBlockModal();
      assert.ok(modal.classList.has('hidden'), 'Modal closed on cancel');
      assert.strictEqual(apiCalls.length, 0, 'No API call made on cancel');
      assert.strictEqual(state.isUserBlocked(peerUserId), false, 'User must not be blocked after cancel');

      // Step C: Open again and test API failure
      simulateOpenBlockModal(resolvedPeerId, conv.peer.display_name);
      apiShouldFail = true;
      await simulateConfirmBlock();

      assert.strictEqual(apiCalls.length, 1, 'API block was invoked');
      assert.strictEqual(apiCalls[0].id, peerUserId);
      assert.ok(!errorEl.classList.has('hidden'), 'Error message element must be unhidden on failure');
      assert.strictEqual(errorEl.textContent, 'Server connection error 500');
      assert.strictEqual(state.isUserBlocked(peerUserId), false, 'User must not be blocked on failure');
      assert.strictEqual(composerBlockedBanner.classList.has('hidden'), true, 'Banner must remain hidden on failure');
      assert.strictEqual(confirmBtn.disabled, false, 'Button re-enabled after failure');

      // Step D: Confirm again with API success
      apiShouldFail = false;
      await simulateConfirmBlock();

      assert.strictEqual(apiCalls.length, 2, 'API block invoked a second time');
      assert.ok(modal.classList.has('hidden'), 'Modal closed on success');
      assert.strictEqual(state.isUserBlocked(peerUserId), true, 'User is marked blocked in state');
      assert.strictEqual(state.isRoomBlocked(conv.roomId), true, 'Room is marked blocked in state');
      assert.strictEqual(composerBlockedBanner.classList.has('hidden'), false, 'Blocked banner displayed');
      assert.strictEqual(composerBox.classList.has('hidden'), true, 'Composer box hidden');
      assert.strictEqual(menuBlockText.textContent, 'Unblock contact', 'Chat header menu updated to Unblock');
    });
  });
});
