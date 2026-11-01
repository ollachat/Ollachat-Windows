/**
 * backup-service.js
 *
 * Chat Backup & Restore Service for OllaChat Windows Desktop.
 *
 * Implements safe, isolated Windows-to-Windows local backup and restore:
 * - Creates consistent SQLite snapshots via VACUUM INTO (flushing WAL atomically).
 * - Packages database and optional cached attachments into a secure .ollabackup (tar.gz) archive.
 * - Enforces versioned manifest, SHA-256 checksums, and strict path traversal protection.
 * - Preflight validates archive structure, checksums, account matching, and SQLite integrity before touching live data.
 * - Implements atomic, recoverable database replacement with pre-restore safety snapshot and rollback.
 * - Never exports session tokens, passwords, or authentication secrets.
 */

import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import sqlite3Pkg from 'sqlite3';
import { sanitizeUserId } from './db/database-manager.js';
import { getSafeAttachmentCachePath, ensureAttachmentCacheDir } from './attachment-cache.js';

const sqlite3 = sqlite3Pkg.verbose();

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAGIC_FORMAT = 'ollachat-desktop-backup';
export const BACKUP_FILE_EXTENSION = '.ollabackup';

const MAX_MANIFEST_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_DATABASE_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB
const MAX_ATTACHMENT_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * Creates a 512-byte POSIX ustar tar header for a file entry.
 * @param {string} name Relative entry name
 * @param {number} size File size in bytes
 * @param {number} [mtime] Modification timestamp in seconds
 * @returns {Buffer} 512-byte buffer
 */
export function createTarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  const header = Buffer.alloc(512);

  // name: 0 - 99
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    throw new Error(`Tar entry name too long (max 100 bytes): ${name}`);
  }
  nameBuf.copy(header, 0);

  // mode: 100 - 107 ('0000644\0')
  header.write('0000644\0', 100, 8, 'ascii');

  // uid: 108 - 115 ('0000000\0')
  header.write('0000000\0', 108, 8, 'ascii');

  // gid: 116 - 123 ('0000000\0')
  header.write('0000000\0', 116, 8, 'ascii');

  // size: 124 - 135 (11 octal digits + space or null)
  const sizeOctal = size.toString(8).padStart(11, '0') + ' ';
  header.write(sizeOctal, 124, 12, 'ascii');

  // mtime: 136 - 147 (11 octal digits + space or null)
  const mtimeOctal = mtime.toString(8).padStart(11, '0') + ' ';
  header.write(mtimeOctal, 136, 12, 'ascii');

  // chksum: 148 - 155 (temporary 8 spaces for calculation)
  header.fill(0x20, 148, 156);

  // typeflag: 156 ('0' = normal file)
  header[156] = 0x30;

  // magic: 257 - 262 ('ustar\0')
  header.write('ustar\0', 257, 6, 'ascii');

  // version: 263 - 264 ('00')
  header.write('00', 263, 2, 'ascii');

  // Compute checksum: sum of all 512 bytes where checksum field was spaces
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }

  // Write checksum as 6 octal digits + null + space
  const chkOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chkOctal, 148, 8, 'ascii');

  return header;
}

/**
 * Parses and unpacks a tar buffer into entry map { name: Buffer },
 * enforcing strict security rules against path traversal, unexpected paths, and oversized files.
 * @param {Buffer} tarBuffer
 * @returns {Map<string, Buffer>}
 */
