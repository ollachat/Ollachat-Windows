import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { DatabaseService } from '../src/storage/db/database-service.js';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { sqliteRowToMessage } from '../src/renderer/db-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const appJsPath = path.join(rootDir, 'src', 'renderer', 'app.js');
const preloadJsPath = path.join(rootDir, 'src', 'preload', 'preload.js');
const htmlPath = path.join(rootDir, 'src', 'renderer', 'index.html');
const cssPath = path.join(rootDir, 'src', 'renderer', 'styles.css');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

describe('Starred Messages SQLite Persistence & Lifecycle Suite', () => {
  let dbService;
  let tmpDir;

  const userAlice = {
    userId: 'usr_alice_star',
    sessionToken: 'tok_alice_secret',
    phone: '+15550001111'
  };

  const userBob = {
    userId: 'usr_bob_star',
    sessionToken: 'tok_bob_secret',
    phone: '+15550002222'
  };

  let currentSession = userAlice;

  const mockSessionStore = {
    getSession() {
      return currentSession;
    }
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-starred-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fsPromises.mkdir(tmpDir, { recursive: true });
    currentSession = userAlice;

    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService) await dbService.close();
    if (tmpDir) await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ───────────────────────────────────────────────────────────────────
  // 1. Core SQLite Star & Unstar Functionality
  // ───────────────────────────────────────────────────────────────────
  describe('1. SQLite Star & Unstar Operations', () => {
    test('updateMessageStarred marks a message as starred and getStarredMessages retrieves it', async () => {
      // 1. Seed conversation & message
      await dbService.saveConversation({ roomId: 'room_core_1', title: 'Core Room' });
      await dbService.saveMessage({
        id: 'msg_star_1',
        roomId: 'room_core_1',
        senderId: 'usr_alice_star',
        body: { text: 'Important project deadline' },
        createdAt: '2026-10-01T10:00:00Z'
      });

      // Initially not starred
      const initial = await dbService.getStarredMessages({ roomId: 'room_core_1' });
      assert.strictEqual(initial.length, 0, 'Initially no starred messages');

      // Star the message
      const res = await dbService.updateMessageStarred({ messageId: 'msg_star_1', roomId: 'room_core_1', isStarred: true });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changes, 1);

      // Verify retrieval
      const starred = await dbService.getStarredMessages({ roomId: 'room_core_1' });
      assert.strictEqual(starred.length, 1);
      assert.strictEqual(starred[0].id, 'msg_star_1');
      assert.strictEqual(starred[0].is_starred, 1);
      assert.ok(starred[0].body_json.includes('Important project deadline'));
    });

    test('updateMessageStarred unstars a message and removes it from getStarredMessages', async () => {
      await dbService.saveConversation({ roomId: 'room_core_2', title: 'Room 2' });
      await dbService.saveMessage({
        id: 'msg_star_2',
        roomId: 'room_core_2',
        senderId: 'usr_alice_star',
        body: { text: 'To unstar later' },
        isStarred: 1
      });

      const starredBefore = await dbService.getStarredMessages({ roomId: 'room_core_2' });
      assert.strictEqual(starredBefore.length, 1);

      // Unstar
      const res = await dbService.updateMessageStarred({ messageId: 'msg_star_2', roomId: 'room_core_2', isStarred: false });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changes, 1);

      const starredAfter = await dbService.getStarredMessages({ roomId: 'room_core_2' });
      assert.strictEqual(starredAfter.length, 0, 'Unstarred message removed from list');
    });

    test('updateMessageStarred works with clientMessageId lookup', async () => {
      await dbService.saveConversation({ roomId: 'room_core_3', title: 'Room 3' });
      await dbService.saveMessage({
        id: 'canonical_id_3',
        clientMessageId: 'local_cid_3',
        roomId: 'room_core_3',
        senderId: 'usr_alice_star',
        body: { text: 'Optimistic message' }
      });

      // Star using clientMessageId
      const res = await dbService.updateMessageStarred({ messageId: 'local_cid_3', isStarred: true });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.changes, 1);

      const list = await dbService.getStarredMessages({ roomId: 'room_core_3' });
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].id, 'canonical_id_3');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 2. Persistence Across Restarts & Multi-Room Independence
  // ───────────────────────────────────────────────────────────────────
  describe('2. Persistence Across Restarts & Multi-Room Scoping', () => {
    test('Starred state persists in SQLite across database close and reopen (app restart)', async () => {
      await dbService.saveConversation({ roomId: 'room_restart', title: 'Restart Test' });
      await dbService.saveMessage({
        id: 'msg_survive_restart',
        roomId: 'room_restart',
        senderId: 'usr_alice_star',
        body: { text: 'Keep this note forever' }
      });
      await dbService.updateMessageStarred({ messageId: 'msg_survive_restart', isStarred: true });

      // Close database (simulating application exit)
      await dbService.close();

      // Reopen database with same user session (simulating restart)
      const reopenedDb = new DatabaseService({
        storageDir: tmpDir,
        sessionStore: mockSessionStore
      });

      try {
        const list = await reopenedDb.getStarredMessages({ roomId: 'room_restart' });
        assert.strictEqual(list.length, 1, 'Starred message must survive restart');
        assert.strictEqual(list[0].id, 'msg_survive_restart');
        assert.strictEqual(list[0].is_starred, 1);
      } finally {
        await reopenedDb.close();
      }
    });

    test('Multiple conversations maintain independent starred message lists', async () => {
      await dbService.saveConversation({ roomId: 'room_alpha', title: 'Alpha' });
      await dbService.saveConversation({ roomId: 'room_beta', title: 'Beta' });

      await dbService.saveMessage({ id: 'msg_a1', roomId: 'room_alpha', senderId: 'usr_alice_star', body: { text: 'Alpha 1' } });
      await dbService.saveMessage({ id: 'msg_a2', roomId: 'room_alpha', senderId: 'usr_alice_star', body: { text: 'Alpha 2' } });
      await dbService.saveMessage({ id: 'msg_b1', roomId: 'room_beta', senderId: 'usr_alice_star', body: { text: 'Beta 1' } });

      await dbService.updateMessageStarred({ messageId: 'msg_a1', roomId: 'room_alpha', isStarred: true });
      await dbService.updateMessageStarred({ messageId: 'msg_b1', roomId: 'room_beta', isStarred: true });

      // Query Room Alpha
      const alphaList = await dbService.getStarredMessages({ roomId: 'room_alpha' });
      assert.strictEqual(alphaList.length, 1);
      assert.strictEqual(alphaList[0].id, 'msg_a1');

      // Query Room Beta
      const betaList = await dbService.getStarredMessages({ roomId: 'room_beta' });
      assert.strictEqual(betaList.length, 1);
      assert.strictEqual(betaList[0].id, 'msg_b1');

      // Query All Rooms (global starred)
      const globalList = await dbService.getStarredMessages();
      assert.strictEqual(globalList.length, 2, 'Global starred query returns both rooms');
      const ids = globalList.map((m) => m.id);
      assert.ok(ids.includes('msg_a1'));
      assert.ok(ids.includes('msg_b1'));
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 3. User & Account Isolation
  // ───────────────────────────────────────────────────────────────────
  describe('3. Account & User Isolation', () => {
    test('Starred messages are strictly isolated per authenticated user', async () => {
      // Alice stars a message in her isolated database
      currentSession = userAlice;
      await dbService.saveConversation({ roomId: 'room_shared', title: 'Shared' });
      await dbService.saveMessage({
        id: 'msg_alice_only',
        roomId: 'room_shared',
        senderId: 'usr_alice_star',
        body: { text: 'Alice private star' }
      });
      await dbService.updateMessageStarred({ messageId: 'msg_alice_only', isStarred: true });

      const aliceStarred = await dbService.getStarredMessages({ roomId: 'room_shared' });
      assert.strictEqual(aliceStarred.length, 1);

      // Close and switch to Bob
      await dbService.close();
      currentSession = userBob;

      const bobDb = new DatabaseService({
        storageDir: tmpDir,
        sessionStore: mockSessionStore
      });

      try {
        // Bob opens the same room in his account database
        await bobDb.saveConversation({ roomId: 'room_shared', title: 'Shared' });
        const bobStarred = await bobDb.getStarredMessages({ roomId: 'room_shared' });
        assert.strictEqual(bobStarred.length, 0, "Alice's starred messages must never leak to Bob");
      } finally {
        await bobDb.close();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 4. Historical Messages & Incoming Updates Invariants
  // ───────────────────────────────────────────────────────────────────
  describe('4. Historical Messages & Incoming Update Protection', () => {
    test('Historical messages not in active memory are retrieved by getStarredMessages', async () => {
      await dbService.saveConversation({ roomId: 'room_hist', title: 'History Room' });

      // Seed an older message sent 30 days ago
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      await dbService.saveMessage({
        id: 'msg_older_30d',
        roomId: 'room_hist',
        senderId: 'usr_other',
        body: { text: 'Historical starred document link' },
        createdAt: thirtyDaysAgo,
        isStarred: 1
      });

      // Query from SQLite directly
      const starred = await dbService.getStarredMessages({ roomId: 'room_hist' });
      assert.strictEqual(starred.length, 1);
      assert.strictEqual(starred[0].id, 'msg_older_30d');
      assert.ok(starred[0].body_json.includes('Historical starred document link'));

      // Converting through sqliteRowToMessage yields a complete message object
      const mapped = sqliteRowToMessage(starred[0]);
      assert.strictEqual(mapped.id, 'msg_older_30d');
      assert.strictEqual(mapped.body.text, 'Historical starred document link');
      assert.strictEqual(mapped.isStarred, true);
    });

    test('Incoming server message updates preserve existing is_starred status (max conflict resolution)', async () => {
      await dbService.saveConversation({ roomId: 'room_resync', title: 'Resync Room' });

      // 1. Message created and starred locally
      await dbService.saveMessage({
        id: 'msg_server_update',
        roomId: 'room_resync',
        senderId: 'usr_alice_star',
        body: { text: 'Initial content' },
        eventSeq: 10
      });
      await dbService.updateMessageStarred({ messageId: 'msg_server_update', isStarred: true });

      // Verify it is starred in SQLite
      const before = await dbService.getStarredMessages({ roomId: 'room_resync' });
      assert.strictEqual(before.length, 1);
      assert.strictEqual(before[0].id, 'msg_server_update');

      // 2. Incoming server catch-up/resync arrives with isStarred omitted/0
      await dbService.saveMessage({
        id: 'msg_server_update',
        roomId: 'room_resync',
        senderId: 'usr_alice_star',
        body: { text: 'Initial content' },
        eventSeq: 10,
        status: 'delivered',
        isStarred: 0 // server response without star metadata
      });

      // 3. Verify is_starred was NOT wiped
      const after = await dbService.getStarredMessages({ roomId: 'room_resync' });
      assert.strictEqual(after.length, 1, 'Incoming server update must not reset is_starred to 0');
      assert.strictEqual(after[0].id, 'msg_server_update');
      assert.strictEqual(after[0].is_starred, 1);
      assert.strictEqual(after[0].status, 'delivered');
    });

    test('Deleted messages are excluded from getStarredMessages and unstarred', async () => {
      await dbService.saveConversation({ roomId: 'room_del', title: 'Delete Test' });

      await dbService.saveMessage({ id: 'msg_del_everyone', roomId: 'room_del', senderId: 'usr_alice_star', body: { text: 'Del everyone' } });
      await dbService.saveMessage({ id: 'msg_del_for_me', roomId: 'room_del', senderId: 'usr_alice_star', body: { text: 'Del for me' } });

      await dbService.updateMessageStarred({ messageId: 'msg_del_everyone', isStarred: true });
      await dbService.updateMessageStarred({ messageId: 'msg_del_for_me', isStarred: true });

      assert.strictEqual((await dbService.getStarredMessages({ roomId: 'room_del' })).length, 2);

      // Delete msg_del_everyone for everyone
      await dbService.markMessageDeleted('msg_del_everyone');

      const afterDel1 = await dbService.getStarredMessages({ roomId: 'room_del' });
      assert.strictEqual(afterDel1.length, 1);
      assert.strictEqual(afterDel1[0].id, 'msg_del_for_me');

      // Delete msg_del_for_me for me
      await dbService.markMessageDeletedForMe('msg_del_for_me');

      const afterDel2 = await dbService.getStarredMessages({ roomId: 'room_del' });
      assert.strictEqual(afterDel2.length, 0, 'Deleted messages must be excluded');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 5. Preload Bridge & UI Architecture Invariants
  // ───────────────────────────────────────────────────────────────────
  describe('5. Preload Bridge & App Integration Invariants', () => {
    test('preload.js exposes updateMessageStarred and getStarredMessages under window.ollacoreDesktop.db', () => {
      assert.ok(
        preloadJs.includes("updateMessageStarred: (params = {}) => handleApiCall('db:update-message-starred'"),
        'preload.js must expose updateMessageStarred'
      );
      assert.ok(
        preloadJs.includes("getStarredMessages: (options = {}) => handleApiCall('db:get-starred-messages'"),
        'preload.js must expose getStarredMessages'
      );
    });

    test('app.js imports loadStarredMessagesFromDb and persistMessageStarredToDb from db-sync.js', () => {
      assert.ok(
        appJs.includes('loadStarredMessagesFromDb') && appJs.includes('persistMessageStarredToDb'),
        'app.js must import SQLite starred functions from db-sync.js'
      );
    });

    test('app.js _renderStarredMessages queries SQLite and reuses jumpToOriginalMessage', () => {
      const renderFuncIdx = appJs.indexOf('async function _renderStarredMessages(');
      assert.ok(renderFuncIdx !== -1, '_renderStarredMessages must be an async function');
      const renderBody = appJs.slice(renderFuncIdx, renderFuncIdx + 7000);

      assert.ok(
        renderBody.includes('await loadStarredMessagesFromDb(roomId)'),
        '_renderStarredMessages must retrieve starred messages from SQLite'
      );
      assert.ok(
        renderBody.includes('await jumpToOriginalMessage('),
        '_renderStarredMessages item click must reuse jumpToOriginalMessage for navigation'
      );
    });

    test('app.js context menu Star action updates SQLite and refreshes panel immediately', () => {
      const starActionIdx = appJs.lastIndexOf("action === 'star'");
      assert.ok(starActionIdx !== -1, 'Context menu must have star action');
      const starActionBody = appJs.slice(starActionIdx, starActionIdx + 1200);

      assert.ok(
        starActionBody.includes('persistMessageStarredToDb(mid, false, targetRoom)'),
        'Unstar must persist to SQLite'
      );
      assert.ok(
        starActionBody.includes('persistMessageStarredToDb(mid, true, targetRoom)'),
        'Star must persist to SQLite'
      );
      assert.ok(
        starActionBody.includes('_renderStarredMessages(targetRoom)'),
        'Star action must refresh starred messages panel if open'
      );
    });
  });

  describe('6. UI Visibility, Layout & Information Panel Invariants', () => {
    test('1. #contact-info-starred-row exists with accessible role, star icon, and count span', () => {
      assert.ok(html.includes('id="contact-info-starred-row"'), 'Starred row exists in HTML');
      assert.ok(html.includes('id="contact-info-starred-count"'), 'Starred count span exists in HTML');
      assert.ok(html.includes('aria-label="Starred messages"'), 'Has accessible aria-label');
      assert.ok(css.includes('.contact-info-nav-row-value'), 'CSS defines .contact-info-nav-row-value');
    });

    test('2. WhatsApp Layout: Starred row is positioned above Participants section in HTML', () => {
      const starredIdx = html.indexOf('id="contact-info-starred-row"');
      const participantsIdx = html.indexOf('id="contact-info-participants-section"');
      assert.ok(starredIdx !== -1, 'Starred row exists');
      assert.ok(participantsIdx !== -1, 'Participants section exists');
      assert.ok(
        starredIdx < participantsIdx,
        'Starred messages row must be positioned BEFORE participants section matching WhatsApp layout'
      );
    });

    test('3. openContactInfo ensures starred row is visible and updates count for room', () => {
      assert.ok(
        appJs.includes("contactInfoStarredRow?.classList.remove('hidden')"),
        'openContactInfo unhides contactInfoStarredRow'
      );
      assert.ok(
        appJs.includes('updateContactInfoStarredCount(roomId)'),
        'openContactInfo updates count for room'
      );
    });

    test('4. Starred row click hides Contact Info panel and opens Starred Messages panel', () => {
      const clickIdx = appJs.indexOf('contactInfoStarredRow.addEventListener(\'click\'');
      assert.ok(clickIdx !== -1, 'Click listener registered on contactInfoStarredRow');
      const handlerBody = appJs.slice(clickIdx, clickIdx + 400);
      assert.ok(handlerBody.includes("contactInfoPanel?.classList.add('hidden')"), 'Hides contact info panel');
      assert.ok(handlerBody.includes('openStarredMessages('), 'Opens starred messages panel');
    });

    test('5. Back button closes Starred Messages panel and restores Contact Info panel', () => {
      const closeIdx = appJs.indexOf('btnCloseStarredMessages.addEventListener(\'click\'');
      assert.ok(closeIdx !== -1, 'Click listener registered on btnCloseStarredMessages');
      const handlerBody = appJs.slice(closeIdx, closeIdx + 400);
      assert.ok(handlerBody.includes('closeStarredMessages()'), 'Closes starred messages panel');
      assert.ok(handlerBody.includes("contactInfoPanel?.classList.remove('hidden')"), 'Restores contact info panel');
    });

    test('6. Empty state and list containers exist inside Starred Messages panel', () => {
      assert.ok(html.includes('id="starred-messages-panel"'), 'Panel container exists');
      assert.ok(html.includes('id="starred-empty"'), 'Empty state container exists');
      assert.ok(html.includes('id="starred-list"'), 'List container exists');
      assert.ok(html.includes('No starred messages in this conversation'), 'Empty state friendly text');
    });

    test('7. Three-dot menu includes Starred Messages option for all chats and groups', () => {
      assert.ok(html.includes('id="menu-item-starred-messages"'), 'Three-dot menu item exists');
      assert.ok(appJs.includes("menuItemStarredMessages?.addEventListener('click'"), 'Click listener registered');
      const clickIdx = appJs.indexOf("menuItemStarredMessages?.addEventListener('click'");
      const handler = appJs.slice(clickIdx, clickIdx + 300);
      assert.ok(handler.includes('closeChatHeaderMenu()'), 'Closes menu on selection');
      assert.ok(handler.includes('openStarredMessages(roomId)'), 'Opens starred messages panel with room ID');
    });
  });
});
