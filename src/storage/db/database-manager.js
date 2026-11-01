import sqlite3Pkg from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations.js';

const sqlite3 = sqlite3Pkg.verbose();

/**
 * Validates and sanitizes a user ID for safe filesystem path usage.
 * Only allows alphanumeric characters, underscores, and hyphens.
 * @param {string} userId
 * @returns {string}
 */
export function sanitizeUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('DatabaseManager: Invalid userId provided.');
  }
  const trimmed = userId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`DatabaseManager: Unsafe userId "${userId}". Only alphanumeric, hyphen, and underscore characters are allowed.`);
  }
  return trimmed;
}

/**
 * DatabaseManager provides an isolated, persistent SQLite database layer
 * for the Windows OllaChat client adhering to per-user partitioning, WAL mode,
 * foreign key integrity, and atomic migrations.
 */
export class DatabaseManager {
  /**
   * @param {string} storageDir Base storage directory (typically Electron app.getPath('userData'))
   * @param {object} [options]
   * @param {Array} [options.migrations] Custom migrations array (defaults to MIGRATIONS)
   * @param {number} [options.busyTimeout] Timeout in ms for busy locks (default 5000)
   */
  constructor(storageDir, options = {}) {
    if (!storageDir || typeof storageDir !== 'string') {
      throw new Error('DatabaseManager requires a valid storage directory path');
    }
    this.storageDir = storageDir;
    this.migrations = options.migrations || MIGRATIONS;
    this.busyTimeout = options.busyTimeout ?? 5000;

    /** @type {import('sqlite3').Database | null} */
    this.db = null;
    /** @type {string | null} */
    this.currentUserId = null;
    /** @type {string | null} */
    this.currentDbPath = null;
    /** @type {boolean} */
    this.isOpen = false;
    /** @type {boolean} */
    this._isInitializing = false;
    /** @type {Promise<void> | null} */
    this._openingPromise = null;
    /** @type {string | null} */
    this._openingUserId = null;
    /** @type {Promise<void>} */
    this._txQueue = Promise.resolve();
  }

  /**
   * Opens or creates an isolated SQLite database for the specified user and runs pending migrations.
   * If a database is already open for another user, it is closed first.
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async openUserDatabase(userId) {
    const sanitized = sanitizeUserId(userId);

    // If another operation is currently opening for this exact user, wait for it to complete migrations
    if (this._openingPromise && this._openingUserId === sanitized) {
      return await this._openingPromise;
    }

    // If already fully open for this exact user, return immediately
    if (this.isOpen && this.currentUserId === sanitized) {
      return;
    }

    this._openingUserId = sanitized;
    this._openingPromise = this._doOpenUserDatabase(sanitized);
    try {
      await this._openingPromise;
    } finally {
      this._openingPromise = null;
      this._openingUserId = null;
    }
  }

  async _doOpenUserDatabase(sanitized) {
    // Close any previously opened database
    if (this.isOpen) {
      await this.close();
    }

    const userDbDir = path.join(this.storageDir, 'databases', 'users', sanitized);
    if (!existsSync(userDbDir)) {
      mkdirSync(userDbDir, { recursive: true });
    }

    const dbPath = path.join(userDbDir, 'ollachat.db');

    // Open connection
    const db = await new Promise((resolve, reject) => {
      const instance = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          reject(new Error(`DatabaseManager: Failed to open database at ${dbPath}: ${err.message}`));
        } else {
          resolve(instance);
        }
      });
    });

    this.db = db;
    this.currentUserId = sanitized;
    this.currentDbPath = dbPath;
    this._txQueue = Promise.resolve();
    this._isInitializing = true;

    try {
      // Configure mandatory PRAGMAs
      await this._configurePragmas();

      // Check database integrity
      await this.checkIntegrity();

      // Run migrations
      await this._runMigrations();

      this._isInitializing = false;
      this.isOpen = true;
    } catch (err) {
      this._isInitializing = false;
      this.isOpen = false;
      await this.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Configures SQLite PRAGMAs:
   * - journal_mode = WAL (Write-Ahead Logging for high concurrency and crash resilience)
   * - synchronous = NORMAL (Optimal balance of safety and write performance with WAL)
   * - foreign_keys = ON (Enforces relational constraints and cascading deletes)
   * - busy_timeout = 5000 (Prevents SQLITE_BUSY crashes under Windows file locks)
   * @private
   */
  async _configurePragmas() {
    await this.run(`PRAGMA busy_timeout = ${this.busyTimeout};`);

    const walRow = await this.get('PRAGMA journal_mode = WAL;');
    const mode = walRow ? Object.values(walRow)[0] : '';
    if (String(mode).toLowerCase() !== 'wal') {
      throw new Error(`DatabaseManager: Failed to set WAL mode, got: ${mode}`);
    }

    await this.run('PRAGMA synchronous = NORMAL;');
    await this.run('PRAGMA foreign_keys = ON;');
  }