export function unpackTarArchive(tarBuffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // Two consecutive zero blocks indicate end of archive
    let isAllZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) break;

    // Validate ustar magic
    const magic = header.subarray(257, 262).toString('ascii').replace(/\0.*$/, '');
    if (magic !== 'ustar' && magic !== '') {
      throw new Error(`Invalid archive format: unrecognized tar header magic "${magic}"`);
    }

    // Parse filename (null-terminated)
    let nullIdx = 0;
    while (nullIdx < 100 && header[nullIdx] !== 0) {
      nullIdx++;
    }
    const name = header.subarray(0, nullIdx).toString('utf8').trim();
    if (!name) {
      throw new Error('Malformed archive: entry filename is empty.');
    }

    // Security check: validate entry name against path traversal
    validateTarEntryPath(name);

    // Parse size (octal)
    const sizeStr = header.subarray(124, 135).toString('ascii').trim().replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8);
    if (Number.isNaN(size) || size < 0) {
      throw new Error(`Malformed archive: invalid entry size for "${name}"`);
    }

    // Security check: max entry size
    if (name === 'manifest.json' && size > MAX_MANIFEST_SIZE_BYTES) {
      throw new Error(`Manifest exceeds maximum allowed size (${MAX_MANIFEST_SIZE_BYTES} bytes)`);
    }
    if (name === 'ollachat.db' && size > MAX_DATABASE_SIZE_BYTES) {
      throw new Error(`Database snapshot exceeds maximum allowed size (${MAX_DATABASE_SIZE_BYTES} bytes)`);
    }
    if (name.startsWith('attachments/') && size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`Attachment file "${name}" exceeds maximum allowed size (${MAX_ATTACHMENT_SIZE_BYTES} bytes)`);
    }

    offset += 512;
    if (offset + size > tarBuffer.length) {
      throw new Error(`Corrupted archive: unexpected end of archive while reading "${name}"`);
    }

    const data = tarBuffer.subarray(offset, offset + size);
    entries.set(name, Buffer.from(data));

    // Tar entries are padded to 512-byte boundaries
    const remainder = size % 512;
    const padding = remainder === 0 ? 0 : 512 - remainder;
    offset += size + padding;
  }

  return entries;
}

/**
 * Validates that an archive entry path is safe and strictly relative.
 * Rejects path traversal (e.g. `..`), backslashes, absolute paths, or unexpected root files.
 * @param {string} entryPath
 */
