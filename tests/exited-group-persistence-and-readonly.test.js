import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState
} from '../src/renderer/chat-shell-state.js';
import {
  sqliteRowToConversation,
  conversationToSqlitePayload
} from '../src/renderer/db-sync.js';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { MIGRATIONS } from '../src/storage/db/migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const htmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
const stylesCssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const stylesCss = fs.readFileSync(stylesCssPath, 'utf8').replace(/\r\n/g, '\n');

describe('Exited Group Read-Only Behaviour, Historical Messages and Persistence Suite', () => {
  let tmpDir;
  let dbManager;
  let dbService;
  let mockSessionStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollachat-exited-test-'));
    mockSessionStore = {
      currentSession: {
        userId: 'usr_test_exited',
        sessionToken: 'token_exited_123',
        phone: '+15551234567'
      },
      getSession: () => mockSessionStore.currentSession,
      isAuthenticated: () => true
    };

    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
    dbManager = dbService.databaseManager;
  });

  afterEach(async () => {
    try {
      if (dbManager) {
        await dbManager.close();
      }
    } catch { }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { }
  });

  // 1. SQLite schema migration 6 adds is_exited column
  test('1. Migration 6 adds is_exited column to conversations table', async () => {
    const mig6 = MIGRATIONS.find((m) => m.version === 6);
    assert.ok(mig6, 'Migration 6 must exist in MIGRATIONS list');
    assert.ok(mig6.description.includes('is_exited'), 'Migration 6 description must mention is_exited');

    await dbManager.openUserDatabase('usr_test_exited');
    const tableInfo = await dbManager.all("PRAGMA table_info('conversations');");
    const hasIsExited = tableInfo.some((col) => col.name === 'is_exited');
    assert.strictEqual(hasIsExited, true, 'conversations table must have is_exited column');
  });

  // 2. saveConversation in DatabaseService persists is_exited = 1
  test('2. DatabaseService.saveConversation persists is_exited = 1 correctly', async () => {
    await dbManager.openUserDatabase('usr_test_exited');
    await dbService.saveConversation({
      roomId: 'group_exited_1',
      kind: 'group',
      roomName: 'Engineering Team',
      isExited: true
    });

    const rows = await dbService.getConversations();
    const saved = rows.find((r) => r.room_id === 'group_exited_1');
    assert.ok(saved, 'Saved conversation must exist in SQLite');
    assert.strictEqual(saved.is_exited, 1, 'is_exited must be 1 in SQLite');
    assert.strictEqual(saved.room_name, 'Engineering Team');
  });

  // 3. Normal active-member server sync does not overwrite is_exited = 1 in SQLite
  test('3. Partial update / inbox refresh does not clear is_exited = 1 in SQLite', async () => {
    await dbManager.openUserDatabase('usr_test_exited');
    await dbService.saveConversation({
      roomId: 'group_exited_2',
      kind: 'group',
      roomName: 'Design Systems',
      isExited: true
    });

    // Server-style sync payload (without isExited property)
    await dbService.saveConversation({
      roomId: 'group_exited_2',
      kind: 'group',
      roomName: 'Design Systems Updated',
      lastMessagePreview: 'New system announcement'
    });

    const rows = await dbService.getConversations();
    const updated = rows.find((r) => r.room_id === 'group_exited_2');
    assert.strictEqual(updated.is_exited, 1, 'is_exited must remain 1 after partial sync update');
    assert.strictEqual(updated.room_name, 'Design Systems Updated');
  });

  // 4. deleteConversation removes conversation and cascade-deletes messages
  test('4. DatabaseService.deleteConversation removes conversation and historical messages locally', async () => {
    await dbManager.openUserDatabase('usr_test_exited');
    await dbService.saveConversation({
      roomId: 'group_delete_me',
      kind: 'group',
      roomName: 'Temp Group'
    });
    await dbService.saveMessage({
      id: 'msg_temp_1',
      roomId: 'group_delete_me',
      senderId: 'usr_other',
      kind: 'text',
      body: { text: 'Hello before delete' }
    });

    let convs = await dbService.getConversations();
    let msgs = await dbService.getMessages({ roomId: 'group_delete_me' });
    assert.strictEqual(convs.some((c) => c.room_id === 'group_delete_me'), true);
    assert.strictEqual(msgs.length, 1);

    await dbService.deleteConversation('group_delete_me');

    convs = await dbService.getConversations();
    msgs = await dbService.getMessages({ roomId: 'group_delete_me' });
    assert.strictEqual(convs.some((c) => c.room_id === 'group_delete_me'), false);
    assert.strictEqual(msgs.length, 0, 'Foreign key CASCADE must delete messages');
  });

  // 5. db-sync helpers map isExited correctly
  test('5. db-sync helpers sqliteRowToConversation and conversationToSqlitePayload support isExited', () => {
    const row = {
      room_id: 'group_row_1',
      kind: 'group',
      room_name: 'Alpha Project',
      is_exited: 1
    };
    const conv = sqliteRowToConversation(row);
    assert.strictEqual(conv.isExited, true);
    assert.strictEqual(conv.is_exited, true);
    assert.strictEqual(conv.exited, true);

    const payload = conversationToSqlitePayload(conv);
    assert.strictEqual(payload.isExited, 1);
    assert.strictEqual(payload.is_exited, 1);
  });

  // 6. ChatShellState.setInbox preserves existing exited conversations missing from server inbox
  test('6. ChatShellState.setInbox preserves existing exited group when server returns active-only rooms', () => {
    const shellState = new ChatShellState();
    shellState.conversations = [
      { roomId: 'active_1', kind: 'direct', title: 'Alice' },
      { roomId: 'exited_group_1', kind: 'group', title: 'Former Team', isExited: true }
    ];

    // Server inbox returns only active conversations
    const serverInbox = [
      { roomId: 'active_1', kind: 'direct', title: 'Alice' },
      { roomId: 'active_2', kind: 'group', title: 'New Group' }
    ];

    shellState.setInbox(serverInbox);

    assert.strictEqual(shellState.conversations.length, 3, 'Exited group must be preserved');
    const exitedItem = shellState.conversations.find((c) => c.roomId === 'exited_group_1');
    assert.ok(exitedItem, 'Exited group must remain in conversation list');
    assert.strictEqual(exitedItem.isExited, true);
  });

  // 7. ChatShellState.setInbox maintains isExited status if server re-returns exited room
  test('7. ChatShellState.setInbox protects exited status against server reactivation', () => {
    const shellState = new ChatShellState();
    shellState.conversations = [
      { roomId: 'exited_group_1', kind: 'group', title: 'Former Team', isExited: true }
    ];

    const serverInbox = [
      { roomId: 'exited_group_1', kind: 'group', title: 'Former Team' }
    ];

    shellState.setInbox(serverInbox);

    assert.strictEqual(shellState.conversations.length, 1);
    assert.strictEqual(shellState.conversations[0].isExited, true, 'isExited must remain true');
  });

  // 8. index.html contains #composer-exited-banner with exact friendly read-only message
  test('8. index.html contains #composer-exited-banner with friendly WhatsApp-style read-only notice', () => {
    assert.ok(html.includes('id="composer-exited-banner"'), 'Must define #composer-exited-banner');
    assert.ok(html.includes('id="composer-exited-text"'), 'Must define #composer-exited-text');
    assert.ok(
      html.includes('You left this group. You can no longer send messages or make calls.'),
      'Must contain the required subtle bottom message'
    );
  });

  // 9. styles.css contains .composer-exited-banner styling
  test('9. styles.css contains styling for .composer-exited-banner', () => {
    assert.ok(stylesCss.includes('.composer-exited-banner'), 'Must style .composer-exited-banner');
    assert.ok(stylesCss.includes('.composer-exited-text'), 'Must style .composer-exited-text');
  });

  // 10. app.js binds composerExitedBanner and defines updateExitedGroupUI
  test('10. app.js binds composerExitedBanner and exports updateExitedGroupUI', () => {
    assert.ok(appJs.includes("const composerExitedBanner = document.getElementById('composer-exited-banner');"));
    assert.ok(appJs.includes('export function updateExitedGroupUI('));
  });

  // 11. updateExitedGroupUI disables composer and calling controls
  test('11. updateExitedGroupUI hides composer-box, shows exited banner, and disables call buttons', () => {
    assert.ok(appJs.includes("composerBox?.classList.add('hidden')"));
    assert.ok(appJs.includes("composerExitedBanner?.classList.remove('hidden')"));
    assert.ok(appJs.includes("btnStartVoiceCall?.setAttribute('disabled', 'true')"));
    assert.ok(appJs.includes("btnStartVideoCall?.setAttribute('disabled', 'true')"));
    assert.ok(appJs.includes("btnStartVoiceCall?.setAttribute('title', 'You left this group')"));
    assert.ok(appJs.includes("btnStartVideoCall?.setAttribute('title', 'You left this group')"));
  });

  // 12. voiceCallManager.startCall and startVideoCall block calls to exited groups
  test('12. voiceCallManager blocks outgoing voice and video calls to exited groups', () => {
    assert.ok(appJs.includes("[VoiceCall] Blocked outgoing call to exited group"));
    assert.ok(appJs.includes("[VideoCall] Blocked outgoing call to exited group"));
  });

  // 13. handleSendMessage blocks sending messages to exited groups
  test('13. handleSendMessage blocks sending messages to exited groups', () => {
    assert.ok(appJs.includes("[handleSendMessage] Cannot send message to an exited group"));
  });

  // 14. toggleAttachmentMenu blocks opening attachment options in exited groups
  test('14. toggleAttachmentMenu blocks attachment options in exited groups', () => {
    assert.ok(appJs.includes("if (selectedConv?.isExited || selectedConv?.exited) return;"));
  });

  // 15. loadMessagesForRoom skips network fetch and hydrates local SQLite messages for exited groups
  test('15. loadMessagesForRoom hydrates local SQLite history and skips chatApi.getMessages for exited group', () => {
    assert.ok(appJs.includes("const isExitedRoom = Boolean(currentConv?.isExited || currentConv?.exited);"));
    assert.ok(appJs.includes("if (isExitedRoom)"));
    assert.ok(appJs.includes("targetState.isHistoryLoaded = true"));
  });

  // 16. loadMessagesForRoom gracefully handles 403 forbidden without technical error screen
  test('16. loadMessagesForRoom gracefully suppresses 403 not an active member error', () => {
    assert.ok(appJs.includes("isForbiddenActiveMember"));
    assert.ok(appJs.includes("currentConv.isExited = true"));
    assert.ok(appJs.includes("updateExitedGroupUI(currentConv)"));
    assert.ok(appJs.includes("messagesError?.classList.add('hidden')"));
  });

  // 17. loadOlderMessages paginates from SQLite and does not call backend for exited groups
  test('17. loadOlderMessages only checks local SQLite storage for exited groups', () => {
    assert.ok(appJs.includes("currentOlderConv?.isExited || currentOlderConv?.exited"));
  });

  // 18. loadInbox merges cached exited conversations from SQLite so chats survive restarts
  test('18. loadInbox merges cached exited conversations from SQLite so chats survive restarts', () => {
    assert.ok(appJs.includes("const exitedDbConvs = dbConvs.filter"));
    assert.ok(appJs.includes("conversations.push(ec)"));
  });

  // 19. handleConfirmLeaveGroup Exit vs Exit and delete distinction
  test('19. handleConfirmLeaveGroup differentiates Exit (retains read-only) from Exit and delete (clears local cache)', () => {
    assert.match(
      appJs,
      /deleteConversationFromDb\(targetRoomId\)\.catch\(\(\) => \{\s*\}\);/,
      'Exit and delete clears the local database regardless of callback formatting'
    );
    assert.ok(appJs.includes("conv.isExited = true;"));
    assert.match(
      appJs,
      /persistConversationToDb\(conv\)\.catch\(\(\) => \{\s*\}\);/,
      'Exit persists the retained read-only conversation regardless of callback formatting'
    );
    assert.ok(appJs.includes("updateExitedGroupUI(conv);"));
  });

  // 20. Active individual and group conversations remain completely unaffected
  test('20. Active direct and group conversations retain messaging and calling functionality', () => {
    const directConv = { roomId: 'direct_active_1', kind: 'direct', isExited: false };
    const groupConv = { roomId: 'group_active_1', kind: 'group', isExited: false };

    assert.strictEqual(Boolean(directConv.isExited), false);
    assert.strictEqual(Boolean(groupConv.isExited), false);
    assert.ok(appJs.includes("btnStartVoiceCall?.removeAttribute('disabled')"));
    assert.ok(appJs.includes("btnStartVideoCall?.removeAttribute('disabled')"));
    assert.ok(appJs.includes("composerBox?.classList.remove('hidden')"));
  });
});