  /**
   * Performs a database integrity check.
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async checkIntegrity() {
    this._ensureOpen();
    const row = await this.get('PRAGMA integrity_check;');
    const result = row ? Object.values(row)[0] : 'unknown';
    if (result !== 'ok') {
      throw new Error(`DatabaseManager: Database integrity check failed: ${result}`);
    }
    return { ok: true, message: result };
  }

  /**
   * Ensures the migrations table exists and executes all unapplied migrations in order.
   * @private
   */
  async _runMigrations() {
    this._ensureOpen();

    await this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = await this.all('SELECT version FROM schema_migrations ORDER BY version ASC;');
    const appliedVersions = new Set(appliedRows.map((r) => r.version));

    // Sort migrations strictly by version ascending
    const sorted = [...this.migrations].sort((a, b) => a.version - b.version);

    for (const migration of sorted) {
      if (!appliedVersions.has(migration.version)) {
        await this.transaction(async () => {
          await migration.up(this);
          await this.run(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
            [migration.version, new Date().toISOString()]
          );
        });
      }
    }
  }

  /**
   * Returns the current schema version applied to this database.
   * @returns {Promise<number>}
   */
  async getCurrentSchemaVersion() {
    this._ensureOpen();
    const row = await this.get('SELECT MAX(version) AS current_version FROM schema_migrations;');
    return row && row.current_version ? row.current_version : 0;
  }

  /**
   * Executes a SQL query with no returned rows (INSERT, UPDATE, DELETE).
   * @param {string} sql
   * @param {Array} [params]
   * @returns {Promise<{ changes: number, lastID: number }>}
   */
  run(sql, params = []) {
    this._ensureOpen();
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ changes: this.changes, lastID: this.lastID });
        }
      });
    });
  }

  /**
   * Executes a SQL query returning at most one row.
   * @param {string} sql
   * @param {Array} [params]
   * @returns {Promise<object | undefined>}
   */
  get(sql, params = []) {
    this._ensureOpen();
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  /**
   * Executes a SQL query returning all matching rows.
   * @param {string} sql
   * @param {Array} [params]
   * @returns {Promise<Array<object>>}
   */
  all(sql, params = []) {
    this._ensureOpen();
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Executes multiple SQL statements separated by semicolons.
   * @param {string} sql
   * @returns {Promise<void>}
   */
  exec(sql) {
    this._ensureOpen();
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Executes an asynchronous callback within an atomic transaction.
   * Serializes concurrent transactions on this connection via an async queue so
   * that BEGIN/COMMIT/ROLLBACK blocks never overlap or collide, and recovers cleanly
   * if a callback throws or rolls back without stalling subsequent queued operations.
   * @template T
   * @param {() => Promise<T>} callback
   * @returns {Promise<T>}
   */
  async transaction(callback) {
    this._ensureOpen();

    const previousTx = this._txQueue;
    let releaseLock;
    this._txQueue = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousTx;
    } catch (_) {
      // Prior transaction failure must not poison this transaction
    }

    try {
      this._ensureOpen();
      await this.run('BEGIN TRANSACTION;');
      let result;
      try {
        result = await callback();
        await this.run('COMMIT;');
        return result;
      } catch (err) {
        try {
          await this.run('ROLLBACK;');
        } catch (_) {
          // Suppress rollback error if already rolled back
        }
        throw err;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Closes the active database connection.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.isOpen || !this.db) {
      this.isOpen = false;
      this.db = null;
      this.currentUserId = null;
      this.currentDbPath = null;
      this._txQueue = Promise.resolve();
      return;
    }

    try {
      await this._txQueue;
    } catch (_) {}

    // Flush Write-Ahead Log pages into main database before closing
    try {
      await new Promise((resolve) => {
        this.db.run('PRAGMA wal_checkpoint(TRUNCATE);', () => resolve());
      });
    } catch (_) {}

    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        this.isOpen = false;
        this.db = null;
        this.currentUserId = null;
        this.currentDbPath = null;
        this._txQueue = Promise.resolve();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Returns the current active user ID.
   * @returns {string | null}
   */
  getCurrentUserId() {
    return this.currentUserId;
  }

  /**
   * Returns the file path of the currently open database.
   * @returns {string | null}
   */
  getDatabasePath() {
    return this.currentDbPath;
  }

  /**
   * Checks whether the database is currently open.
   * @private
   */
  _ensureOpen() {
    if ((!this.isOpen && !this._isInitializing) || !this.db) {
      throw new Error('DatabaseManager: No user database is currently open. Call openUserDatabase(userId) first.');
    }
  }
}