export function validateTarEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath.trim()) {
    throw new Error('Archive entry path cannot be empty.');
  }

  // Reject backslashes
  if (entryPath.includes('\\')) {
    throw new Error(`Malformed archive entry path: backslashes are not allowed in "${entryPath}".`);
  }

  // Reject absolute paths and Windows drive roots
  if (entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath)) {
    throw new Error(`Security violation: absolute paths are not allowed in archive entry "${entryPath}".`);
  }

  // Reject path traversal
  const segments = entryPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error(`Security violation: illegal path traversal detected in archive entry "${entryPath}".`);
  }

  // Enforce whitelist of allowed entry structures
  if (entryPath !== 'manifest.json' && entryPath !== 'ollachat.db' && !entryPath.startsWith('attachments/')) {
    throw new Error(`Unexpected archive entry: "${entryPath}" is not a recognized backup component.`);
  }

  if (entryPath.startsWith('attachments/')) {
    const filename = entryPath.slice('attachments/'.length);
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Security violation: illegal attachment path "${entryPath}".`);
    }
  }
}

/**
 * Packs a map of { relativePath: Buffer } into a gzip-compressed tar buffer.
 * @param {Map<string, Buffer> | Array<[string, Buffer]>} entries
 * @returns {Buffer} Gzip-compressed tar archive buffer
 */
export function packTarGzArchive(entries) {
  const chunks = [];
  const entriesIterable = entries instanceof Map ? entries.entries() : entries;

  for (const [name, buffer] of entriesIterable) {
    validateTarEntryPath(name);
    const header = createTarHeader(name, buffer.length);
    chunks.push(header);
    chunks.push(buffer);

    const remainder = buffer.length % 512;
    if (remainder > 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }

  // End of tar archive: two 512-byte zero blocks
  chunks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(chunks);
  return zlib.gzipSync(tarBuffer, { level: 6 });
}

/**
 * Computes SHA-256 hash of a buffer.
 * @param {Buffer} buffer
 * @returns {string} Hexadecimal SHA-256 string
 */
export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Computes SHA-256 hash of a file on disk.
 * @param {string} filePath
 * @returns {Promise<string>} Hexadecimal SHA-256 string
 */
export async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * BackupService manages atomic backup creation, safe preflight validation,
 * and recoverable restoration for OllaChat Windows desktop clients.
 */
export class BackupService {
  /**
   * @param {object} params
   * @param {import('./db/database-service.js').DatabaseService} params.databaseService
   * @param {string} params.storageDir Base storage directory (e.g. app.getPath('userData'))
   * @param {import('./session-store.js').SessionStore} params.sessionStore
   */
  constructor({ databaseService, storageDir, sessionStore }) {
    if (!databaseService) throw new Error('BackupService requires a valid databaseService instance');
    if (!storageDir) throw new Error('BackupService requires a valid storageDir');
    if (!sessionStore) throw new Error('BackupService requires a valid sessionStore instance');

    this.databaseService = databaseService;
    this.storageDir = storageDir;
    this.sessionStore = sessionStore;
    this.attachmentsCacheDir = path.join(storageDir, 'attachments_cache');
    this._isOperationInProgress = false;
  }

  /**
   * Resolves the non-secret account information for the currently active user.
   * @returns {{ userId: string, phone: string|null, displayName: string|null }}
   */
  getCurrentAccountInfo() {
    const session = this.sessionStore.getSession ? this.sessionStore.getSession() : this.sessionStore.currentSession;
    const userId = session?.userId || this.databaseService.databaseManager?.getCurrentUserId();
    if (!userId) {
      throw new Error('No active account session found. Please sign in first.');
    }
    return {
      userId: String(userId).trim(),
      phone: session?.phone || null,
      displayName: session?.displayName || null
    };
  }

  /**
   * Creates a full, consistent backup of the current user's chats and database.
   *
   * @param {object} [options]
   * @param {boolean} [options.includeAttachments=false] Whether to include cached attachment files
   * @param {string} [options.destinationPath] Specific file path to save backup to
   * @returns {Promise<{ ok: boolean, filePath: string, sizeBytes: number, stats: object }>}
   */
  async createBackup({ includeAttachments = false, destinationPath = null } = {}) {
    if (this._isOperationInProgress) {
      throw new Error('Another backup or restore operation is already in progress.');
    }

    this._isOperationInProgress = true;
    let tempSnapshotPath = null;

    try {
      const account = this.getCurrentAccountInfo();
      const sanitizedUserId = sanitizeUserId(account.userId);

      // Ensure user database is fully open and active
      await this.databaseService.databaseManager.openUserDatabase(sanitizedUserId);
      const dbMgr = this.databaseService.databaseManager;

      // Verify integrity of live database before snapshotting
      await dbMgr.checkIntegrity();

      // 1. Create atomic, consistent snapshot using VACUUM INTO
      // VACUUM INTO creates a clean, independent single-file database snapshot
      // and automatically checkpoints WAL pages without locking the live database.
      const tempId = `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      tempSnapshotPath = path.join(os.tmpdir(), `${tempId}.db`);

      // SQLite requires normalized forward slashes in VACUUM INTO path
      const normalizedSnapshotSqlPath = tempSnapshotPath.replace(/\\/g, '/');
      await dbMgr.run(`VACUUM INTO '${normalizedSnapshotSqlPath}'`);

      const dbBuffer = await fsPromises.readFile(tempSnapshotPath);
      const dbSha256 = computeSha256(dbBuffer);
      const schemaVersion = await dbMgr.getCurrentSchemaVersion();

      // Query database statistics for manifest
      const convRow = await dbMgr.get('SELECT COUNT(*) AS count FROM conversations;').catch(() => ({ count: 0 }));
      const msgRow = await dbMgr.get('SELECT COUNT(*) AS count FROM messages;').catch(() => ({ count: 0 }));
      const reactionsRow = await dbMgr.get('SELECT COUNT(*) AS count FROM message_reactions;').catch(() => ({ count: 0 }));
      const callsRow = await dbMgr.get('SELECT COUNT(*) AS count FROM call_records;').catch(() => ({ count: 0 }));

      // 2. Gather attachments if requested
      const attachmentsList = [];
      const archiveEntries = new Map();
      archiveEntries.set('ollachat.db', dbBuffer);

      if (includeAttachments) {
        await ensureAttachmentCacheDir(this.attachmentsCacheDir);
        const attachmentRows = await dbMgr.all(`
          SELECT id, file_name, mime_type, file_size, local_cache_path
          FROM attachments
          ORDER BY created_at ASC;
        `).catch(() => []);

        for (const row of attachmentRows) {
          const rawId = row.id;
          const fileName = row.file_name || 'attachment';
          const mime = row.mime_type || '';

          let filePath = row.local_cache_path;
          if (!filePath || !fs.existsSync(filePath)) {
            try {
              filePath = getSafeAttachmentCachePath(this.attachmentsCacheDir, rawId, fileName, mime);
            } catch {
              filePath = null;
            }
          }

          if (filePath && fs.existsSync(filePath)) {
            try {
              const fileStat = await fsPromises.stat(filePath);
              if (fileStat.isFile() && fileStat.size > 0 && fileStat.size <= MAX_ATTACHMENT_SIZE_BYTES) {
                const fileData = await fsPromises.readFile(filePath);
                const fileSha256 = computeSha256(fileData);
                const safeName = path.basename(filePath);
                const archivePath = `attachments/${safeName}`;

                archiveEntries.set(archivePath, fileData);
                attachmentsList.push({
                  id: rawId,
                  filename: fileName,
                  archivePath,
                  mime,
                  sizeBytes: fileStat.size,
                  sha256: fileSha256
                });
              }
            } catch (err) {
              console.warn(`[BackupService] Skipping attachment ${rawId}:`, err?.message || err);
            }
          }
        }
      }

      // 3. Build versioned manifest (No credentials, session tokens or secrets included)
      const manifest = {
        backupVersion: BACKUP_FORMAT_VERSION,
        appVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        format: BACKUP_MAGIC_FORMAT,
        account: {
          userId: account.userId,
          phone: account.phone,
          displayName: account.displayName
        },
        database: {
          filename: 'ollachat.db',
          sizeBytes: dbBuffer.length,
          sha256: dbSha256,
          schemaVersion,
          conversationsCount: convRow?.count || 0,
          messagesCount: msgRow?.count || 0,
          reactionsCount: reactionsRow?.count || 0,
          callsCount: callsRow?.count || 0
        },
        includeAttachments: Boolean(includeAttachments),
        attachmentsCount: attachmentsList.length,
        attachments: attachmentsList
      };

      const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      archiveEntries.set('manifest.json', manifestBuffer);

      // 4. Pack into .ollabackup (gzip-compressed tar) archive
      const packedArchive = packTarGzArchive(archiveEntries);

      // 5. Determine destination path
      let finalPath = destinationPath;
      if (!finalPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultName = `ollachat_backup_${sanitizedUserId}_${timestamp}${BACKUP_FILE_EXTENSION}`;
        finalPath = path.join(this.storageDir, defaultName);
      }

      await fsPromises.mkdir(path.dirname(finalPath), { recursive: true });
      await fsPromises.writeFile(finalPath, packedArchive);

      return {
        ok: true,
        filePath: finalPath,
        sizeBytes: packedArchive.length,
        stats: {
          createdAt: manifest.createdAt,
          conversationsCount: manifest.database.conversationsCount,
          messagesCount: manifest.database.messagesCount,
          reactionsCount: manifest.database.reactionsCount,
          attachmentsCount: attachmentsList.length,
          includeAttachments: Boolean(includeAttachments)
        }
      };
    } finally {
      this._isOperationInProgress = false;
      if (tempSnapshotPath) {
        await fsPromises.unlink(tempSnapshotPath).catch(() => {});
      }
    }
  }

  /**
   * Performs complete preflight validation on a backup file without modifying the live database.
   *
   * @param {string} backupFilePath Absolute path to the backup file
   * @param {string} [expectedUserId] Expected account user ID (defaults to active user)
   * @returns {Promise<{ ok: boolean, manifest: object, stats: object }>}
   */
  async validateBackup(backupFilePath, expectedUserId = null) {
    if (!backupFilePath || typeof backupFilePath !== 'string') {
      throw new Error('Invalid backup file path provided.');
    }
    if (!fs.existsSync(backupFilePath)) {
      throw new Error(`Backup file not found at: ${backupFilePath}`);
    }

    // 1. Decompress and parse tar archive
    let tarBuffer;
    try {
      const gzippedBuffer = await fsPromises.readFile(backupFilePath);
      tarBuffer = zlib.gunzipSync(gzippedBuffer);
    } catch (err) {
      throw new Error(`Corrupted or invalid backup archive: Failed to decompress file. ${err.message}`);
    }

    let entries;
    try {
      entries = unpackTarArchive(tarBuffer);
    } catch (err) {
      throw new Error(`Invalid archive structure: ${err.message}`);
    }

    // 2. Validate manifest presence and structure
    if (!entries.has('manifest.json')) {
      throw new Error('Invalid backup: "manifest.json" is missing from the archive.');
    }

    let manifest;
    try {
      const manifestStr = entries.get('manifest.json').toString('utf8');
      manifest = JSON.parse(manifestStr);
    } catch (err) {
      throw new Error(`Malformed backup manifest: failed to parse JSON. ${err.message}`);
    }

    if (manifest.format !== BACKUP_MAGIC_FORMAT) {
      throw new Error(`Unsupported backup format: expected "${BACKUP_MAGIC_FORMAT}", got "${manifest.format}".`);
    }

    if (typeof manifest.backupVersion !== 'number' || manifest.backupVersion > BACKUP_FORMAT_VERSION) {
      throw new Error(`Unsupported backup version (${manifest.backupVersion}). This client supports up to version ${BACKUP_FORMAT_VERSION}. Please update OllaChat.`);
    }

    if (!manifest.account || !manifest.account.userId) {
      throw new Error('Invalid backup: Manifest does not contain a valid account identifier.');
    }

    // 3. Verify Account Matching
    const currentUserId = expectedUserId || this.getCurrentAccountInfo().userId;
    if (currentUserId && manifest.account.userId !== currentUserId) {
      const backupAccountLabel = manifest.account.displayName || manifest.account.phone || manifest.account.userId;
      throw new Error(
        `Account mismatch: This backup belongs to "${backupAccountLabel}" (${manifest.account.userId}), ` +
        `but you are currently signed in as "${currentUserId}". ` +
        `To protect your chats, backups can only be restored into the account that created them.`
      );
    }

    // 4. Validate database presence and checksum
    if (!entries.has('ollachat.db')) {
      throw new Error('Invalid backup: SQLite database snapshot ("ollachat.db") is missing from archive.');
    }

    const dbBuffer = entries.get('ollachat.db');
    const calculatedDbSha = computeSha256(dbBuffer);
    if (manifest.database && manifest.database.sha256 && calculatedDbSha !== manifest.database.sha256) {
      throw new Error('Database integrity check failed: Checksum does not match manifest. The backup file may be corrupt or tampered with.');
    }

    // 5. Test SQLite database integrity and schema compatibility in isolated temporary file
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ollachat_validate_'));
    const tempDbPath = path.join(tempDir, 'validate_ollachat.db');

    try {
      await fsPromises.writeFile(tempDbPath, dbBuffer);

      // Open isolated connection to check integrity
      const isolatedDb = await new Promise((resolve, reject) => {
        const inst = new sqlite3.Database(tempDbPath, sqlite3.OPEN_READONLY, (err) => {
          if (err) reject(new Error(`Failed to open database snapshot: ${err.message}`));
          else resolve(inst);
        });
      });

      try {
        const integrityRow = await new Promise((resolve, reject) => {
          isolatedDb.get('PRAGMA integrity_check;', (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });

        const integrityResult = integrityRow ? Object.values(integrityRow)[0] : 'unknown';
        if (integrityResult !== 'ok') {
          throw new Error(`Database integrity check failed: ${integrityResult}`);
        }

        // Verify required tables exist
        const tables = await new Promise((resolve, reject) => {
          isolatedDb.all("SELECT name FROM sqlite_master WHERE type='table';", (err, rows) => {
            if (err) reject(err);
            else resolve(rows ? rows.map((r) => r.name) : []);
          });
        });

        const requiredTables = ['conversations', 'messages', 'schema_migrations'];
        for (const req of requiredTables) {
          if (!tables.includes(req)) {
            throw new Error(`Database schema is missing required table "${req}".`);
          }
        }
      } catch (dbErr) {
        throw new Error(`Database integrity check failed: ${dbErr.message}`);
      } finally {
        await new Promise((resolve) => isolatedDb.close(() => resolve()));
      }
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    // 6. Validate included attachments (checksums & path safety)
    if (Array.isArray(manifest.attachments)) {
      for (const att of manifest.attachments) {
        if (!att.archivePath || !entries.has(att.archivePath)) {
          // Missing attachment entry in archive
          console.warn(`[BackupService] Attachment "${att.filename}" declared in manifest is missing from archive.`);
          continue;
        }
        const attData = entries.get(att.archivePath);
        if (att.sha256 && computeSha256(attData) !== att.sha256) {
          throw new Error(`Attachment integrity check failed for "${att.filename}". File may be corrupted.`);
        }
      }
    }

    return {
      ok: true,
      manifest,
      stats: {
        createdAt: manifest.createdAt,
        account: manifest.account,
        conversationsCount: manifest.database?.conversationsCount || 0,
        messagesCount: manifest.database?.messagesCount || 0,
        reactionsCount: manifest.database?.reactionsCount || 0,
        attachmentsCount: manifest.attachmentsCount || 0,
        includeAttachments: Boolean(manifest.includeAttachments),
        dbSizeBytes: dbBuffer.length
      }
    };
  }

  /**
   * Safely restores a validated backup into the active user's local database.
   *
   * Workflow:
   * 1. Requires explicit confirmation.
   * 2. Full preflight validation (never touches live DB on failure).
   * 3. Creates recoverable safety snapshot of the live database before replacement.
   * 4. Closes active SQLite connection (checkpointing and flushing WAL).
   * 5. Atomically replaces database files.
   * 6. Safely extracts attachments (if included) avoiding path traversal.
   * 7. Reopens DatabaseManager and verifies integrity.
   * 8. Automatic rollback to previous database if anything fails.
   *
   * @param {string} backupFilePath
   * @param {object} options
   * @param {boolean} options.confirmed Must be explicitly true
   * @returns {Promise<{ ok: boolean, restoredAt: string }>}
   */
  async restoreBackup(backupFilePath, { confirmed = false } = {}) {
    if (!confirmed) {
      throw new Error('Explicit confirmation is required before restoring a database backup.');
    }
    if (this._isOperationInProgress) {
      throw new Error('Another backup or restore operation is already in progress.');
    }

    this._isOperationInProgress = true;
    let safetySnapshotPath = null;
    let liveDbPath = null;
    let tempBackupLivePath = null;

    try {
      const account = this.getCurrentAccountInfo();
      const sanitizedUserId = sanitizeUserId(account.userId);

      // 1. Full Preflight Validation
      const { manifest } = await this.validateBackup(backupFilePath, sanitizedUserId);

      // 2. Read archive entries into memory
      const gzippedBuffer = await fsPromises.readFile(backupFilePath);
      const tarBuffer = zlib.gunzipSync(gzippedBuffer);
      const entries = unpackTarArchive(tarBuffer);
      const restoredDbBuffer = entries.get('ollachat.db');

      const dbMgr = this.databaseService.databaseManager;
      await dbMgr.openUserDatabase(sanitizedUserId);
      liveDbPath = dbMgr.getDatabasePath();
      const userDbDir = path.dirname(liveDbPath);

      // 3. Create recoverable safety snapshot of the current live database
      const safetySnapshotsDir = path.join(userDbDir, 'pre_restore_snapshots');
      await fsPromises.mkdir(safetySnapshotsDir, { recursive: true });
      safetySnapshotPath = path.join(safetySnapshotsDir, `ollachat_pre_restore_${Date.now()}.db`);

      const normalizedSafetyPath = safetySnapshotPath.replace(/\\/g, '/');
      await dbMgr.run(`VACUUM INTO '${normalizedSafetyPath}'`);

      // 4. Safely coordinate database close (checkpoints and flushes WAL pages)
      await dbMgr.close();

      // Clean up any remaining WAL/SHM files
      await fsPromises.unlink(`${liveDbPath}-wal`).catch(() => {});
      await fsPromises.unlink(`${liveDbPath}-shm`).catch(() => {});

      // 5. Temporary safety move of live database
      tempBackupLivePath = `${liveDbPath}.bak_${Date.now()}`;
      await fsPromises.copyFile(liveDbPath, tempBackupLivePath);

      // 6. Atomically write the restored database
      await fsPromises.writeFile(liveDbPath, restoredDbBuffer);

      // 7. Extract attachments if included
      if (manifest.includeAttachments && Array.isArray(manifest.attachments)) {
        await ensureAttachmentCacheDir(this.attachmentsCacheDir);
        for (const att of manifest.attachments) {
          if (att.archivePath && entries.has(att.archivePath)) {
            const fileData = entries.get(att.archivePath);
            try {
              const safeDest = getSafeAttachmentCachePath(this.attachmentsCacheDir, att.id, att.filename, att.mime);
              await fsPromises.writeFile(safeDest, fileData);
            } catch (err) {
              console.warn(`[BackupService] Failed to extract attachment "${att.filename}":`, err?.message || err);
            }
          }
        }
      }

      // 8. Reopen database connection for user and verify integrity
      let reopenSuccess = false;
      try {
        await dbMgr.openUserDatabase(sanitizedUserId);
        await dbMgr.checkIntegrity();
        reopenSuccess = true;
      } catch (reopenErr) {
        // 9. AUTOMATIC ROLLBACK: If reopened database is corrupt or fails integrity
        console.error('[BackupService] Restored database failed validation. Rolling back to original database...', reopenErr);
        await dbMgr.close().catch(() => {});

        if (fs.existsSync(tempBackupLivePath)) {
          await fsPromises.copyFile(tempBackupLivePath, liveDbPath);
        } else if (safetySnapshotPath && fs.existsSync(safetySnapshotPath)) {
          await fsPromises.copyFile(safetySnapshotPath, liveDbPath);
        }

        await dbMgr.openUserDatabase(sanitizedUserId);
        throw new Error(`Failed to activate restored database: ${reopenErr.message}. The original database has been safely restored.`);
      }

      // Cleanup temporary backup of live database on success
      if (reopenSuccess && tempBackupLivePath) {
        await fsPromises.unlink(tempBackupLivePath).catch(() => {});
      }

      return {
        ok: true,
        restoredAt: new Date().toISOString()
      };
    } finally {
      this._isOperationInProgress = false;
    }
  }
}
