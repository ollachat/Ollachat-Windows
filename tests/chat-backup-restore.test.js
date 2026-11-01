import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  BackupService,
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC_FORMAT,
  packTarGzArchive,
  unpackTarArchive,
  computeSha256,
  validateTarEntryPath
} from '../src/storage/backup-service.js';

describe('Chat Backup & Restore Suite (Phase 3)', () => {
  let tempBaseDir;
  let dbManager;
  let dbService;
  let sessionStoreMock;
  let backupService;
  const testUserId = 'usr_alice123';

  beforeEach(async () => {
    tempBaseDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ollachat-backup-test-'));

    sessionStoreMock = {
      currentSession: {
        userId: testUserId,
        phone: '+15551234567',
        displayName: 'Alice Nakamura',
        sessionToken: 'secret_token_never_export'
      },
      getSession() {
        return this.currentSession;
      }
    };

    dbManager = new DatabaseManager(tempBaseDir);
    dbService = new DatabaseService({
      storageDir: tempBaseDir,
      databaseManager: dbManager,
      sessionStore: sessionStoreMock
    });

    backupService = new BackupService({
      databaseService: dbService,
      storageDir: tempBaseDir,
      sessionStore: sessionStoreMock
    });

    // Initialize user database and seed some test data
    await dbManager.openUserDatabase(testUserId);
    await dbService._ensureStagedReceiptsTable();

    // 1. Seed conversation
    await dbManager.run(`
      INSERT INTO conversations (
        room_id, kind, room_name, peer_user_id, peer_phone, peer_display_name,
        unread_count, is_pinned, is_favourite, draft_text, created_at, updated_at
      ) VALUES (
        'room_bob', 'direct', 'Bob', 'usr_bob', '+15559876543', 'Bob Smith',
        0, 1, 1, 'Hey Bob, drafting...', '2026-10-26T10:00:00.000Z', '2026-10-26T10:00:00.000Z'
      );
    `);

    // 2. Seed messages
    await dbManager.run(`
      INSERT INTO messages (
        id, room_id, sender_id, client_message_id, kind, body_json, status,
        is_deleted, is_starred, is_deleted_for_me, created_at, local_received_at
      ) VALUES (
        'msg_1', 'room_bob', 'usr_bob', 'cli_1', 'text', '{"text":"Hello Alice!"}', 'read',
        0, 1, 0, '2026-10-26T10:01:00.000Z', '2026-10-26T10:01:01.000Z'
      );
    `);
    await dbManager.run(`
      INSERT INTO messages (
        id, room_id, sender_id, client_message_id, kind, body_json, status,
        is_deleted, is_starred, is_deleted_for_me, created_at, local_received_at
      ) VALUES (
        'msg_2', 'room_bob', '${testUserId}', 'cli_2', 'text', '{"text":"Hi Bob, meeting at 3?"}', 'delivered',
        0, 0, 0, '2026-10-26T10:02:00.000Z', '2026-10-26T10:02:01.000Z'
      );
    `);

    // 3. Seed reaction
    await dbManager.run(`
      INSERT INTO message_reactions (
        message_id, room_id, user_id, emoji, created_at
      ) VALUES (
        'msg_1', 'room_bob', '${testUserId}', '❤️', '2026-10-26T10:01:10.000Z'
      );
    `);

    // 4. Seed call record
    await dbManager.run(`
      INSERT INTO call_records (
        id, call_id, room_id, peer_user_id, direction, call_type, status, duration_seconds, started_at
      ) VALUES (
        'call_1', 'call_id_1', 'room_bob', 'usr_bob', 'incoming', 'voice', 'completed', 120, '2026-10-26T09:30:00.000Z'
      );
    `);

    // 5. Seed cached attachment
    const attachmentsDir = path.join(tempBaseDir, 'attachments_cache');
    await fsPromises.mkdir(attachmentsDir, { recursive: true });
    const sampleAttachmentPath = path.join(attachmentsDir, 'att1_sample.jpg');
    await fsPromises.writeFile(sampleAttachmentPath, Buffer.from('fake-jpeg-binary-content-12345'));

    await dbManager.run(`
      INSERT INTO attachments (
        id, message_id, room_id, file_name, mime_type, file_size, local_cache_path, download_status, created_at
      ) VALUES (
        'att1', 'msg_1', 'room_bob', 'sample.jpg', 'image/jpeg', 28, ?, 'completed', '2026-10-26T10:01:00.000Z'
      );
    `, [sampleAttachmentPath]);
  });

  afterEach(async () => {
    try {
      if (dbManager && dbManager.isOpen) {
        await dbManager.close().catch(() => {});
      }
      await fsPromises.rm(tempBaseDir, { recursive: true, force: true }).catch(() => {});
    } catch {}
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Backup Creation & Manifest Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('Backup Creation & Integrity', () => {
    test('1. Creates a valid, consistent backup archive without attachments', async () => {
      const result = await backupService.createBackup({ includeAttachments: false });

      assert.equal(result.ok, true);
      assert.ok(fs.existsSync(result.filePath), 'Backup file was created on disk');
      assert.ok(result.sizeBytes > 0, 'Backup file has non-zero size');
      assert.equal(result.stats.conversationsCount, 1);
      assert.equal(result.stats.messagesCount, 2);
      assert.equal(result.stats.reactionsCount, 1);
      assert.equal(result.stats.attachmentsCount, 0);

      // Verify the archive contains manifest and database snapshot
      const gzipped = await fsPromises.readFile(result.filePath);
      const tar = zlib.gunzipSync(gzipped);
      const entries = unpackTarArchive(tar);

      assert.ok(entries.has('manifest.json'), 'Archive contains manifest.json');
      assert.ok(entries.has('ollachat.db'), 'Archive contains ollachat.db');
      assert.equal(entries.has('attachments/att1_sample.jpg'), false, 'Excluded attachments are not in archive');

      const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
      assert.equal(manifest.backupVersion, BACKUP_FORMAT_VERSION);
      assert.equal(manifest.format, BACKUP_MAGIC_FORMAT);
      assert.equal(manifest.account.userId, testUserId);
      assert.equal(manifest.account.sessionToken, undefined, 'Session token must NEVER be exported in manifest');
      assert.ok(manifest.database.sha256, 'Manifest contains SHA-256 for database');
    });

    test('2. Creates a valid backup archive with attachments included', async () => {
      const result = await backupService.createBackup({ includeAttachments: true });

      assert.equal(result.ok, true);
      assert.equal(result.stats.attachmentsCount, 1);

      const gzipped = await fsPromises.readFile(result.filePath);
      const tar = zlib.gunzipSync(gzipped);
      const entries = unpackTarArchive(tar);

      assert.ok(entries.has('manifest.json'));
      assert.ok(entries.has('ollachat.db'));
      assert.ok(entries.has('attachments/att1_sample.jpg'), 'Attachment file was bundled into archive');

      const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
      assert.equal(manifest.includeAttachments, true);
      assert.equal(manifest.attachments.length, 1);
      assert.equal(manifest.attachments[0].filename, 'sample.jpg');
      assert.equal(manifest.attachments[0].sizeBytes, 30);
    });

    test('3. Live database remains open, untouched, and usable after backup creation (WAL consistency)', async () => {
      // Write uncommitted/pending WAL data right before backup
      await dbManager.run(`
        INSERT INTO messages (
          id, room_id, sender_id, client_message_id, kind, body_json, status, created_at, local_received_at
        ) VALUES (
          'msg_wal_test', 'room_bob', 'usr_bob', 'cli_wal', 'text', '{"text":"WAL message"}', 'delivered',
          '2026-10-26T10:05:00.000Z', '2026-10-26T10:05:01.000Z'
        );
      `);

      const result = await backupService.createBackup({ includeAttachments: false });
      assert.equal(result.ok, true);

      // Verify live database connection is still open and responsive
      assert.equal(dbManager.isOpen, true, 'Live database must remain open');
      const count = await dbManager.get('SELECT COUNT(*) as c FROM messages;');
      assert.equal(count.c, 3, 'Live database retains all messages including WAL message');

      // Verify the backup snapshot also captured the WAL message
      const val = await backupService.validateBackup(result.filePath);
      assert.equal(val.stats.messagesCount, 3, 'Backup snapshot captured WAL message via VACUUM INTO');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Preflight Validation & Security Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('Preflight Validation & Rejection Invariants', () => {
    test('4. Successfully validates a healthy backup without modifying live database', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      const countBefore = await dbManager.get('SELECT COUNT(*) as c FROM messages;');

      const valResult = await backupService.validateBackup(backupResult.filePath);
      assert.equal(valResult.ok, true);
      assert.equal(valResult.stats.account.userId, testUserId);
      assert.equal(valResult.stats.messagesCount, 2);

      const countAfter = await dbManager.get('SELECT COUNT(*) as c FROM messages;');
      assert.equal(countBefore.c, countAfter.c, 'Preflight validation must never modify live database');
    });

    test('5. Rejects corrupted archive that fails decompression', async () => {
      const badFilePath = path.join(tempBaseDir, 'corrupt.ollabackup');
      await fsPromises.writeFile(badFilePath, Buffer.from('not-a-valid-gzip-stream'));

      await assert.rejects(
        () => backupService.validateBackup(badFilePath),
        /Corrupted or invalid backup archive/
      );
    });

    test('6. Rejects archive missing manifest.json', async () => {
      // Craft archive without manifest.json
      const entries = new Map();
      entries.set('ollachat.db', Buffer.from('fake-db'));
      const badArchive = packTarGzArchive(entries);

      const badPath = path.join(tempBaseDir, 'no_manifest.ollabackup');
      await fsPromises.writeFile(badPath, badArchive);

      await assert.rejects(
        () => backupService.validateBackup(badPath),
        /"manifest\.json" is missing/
      );
    });

    test('7. Rejects archive with tampered database (checksum mismatch)', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      // Unpack, tamper with database content, and repack
      const gzipped = await fsPromises.readFile(backupResult.filePath);
      const tar = zlib.gunzipSync(gzipped);
      const entries = unpackTarArchive(tar);

      // Mutate database buffer slightly
      const dbBuf = entries.get('ollachat.db');
      dbBuf[100] = dbBuf[100] ^ 0xFF; // flip bits
      entries.set('ollachat.db', dbBuf);

      const tamperedArchive = packTarGzArchive(entries);
      const tamperedPath = path.join(tempBaseDir, 'tampered.ollabackup');
      await fsPromises.writeFile(tamperedPath, tamperedArchive);

      await assert.rejects(
        () => backupService.validateBackup(tamperedPath),
        /Database integrity check failed: Checksum does not match manifest/
      );
    });

    test('8. Rejects archive from a different user account', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      // Validate against a different expected user ID
      await assert.rejects(
        () => backupService.validateBackup(backupResult.filePath, 'usr_different_user'),
        /Account mismatch: This backup belongs to/
      );
    });

    test('9. Rejects future/unsupported backup format version', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      const gzipped = await fsPromises.readFile(backupResult.filePath);
      const tar = zlib.gunzipSync(gzipped);
      const entries = unpackTarArchive(tar);

      const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
      manifest.backupVersion = 999; // future version
      entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));

      const futureArchive = packTarGzArchive(entries);
      const futurePath = path.join(tempBaseDir, 'future_version.ollabackup');
      await fsPromises.writeFile(futurePath, futureArchive);

      await assert.rejects(
        () => backupService.validateBackup(futurePath),
        /Unsupported backup version \(999\)/
      );
    });

    test('10. Rejects archive with malicious path traversal entries', () => {
      assert.throws(
        () => validateTarEntryPath('../../../Windows/System32/evil.dll'),
        /illegal path traversal detected/
      );
      assert.throws(
        () => validateTarEntryPath('attachments/../../secret.txt'),
        /illegal path traversal detected/
      );
      assert.throws(
        () => validateTarEntryPath('attachments\\evil.exe'),
        /backslashes are not allowed/
      );
      assert.throws(
        () => validateTarEntryPath('/etc/passwd'),
        /absolute paths are not allowed/
      );
      assert.throws(
        () => validateTarEntryPath('C:/Windows/win.ini'),
        /absolute paths are not allowed/
      );
      assert.throws(
        () => validateTarEntryPath('unexpected_file.txt'),
        /not a recognized backup component/
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Restore Safety & Atomic Recovery
  // ═══════════════════════════════════════════════════════════════════
  describe('Restore Safety & Rollback', () => {
    test('11. Requires explicit confirmation before restoring', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      await assert.rejects(
        () => backupService.restoreBackup(backupResult.filePath, { confirmed: false }),
        /Explicit confirmation is required/
      );
    });

    test('12. Successfully restores chat database and verifies integrity', async () => {
      // 1. Create backup with original data
      const backupResult = await backupService.createBackup({ includeAttachments: true });

      // 2. Modify live database (e.g. delete messages or add new ones)
      await dbManager.run('DELETE FROM messages WHERE id = "msg_1";');
      await dbManager.run('DELETE FROM call_records;');
      const remainingMsgs = await dbManager.all('SELECT id FROM messages;');
      assert.equal(remainingMsgs.length, 1);

      // 3. Perform confirmed restore
      const restoreResult = await backupService.restoreBackup(backupResult.filePath, { confirmed: true });
      assert.equal(restoreResult.ok, true);
      assert.ok(restoreResult.restoredAt);

      // 4. Verify database is open, integrity is OK, and deleted records are fully restored
      assert.equal(dbManager.isOpen, true);
      const integrity = await dbManager.checkIntegrity();
      assert.equal(integrity.ok, true);

      const restoredMsgs = await dbManager.all('SELECT id, kind FROM messages ORDER BY id ASC;');
      assert.equal(restoredMsgs.length, 2);
      assert.equal(restoredMsgs[0].id, 'msg_1');
      assert.equal(restoredMsgs[1].id, 'msg_2');

      const restoredReactions = await dbManager.all('SELECT emoji FROM message_reactions;');
      assert.equal(restoredReactions.length, 1);
      assert.equal(restoredReactions[0].emoji, '❤️');

      const restoredCalls = await dbManager.all('SELECT id, status FROM call_records;');
      assert.equal(restoredCalls.length, 1);
      assert.equal(restoredCalls[0].id, 'call_1');

      const restoredConvs = await dbManager.all('SELECT room_id, is_pinned, is_favourite, draft_text FROM conversations;');
      assert.equal(restoredConvs.length, 1);
      assert.equal(restoredConvs[0].is_pinned, 1);
      assert.equal(restoredConvs[0].is_favourite, 1);
      assert.equal(restoredConvs[0].draft_text, 'Hey Bob, drafting...');
    });

    test('13. Creates a pre-restore safety snapshot before applying restore', async () => {
      const backupResult = await backupService.createBackup({ includeAttachments: false });

      await backupService.restoreBackup(backupResult.filePath, { confirmed: true });

      // Verify that a pre-restore snapshot was generated in the user's database directory
      const userDir = path.join(tempBaseDir, 'databases', 'users', testUserId, 'pre_restore_snapshots');
      assert.ok(fs.existsSync(userDir), 'Safety snapshots directory exists');
      const snapshotFiles = await fsPromises.readdir(userDir);
      assert.ok(snapshotFiles.length >= 1, 'At least one pre-restore safety snapshot exists');
      assert.ok(snapshotFiles[0].startsWith('ollachat_pre_restore_'));
    });

    test('14. Automatically rolls back to original database if restored file fails activation', async () => {
      // 1. Create a corrupt backup archive that contains a damaged SQLite database but valid manifest
      const backupResult = await backupService.createBackup({ includeAttachments: false });
      const gzipped = await fsPromises.readFile(backupResult.filePath);
      const tar = zlib.gunzipSync(gzipped);
      const entries = unpackTarArchive(tar);

      // Create a corrupted database file with bad page header that passes sha256 check
      const corruptDb = Buffer.alloc(4096);
      corruptDb.write('SQLite format 3\0', 0, 16, 'ascii'); // valid header prefix
      // rest is zero/corrupt
      const corruptSha = computeSha256(corruptDb);

      const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
      manifest.database.sha256 = corruptSha;

      entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
      entries.set('ollachat.db', corruptDb);

      const badArchive = packTarGzArchive(entries);
      const badPath = path.join(tempBaseDir, 'corrupt_db_snapshot.ollabackup');
      await fsPromises.writeFile(badPath, badArchive);

      // Current live messages count:
      const beforeCount = await dbManager.get('SELECT COUNT(*) as c FROM messages;');
      assert.equal(beforeCount.c, 2);

      // Attempt restore: should fail during preflight or activation and abort cleanly
      await assert.rejects(
        () => backupService.restoreBackup(badPath, { confirmed: true }),
        /Database integrity check failed|Failed to activate restored database/
      );

      // Verify live database is intact and still open
      assert.equal(dbManager.isOpen, true, 'Live database remains open after rollback');
      const afterCount = await dbManager.get('SELECT COUNT(*) as c FROM messages;');
      assert.equal(afterCount.c, 2, 'Live database was safely recovered to original state');
    });

    test('15. Prevents concurrent backup or restore operations', async () => {
      backupService._isOperationInProgress = true;

      await assert.rejects(
        () => backupService.createBackup(),
        /Another backup or restore operation is already in progress/
      );

      await assert.rejects(
        () => backupService.restoreBackup('any.ollabackup', { confirmed: true }),
        /Another backup or restore operation is already in progress/
      );

      backupService._isOperationInProgress = false;
    });
  });
});
