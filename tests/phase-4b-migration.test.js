import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  collectLocalStorageMigrationData,
  runLocalStorageMigration,
  hydrateMigratedStateFromDb
} from '../src/renderer/localstorage-migrator.js';

describe('Phase 4B: Safe LocalStorage -> SQLite Migration Tests', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-phase4b-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_alice',
        sessionToken: 'token_secret_123',
        phone: '+15550001'
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
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 1. localStorage audit/migration collector
  test('1. localStorage audit/migration: parses and normalizes legacy localStorage keys', () => {
    const memoryStorage = new Map();
    globalThis.localStorage = {
      getItem: (k) => memoryStorage.get(k) || null,
      setItem: (k, v) => memoryStorage.set(k, String(v)),
      removeItem: (k) => memoryStorage.delete(k)
    };

    const userKey = 'user_alice';
    memoryStorage.set(`ollachat_pinned_chats_${userKey}`, JSON.stringify(['room_1', 'room_2']));
    memoryStorage.set(`ollachat_favourite_chats_${userKey}`, JSON.stringify(['room_2', 'room_3']));
    memoryStorage.set(`ollachat_archived_chats_${userKey}`, JSON.stringify(['room_4']));
    memoryStorage.set(`ollachat_marked_unread_${userKey}`, JSON.stringify(['room_1']));
    memoryStorage.set(`ollachat_custom_lists_${userKey}`, JSON.stringify([{ id: 'list_1', name: 'Work', roomIds: ['room_1'] }]));
    memoryStorage.set(`ollachat_call_history_${userKey}`, JSON.stringify([{ id: 'call_1', roomId: 'room_1', duration: 45, status: 'completed' }]));
    memoryStorage.set(`ollachat_contact_nicknames_${userKey}`, JSON.stringify({ user_bob: 'Bobby' }));
    memoryStorage.set(`ollachat_pinned_messages_${userKey}`, JSON.stringify({ room_1: 'msg_99' }));
    memoryStorage.set(`ollachat_unread_edits_${userKey}`, JSON.stringify({ room_1: ['msg_88'] }));
    memoryStorage.set(`ollachat_deleted_for_me_${userKey}`, JSON.stringify(['msg_77']));
    memoryStorage.set(`ollachat_starred_${userKey}`, JSON.stringify(['msg_66']));

    const collected = collectLocalStorageMigrationData(userKey);

    assert.deepEqual(collected.pinnedRoomIds, ['room_1', 'room_2']);
    assert.deepEqual(collected.favouriteRoomIds, ['room_2', 'room_3']);
    assert.deepEqual(collected.archivedRoomIds, ['room_4']);
    assert.deepEqual(collected.markedUnreadRoomIds, ['room_1']);
    assert.equal(collected.customLists.length, 1);
    assert.equal(collected.customLists[0].name, 'Work');
    assert.equal(collected.callHistory.length, 1);
    assert.equal(collected.contactNicknames.user_bob, 'Bobby');
    assert.equal(collected.pinnedMessages.room_1, 'msg_99');
    assert.deepEqual(collected.unreadEdits.room_1, ['msg_88']);
    assert.deepEqual(collected.deletedForMeMessageIds, ['msg_77']);
    assert.deepEqual(collected.starredMessageIds, ['msg_66']);
  });

  // 2. Migration versioning
  test('2. migration versioning: records localstorage_migration_version in app_metadata', async () => {
    const payload = {
      version: 1,
      data: {
        pinnedRoomIds: ['room_work']
      }
    };

    const res = await dbService.migrateLocalStorage(payload);
    assert.equal(res.ok, true);
    assert.equal(res.version, 1);
    assert.equal(res.migrated, true);

    const meta = await dbService.getMetadata({ key: 'localstorage_migration_version' });
    assert.ok(meta);
    assert.equal(meta.value, '1');
  });

  // 3. Idempotent migration
  test('3. idempotent migration: running migration twice is a safe no-op on second run', async () => {
    const payload = {
      version: 1,
      data: {
        pinnedRoomIds: ['room_alpha'],
        favouriteRoomIds: ['room_beta']
      }
    };

    const firstRun = await dbService.migrateLocalStorage(payload);
    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.migrated, true);

    const secondRun = await dbService.migrateLocalStorage(payload);
    assert.equal(secondRun.ok, true);
    assert.equal(secondRun.alreadyMigrated, true);
    assert.equal(secondRun.version, 1);
  });

  // 4. Pin migration
  test('4. pin migration: sets is_pinned = 1 and orders correctly in conversations', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_first', 'room_second']
      }
    });

    const convs = await dbService.getConversations();
    assert.equal(convs.length, 2);

    const first = convs.find(c => c.room_id === 'room_first');
    const second = convs.find(c => c.room_id === 'room_second');

    assert.ok(first);
    assert.equal(first.is_pinned, 1);
    assert.equal(first.pinned_order, 0);

    assert.ok(second);
    assert.equal(second.is_pinned, 1);
    assert.equal(second.pinned_order, 1);
  });

  // 5. Favourite migration
  test('5. favourite migration: sets is_favourite = 1 on conversations', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        favouriteRoomIds: ['room_best_friends']
      }
    });

    const convs = await dbService.getConversations();
    assert.equal(convs.length, 1);
    assert.equal(convs[0].room_id, 'room_best_friends');
    assert.equal(convs[0].is_favourite, 1);
  });

  // 6. Custom-list migration
  test('6. custom-list migration: persists custom lists and list member rooms', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        customLists: [
          { id: 'list_clients', name: 'Clients', roomIds: ['room_c1', 'room_c2'] },
          { id: 'list_family', name: 'Family', roomIds: ['room_f1'] }
        ]
      }
    });

    const lists = await dbService.getCustomLists();
    assert.equal(lists.length, 2);

    const clientsList = lists.find(l => l.id === 'list_clients');
    assert.ok(clientsList);
    assert.equal(clientsList.name, 'Clients');
    assert.deepEqual(clientsList.roomIds.sort(), ['room_c1', 'room_c2']);

    const familyList = lists.find(l => l.id === 'list_family');
    assert.ok(familyList);
    assert.equal(familyList.name, 'Family');
    assert.deepEqual(familyList.roomIds, ['room_f1']);
  });

  // 7. Unread-state migration
  test('7. unread-state migration: preserves marked-unread state on conversations', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        markedUnreadRoomIds: ['room_unread_1']
      }
    });

    const convs = await dbService.getConversations();
    assert.equal(convs.length, 1);
    assert.equal(convs[0].room_id, 'room_unread_1');
    assert.equal(convs[0].is_marked_unread, 1);
  });

  // 8. Call-history migration
  test('8. call-history migration: migrates call history to call_records table', async () => {
    const startedMs = Date.now() - 60000;
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        callHistory: [
          {
            id: 'call_rec_100',
            callId: 'sig_call_100',
            roomId: 'room_alice_bob',
            participantId: 'user_bob',
            direction: 'incoming',
            callType: 'video',
            status: 'completed',
            duration: 125,
            startedAt: startedMs
          }
        ]
      }
    });

    const calls = await dbService.getCallRecords();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'call_rec_100');
    assert.equal(calls[0].room_id, 'room_alice_bob');
    assert.equal(calls[0].peer_user_id, 'user_bob');
    assert.equal(calls[0].call_type, 'video');
    assert.equal(calls[0].direction, 'incoming');
    assert.equal(calls[0].duration_seconds, 125);
  });

  // 9. Existing SQLite data is not incorrectly overwritten
  test('9. existing SQLite data is not incorrectly overwritten by older localStorage data', async () => {
    // Phase 4A already saved an updated conversation
    await dbService.saveConversation({
      roomId: 'room_vip',
      roomName: 'VIP Channel (Updated)',
      isPinned: 1,
      pinnedOrder: 5,
      isFavourite: 1,
      unreadCount: 12
    });

    // Older localStorage data arrives
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_vip'],
        favouriteRoomIds: ['room_vip']
      }
    });

    const convs = await dbService.getConversations();
    const vip = convs.find(c => c.room_id === 'room_vip');
    assert.ok(vip);
    assert.equal(vip.room_name, 'VIP Channel (Updated)');
    assert.equal(vip.is_pinned, 1);
    assert.equal(vip.pinned_order, 5); // Kept existing pinned_order from SQLite
    assert.equal(vip.unread_count, 12); // Did not clobber unread count
  });

  // 10. Migration failure preserves localStorage
  test('10. migration failure preserves localStorage data untouched', async () => {
    const memoryStorage = new Map();
    globalThis.localStorage = {
      getItem: (k) => memoryStorage.get(k) || null,
      setItem: (k, v) => memoryStorage.set(k, String(v)),
      removeItem: (k) => memoryStorage.delete(k)
    };

    const userKey = 'user_alice';
    const originalPinned = JSON.stringify(['room_preserve']);
    memoryStorage.set(`ollachat_pinned_chats_${userKey}`, originalPinned);

    // Faulty bridge that rejects migration
    const brokenDb = {
      getMetadata: async () => null,
      migrateLocalStorage: async () => {
        throw new Error('Disk I/O failure simulated');
      }
    };

    const result = await runLocalStorageMigration(userKey, brokenDb);
    assert.equal(result.ok, false);
    assert.match(result.error, /Disk I\/O failure simulated/);

    // Verify localStorage key was NOT modified or deleted
    assert.equal(memoryStorage.get(`ollachat_pinned_chats_${userKey}`), originalPinned);
    assert.equal(memoryStorage.get(`ollachat_migrated_v1_${userKey}`), undefined);
  });

  // 11. Migration with empty localStorage
  test('11. migration with empty localStorage succeeds and marks version', async () => {
    const memoryStorage = new Map();
    globalThis.localStorage = {
      getItem: (k) => memoryStorage.get(k) || null,
      setItem: (k, v) => memoryStorage.set(k, String(v)),
      removeItem: (k) => memoryStorage.delete(k)
    };

    const userKey = 'user_alice';
    const result = await runLocalStorageMigration(userKey, dbService);

    assert.equal(result.ok, true);
    assert.equal(result.migrated, true);
    assert.equal(result.version, 1);

    const meta = await dbService.getMetadata({ key: 'localstorage_migration_version' });
    assert.equal(meta.value, '1');
  });

  // 12. Restart after migration
  test('12. restart after migration: closing and reopening database preserves migration metadata', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_persisted']
      }
    });

    // Close database connection
    await dbService.databaseManager.close();

    // Create fresh database service instance pointing to same directory
    const reopenedDb = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const meta = await reopenedDb.getMetadata({ key: 'localstorage_migration_version' });
    assert.ok(meta);
    assert.equal(meta.value, '1');

    await reopenedDb.databaseManager.close();
  });

  // 13. Migrated data remains available after restart
  test('13. migrated data remains available after restart', async () => {
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_restart'],
        customLists: [{ id: 'list_restart', name: 'Restart Test', roomIds: ['room_restart'] }]
      }
    });

    await dbService.databaseManager.close();

    const reopenedDb = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const convs = await reopenedDb.getConversations();
    const conv = convs.find(c => c.room_id === 'room_restart');
    assert.ok(conv);
    assert.equal(conv.is_pinned, 1);

    const lists = await reopenedDb.getCustomLists();
    assert.equal(lists.length, 1);
    assert.equal(lists[0].name, 'Restart Test');

    // Test renderer hydration with reopened DB
    const mockShellState = {
      customLists: [],
      contactNicknames: new Map(),
      pinnedMessages: new Map()
    };
    await hydrateMigratedStateFromDb(mockShellState, reopenedDb);
    assert.equal(mockShellState.customLists.length, 1);
    assert.equal(mockShellState.customLists[0].name, 'Restart Test');

    await reopenedDb.databaseManager.close();
  });

  // 14. User isolation
  test('14. user isolation: migrations are isolated per authenticated user', async () => {
    // 1. Migrate for Alice
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_alice_private']
      }
    });

    const aliceConvs = await dbService.getConversations();
    assert.equal(aliceConvs.some(c => c.room_id === 'room_alice_private'), true);

    // 2. Switch session to Bob
    mockSessionStore.currentSession = {
      userId: 'user_bob',
      sessionToken: 'token_bob_456',
      phone: '+15550002'
    };

    const bobDb = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    // Bob's metadata should NOT be migrated yet
    const bobMeta = await bobDb.getMetadata({ key: 'localstorage_migration_version' });
    assert.equal(bobMeta, null);

    // Bob should not see Alice's conversations
    const bobConvs = await bobDb.getConversations();
    assert.equal(bobConvs.length, 0);

    // 3. Migrate for Bob
    await bobDb.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_bob_private']
      }
    });

    const bobConvsAfter = await bobDb.getConversations();
    assert.equal(bobConvsAfter.length, 1);
    assert.equal(bobConvsAfter[0].room_id, 'room_bob_private');

    await bobDb.databaseManager.close();
  });

  // 15. Existing Phase 4A persistence still works seamlessly
  test('15. existing Phase 4A persistence still works alongside Phase 4B migration', async () => {
    // Run Phase 4B migration
    await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_collab']
      }
    });

    // Save a Phase 4A message
    const msg = {
      id: 'msg_persist_1',
      roomId: 'room_collab',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Testing Phase 4A + 4B synergy' },
      status: 'sent',
      createdAt: new Date().toISOString()
    };
    await dbService.saveMessage(msg);

    // Query messages
    const loadedMsgs = await dbService.getMessages({ roomId: 'room_collab' });
    assert.equal(loadedMsgs.length, 1);
    assert.equal(loadedMsgs[0].id, 'msg_persist_1');

    // Update message tombstone (deleted for me)
    await dbService.markMessageDeletedForMe({ id: 'msg_persist_1' });
    const afterDelete = await dbService.getMessages({ roomId: 'room_collab' });
    assert.equal(afterDelete[0].is_deleted_for_me, 1);
  });
});
