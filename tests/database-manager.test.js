import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager, sanitizeUserId } from '../src/storage/db/database-manager.js';

describe('DatabaseManager & SQLite Foundation Tests', () => {
  let tmpDir;
  let dbManager;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-db-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(async () => {
    if (dbManager && dbManager.isOpen) {
      await dbManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('User ID Sanitization', () => {
    test('accepts valid alphanumeric, dashed, and underscored user IDs', () => {
      assert.equal(sanitizeUserId('user123'), 'user123');
      assert.equal(sanitizeUserId('usr_456-abc'), 'usr_456-abc');
      assert.equal(sanitizeUserId('0123456789'), '0123456789');
    });

    test('rejects path traversal and unsafe characters', () => {
      assert.throws(() => sanitizeUserId('../evil'), /Unsafe userId/);
      assert.throws(() => sanitizeUserId('user/name'), /Unsafe userId/);
      assert.throws(() => sanitizeUserId('user\\name'), /Unsafe userId/);
      assert.throws(() => sanitizeUserId('user;DROP TABLE'), /Unsafe userId/);
      assert.throws(() => sanitizeUserId(''), /Invalid userId/);
      assert.throws(() => sanitizeUserId(null), /Invalid userId/);
      assert.throws(() => sanitizeUserId(123), /Invalid userId/);
    });
  });

  describe('Lifecycle & Multi-User Isolation', () => {
    test('fails if constructor is missing storage directory', () => {
      assert.throws(() => new DatabaseManager(), /requires a valid storage directory path/);
    });

    test('throws if operations are attempted before opening a database', async () => {
      await assert.rejects(async () => await dbManager.run('SELECT 1;'), /No user database is currently open/);
      await assert.rejects(async () => await dbManager.get('SELECT 1;'), /No user database is currently open/);
      await assert.rejects(async () => await dbManager.all('SELECT 1;'), /No user database is currently open/);
      await assert.rejects(async () => await dbManager.exec('SELECT 1;'), /No user database is currently open/);
      await assert.rejects(async () => await dbManager.checkIntegrity(), /No user database is currently open/);
    });

    test('opens database in correct per-user subdirectory', async () => {
      await dbManager.openUserDatabase('user_alpha');
      assert.equal(dbManager.isOpen, true);
      assert.equal(dbManager.getCurrentUserId(), 'user_alpha');

      const expectedPath = path.join(tmpDir, 'databases', 'users', 'user_alpha', 'ollachat.db');
      assert.equal(dbManager.getDatabasePath(), expectedPath);

      const exists = await fs.stat(expectedPath).then(() => true).catch(() => false);
      assert.equal(exists, true);
    });

    test('switching users cleanly isolates data and directory structures', async () => {
      // 1. Open User Alpha
      await dbManager.openUserDatabase('user_alpha');
      await dbManager.run(
        `INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);`,
        ['room_alpha', 'Alpha Chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']
      );
      const alphaCount = await dbManager.get('SELECT COUNT(*) AS total FROM conversations;');
      assert.equal(alphaCount.total, 1);

      // 2. Open User Beta
      await dbManager.openUserDatabase('user_beta');
      assert.equal(dbManager.getCurrentUserId(), 'user_beta');
      const betaCount = await dbManager.get('SELECT COUNT(*) AS total FROM conversations;');
      assert.equal(betaCount.total, 0, 'User Beta must have 0 conversations');

      await dbManager.run(
        `INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);`,
        ['room_beta', 'Beta Chat', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z']
      );

      // 3. Switch back to User Alpha
      await dbManager.openUserDatabase('user_alpha');
      const alphaAgain = await dbManager.all('SELECT room_id, room_name FROM conversations;');
      assert.equal(alphaAgain.length, 1);
      assert.equal(alphaAgain[0].room_id, 'room_alpha');
    });

    test('calling openUserDatabase with the same user ID is an idempotent no-op', async () => {
      await dbManager.openUserDatabase('user_alpha');
      const originalPath = dbManager.getDatabasePath();
      await dbManager.openUserDatabase('user_alpha');
      assert.equal(dbManager.getDatabasePath(), originalPath);
      assert.equal(dbManager.isOpen, true);
    });
  });

  describe('PRAGMA Configurations', () => {
    test('enforces WAL mode, foreign keys ON, and integrity check', async () => {
      await dbManager.openUserDatabase('user_pragmas');

      const walRow = await dbManager.get('PRAGMA journal_mode;');
      assert.equal(String(Object.values(walRow)[0]).toLowerCase(), 'wal');

      const fkRow = await dbManager.get('PRAGMA foreign_keys;');
      assert.equal(Number(Object.values(fkRow)[0]), 1);

      const health = await dbManager.checkIntegrity();
      assert.equal(health.ok, true);
      assert.equal(health.message, 'ok');
    });
  });

  describe('Schema Migrations', () => {
    test('applies migrations and creates all tables up to current version', async () => {
      await dbManager.openUserDatabase('user_schema');

      const version = await dbManager.getCurrentSchemaVersion();
      assert.equal(version, 6);

      const tables = await dbManager.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;");
      const tableNames = tables.map((t) => t.name);

      const expected = [
        'app_metadata',
        'attachments',
        'blocked_users',
        'call_records',
        'contact_cache',
        'conversations',
        'custom_list_members',
        'custom_lists',
        'message_receipts',
        'messages',
        'pending_outbox',
        'schema_migrations',
        'upload_sessions'
      ];

      for (const exp of expected) {
        assert.ok(tableNames.includes(exp), `Expected table ${exp} to exist`);
      }
    });

    test('safely upgrades existing database from v1 to v3 preserving data', async () => {
      const { MIGRATIONS } = await import('../src/storage/db/migrations.js');
      const v1Only = [MIGRATIONS[0]];
      const v1Manager = new DatabaseManager(tmpDir, { migrations: v1Only });
      await v1Manager.openUserDatabase('user_upgrade_v1_v2');

      assert.equal(await v1Manager.getCurrentSchemaVersion(), 1);

      // Seed data into v1 tables
      await v1Manager.run(
        'INSERT INTO conversations (room_id, room_name, peer_phone, peer_user_id, peer_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
        ['room_v1', 'Pre-existing Chat', '+15551234567', 'usr_upgrade_peer', 'Upgrade Peer', '2026-01-01', '2026-01-01']
      );
      await v1Manager.run(
        `INSERT INTO messages (id, room_id, sender_id, client_message_id, kind, body_json, status, created_at, local_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        ['msg_v1', 'room_v1', 'user_v1', 'c_v1', 'text', '{"text":"Hello"}', 'sent', '2026-01-01', '2026-01-01']
      );
      await v1Manager.close();

      // Now open with full dbManager (has v1, v2, v3, v4, v5, v6)
      await dbManager.openUserDatabase('user_upgrade_v1_v2');
      assert.equal(await dbManager.getCurrentSchemaVersion(), 6);

      // Verify data is completely preserved
      const conv = await dbManager.get('SELECT room_name FROM conversations WHERE room_id = ?;', ['room_v1']);
      assert.equal(conv?.room_name, 'Pre-existing Chat');

      const msg = await dbManager.get('SELECT id FROM messages WHERE id = ?;', ['msg_v1']);
      assert.equal(msg?.id, 'msg_v1');

      // Verify upload_sessions table was successfully added
      const uploadTable = await dbManager.get("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_sessions';");
      assert.ok(uploadTable);

      // Verify contact_cache table was successfully added and auto-seeded from conversation
      const contactTable = await dbManager.get("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_cache';");
      assert.ok(contactTable);
      const seededContact = await dbManager.get('SELECT * FROM contact_cache WHERE phone = ?;', ['+15551234567']);
      assert.equal(seededContact?.user_id, 'usr_upgrade_peer');
      assert.equal(seededContact?.display_name, 'Upgrade Peer');
    });

    test('migration runner handles incremental version upgrades', async () => {
      const customMigrations = [
        {
          version: 1,
          description: 'Initial',
          up: async (db) => {
            await db.exec('CREATE TABLE test_v1 (id TEXT PRIMARY KEY);');
          }
        },
        {
          version: 2,
          description: 'Upgrade test',
          up: async (db) => {
            await db.exec('CREATE TABLE test_v2 (id TEXT PRIMARY KEY, extra TEXT);');
          }
        }
      ];

      const customManager = new DatabaseManager(tmpDir, { migrations: customMigrations });
      await customManager.openUserDatabase('user_mig_test');

      const ver = await customManager.getCurrentSchemaVersion();
      assert.equal(ver, 2);

      const v2Exists = await customManager.get("SELECT name FROM sqlite_master WHERE type='table' AND name='test_v2';");
      assert.ok(v2Exists);

      await customManager.close();
    });
  });

  describe('CRUD Operations & Relational Constraints', () => {
    beforeEach(async () => {
      await dbManager.openUserDatabase('user_crud');
    });

    test('supports run, get, all, and exec methods', async () => {
      // 1. exec
      await dbManager.exec(`
        INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES ('r-1', 'Chat 1', '2026-01-01', '2026-01-01');
        INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES ('r-2', 'Chat 2', '2026-01-01', '2026-01-01');
      `);

      // 2. all
      const list = await dbManager.all('SELECT room_id FROM conversations ORDER BY room_id ASC;');
      assert.equal(list.length, 2);
      assert.equal(list[0].room_id, 'r-1');

      // 3. get
      const single = await dbManager.get('SELECT room_name FROM conversations WHERE room_id = ?;', ['r-1']);
      assert.equal(single.room_name, 'Chat 1');

      // 4. run (UPDATE)
      const updateRes = await dbManager.run('UPDATE conversations SET room_name = ? WHERE room_id = ?;', ['Updated Chat', 'r-1']);
      assert.equal(updateRes.changes, 1);
      const updated = await dbManager.get('SELECT room_name FROM conversations WHERE room_id = ?;', ['r-1']);
      assert.equal(updated.room_name, 'Updated Chat');

      // 5. run (DELETE)
      const delRes = await dbManager.run('DELETE FROM conversations WHERE room_id = ?;', ['r-2']);
      assert.equal(delRes.changes, 1);
      const remaining = await dbManager.all('SELECT room_id FROM conversations;');
      assert.equal(remaining.length, 1);
    });

    test('enforces foreign key cascading deletes across messages, receipts, and attachments', async () => {
      // Create conversation
      await dbManager.run(
        'INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);',
        ['room-fk', 'Test Room', '2026-01-01', '2026-01-01']
      );

      // Create message
      await dbManager.run(
        `INSERT INTO messages (id, room_id, sender_id, client_message_id, kind, body_json, created_at, local_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['m-1', 'room-fk', 'sender-1', 'client-uuid-1', 'text', '{"text":"Hello"}', '2026-01-01', '2026-01-01']
      );

      // Create receipt
      await dbManager.run(
        'INSERT INTO message_receipts (message_id, recipient_id, status, receipt_timestamp) VALUES (?, ?, ?, ?);',
        ['m-1', 'recipient-1', 'delivered', '2026-01-01']
      );

      // Create attachment
      await dbManager.run(
        `INSERT INTO attachments (id, message_id, room_id, file_name, mime_type, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ['att-1', 'm-1', 'room-fk', 'photo.jpg', 'image/jpeg', 1024, '2026-01-01']
      );

      // Create call record
      await dbManager.run(
        `INSERT INTO call_records (id, call_id, room_id, peer_user_id, direction, call_type, status, duration_seconds, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        ['rec-1', 'call-sess-1', 'room-fk', 'peer-1', 'incoming', 'voice', 'answered', 45, '2026-01-01']
      );

      // Verify all rows exist
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM messages WHERE room_id = ?;', ['room-fk'])).c, 1);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM message_receipts WHERE message_id = ?;', ['m-1'])).c, 1);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM attachments WHERE message_id = ?;', ['m-1'])).c, 1);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM call_records WHERE room_id = ?;', ['room-fk'])).c, 1);

      // Delete the conversation
      await dbManager.run('DELETE FROM conversations WHERE room_id = ?;', ['room-fk']);

      // Verify cascading delete wiped all dependent child records
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM messages WHERE room_id = ?;', ['room-fk'])).c, 0);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM message_receipts WHERE message_id = ?;', ['m-1'])).c, 0);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM attachments WHERE message_id = ?;', ['m-1'])).c, 0);
      assert.equal((await dbManager.get('SELECT COUNT(*) AS c FROM call_records WHERE room_id = ?;', ['room-fk'])).c, 0);
    });

    test('rejects orphan messages if conversation does not exist', async () => {
      await assert.rejects(async () => {
        await dbManager.run(
          `INSERT INTO messages (id, room_id, sender_id, client_message_id, kind, body_json, created_at, local_received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          ['m-orphan', 'non-existent-room', 'u1', 'c1', 'text', '{}', '2026-01-01', '2026-01-01']
        );
      }, /FOREIGN KEY constraint failed/);
    });

    test('enforces UNIQUE constraint on client_message_id to prevent duplicates', async () => {
      await dbManager.run(
        'INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);',
        ['room-uniq', 'Test', '2026-01-01', '2026-01-01']
      );

      await dbManager.run(
        `INSERT INTO messages (id, room_id, sender_id, client_message_id, kind, body_json, created_at, local_received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        ['m-1', 'room-uniq', 'u1', 'dup-client-id', 'text', '{}', '2026-01-01', '2026-01-01']
      );

      await assert.rejects(async () => {
        await dbManager.run(
          `INSERT INTO messages (id, room_id, sender_id, client_message_id, kind, body_json, created_at, local_received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          ['m-2', 'room-uniq', 'u1', 'dup-client-id', 'text', '{}', '2026-01-01', '2026-01-01']
        );
      }, /UNIQUE constraint failed: messages.client_message_id/);
    });
  });

  describe('Atomic Transactions', () => {
    beforeEach(async () => {
      await dbManager.openUserDatabase('user_tx');
    });

    test('commits all operations if transaction callback resolves', async () => {
      await dbManager.transaction(async () => {
        await dbManager.run(
          'INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);',
          ['tx-1', 'Chat Tx 1', '2026-01-01', '2026-01-01']
        );
        await dbManager.run(
          'INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);',
          ['tx-2', 'Chat Tx 2', '2026-01-01', '2026-01-01']
        );
      });

      const total = await dbManager.get('SELECT COUNT(*) AS c FROM conversations;');
      assert.equal(total.c, 2);
    });

    test('rolls back all operations if transaction callback rejects', async () => {
      await assert.rejects(async () => {
        await dbManager.transaction(async () => {
          await dbManager.run(
            'INSERT INTO conversations (room_id, room_name, created_at, updated_at) VALUES (?, ?, ?, ?);',
            ['tx-valid', 'Valid Chat', '2026-01-01', '2026-01-01']
          );
          // Deliberate error
          throw new Error('Simulated failure during transaction');
        });
      }, /Simulated failure during transaction/);

      const total = await dbManager.get('SELECT COUNT(*) AS c FROM conversations;');
      assert.equal(total.c, 0, 'No partial writes must persist after rollback');
    });
  });
});
