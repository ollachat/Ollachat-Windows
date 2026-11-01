import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService, normalizePhone } from '../src/storage/db/database-service.js';
import { ContactCacheService, CONTACT_TTL, normalizeContactRecord } from '../src/main/contact-cache-service.js';

describe('Priority 2: Contact Lookup & SQLite Cache System', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;
  let mockChatApi;
  let contactCacheService;
  let mockApiCalls = [];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-contact-cache-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
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

    mockApiCalls = [];
    mockChatApi = {
      lookupContacts: async (sessionToken, phones) => {
        mockApiCalls.push({ sessionToken, phones });
        // Return matching registered mock contacts
        const registeredDirectory = {
          '+15553334444': { user_id: 'usr_charlie', phone: '+15553334444', display_name: 'Charlie Brown' },
          '+15559998888': { user_id: 'usr_dave', phone: '+15559998888', display_name: 'Dave Smith' },
          '+15550001111': { user_id: 'usr_eve', phone: '+15550001111', display_name: 'Eve Online' }
        };

        const contacts = [];
        for (const p of phones) {
          const norm = normalizePhone(p);
          if (registeredDirectory[norm]) {
            contacts.push(registeredDirectory[norm]);
          }
        }
        return { contacts };
      }
    };

    contactCacheService = new ContactCacheService({
      databaseService: dbService,
      chatApi: mockChatApi,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService?.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. Schema Migration 3 & Seeding Verification
  // ═════════════════════════════════════════════════════════════════
  describe('Migration 3 & SQLite Schema', () => {
    test('applies migration 3 and creates contact_cache table with indices', async () => {
      await dbService._getAuthorizedUser();
      const version = await dbService.databaseManager.getCurrentSchemaVersion();
      assert.ok(version >= 3, `Expected version >= 3, got ${version}`);

      const table = await dbService.databaseManager.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_cache';"
      );
      assert.ok(table, 'contact_cache table must exist');

      const indices = await dbService.databaseManager.all(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contact_cache';"
      );
      const indexNames = indices.map((i) => i.name);
      assert.ok(indexNames.includes('idx_contact_cache_user_id'), 'idx_contact_cache_user_id must exist');
      assert.ok(indexNames.includes('idx_contact_cache_updated_at'), 'idx_contact_cache_updated_at must exist');
    });

    test('migration 3 auto-seeds contact_cache from existing direct conversations', async () => {
      const { MIGRATIONS } = await import('../src/storage/db/migrations.js');
      const v2Manager = new DatabaseManager(tmpDir, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] });
      await v2Manager.openUserDatabase('user_seed_test');

      // Create pre-existing direct chat conversation
      await v2Manager.run(
        `INSERT INTO conversations (room_id, room_name, peer_phone, peer_user_id, peer_display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        ['room_direct_bob', 'Bob Jones', '+15557778888', 'usr_bob_777', 'Bob Jones', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
      );
      await v2Manager.close();

      // Now open with full migrations (runs Migration 3 and 4)
      const v3Manager = new DatabaseManager(tmpDir, { migrations: MIGRATIONS });
      await v3Manager.openUserDatabase('user_seed_test');
      assert.ok((await v3Manager.getCurrentSchemaVersion()) >= 3);

      const seeded = await v3Manager.get('SELECT * FROM contact_cache WHERE phone = ?;', ['+15557778888']);
      assert.ok(seeded, 'Pre-existing direct contact must be seeded into contact_cache');
      assert.equal(seeded.user_id, 'usr_bob_777');
      assert.equal(seeded.display_name, 'Bob Jones');
      assert.equal(seeded.is_registered, 1);
      await v3Manager.close();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. Cache Miss, Hit, and Expiration Lifecycle
  // ════════════════════════════════════════════════════://
  describe('Cache-First Lookup Lifecycle & Expirations', () => {
    test('cache miss makes network request to OllaCore and persists positive match', async () => {
      const res = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(mockApiCalls.length, 1);
      assert.deepEqual(mockApiCalls[0].phones, ['+15553334444']);

      assert.equal(res.contacts.length, 1);
      const contact = res.contacts[0];
      assert.equal(contact.userId, 'usr_charlie');
      assert.equal(contact.user_id, 'usr_charlie');
      assert.equal(contact.phone, '+15553334444');
      assert.equal(contact.displayName, 'Charlie Brown');
      assert.equal(contact.isRegistered, true);
      assert.equal(contact.is_registered, true);

      // Verify row persisted into SQLite
      const cached = await dbService.getCachedContacts(['+15553334444']);
      assert.equal(cached.length, 1);
      assert.equal(cached[0].userId, 'usr_charlie');
      assert.equal(cached[0].isRegistered, true);
    });

    test('fresh cache hit returns immediately with zero network requests', async () => {
      // Prime the cache
      await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(mockApiCalls.length, 1);

      // Second lookup
      const res2 = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(mockApiCalls.length, 1, 'No additional network request should be made for fresh cache');
      assert.equal(res2.contacts.length, 1);
      assert.equal(res2.contacts[0].userId, 'usr_charlie');
      assert.equal(res2.contacts[0].displayName, 'Charlie Brown');
    });

    test('persists negative cache for unregistered numbers', async () => {
      const res = await contactCacheService.lookupContacts(['+15550009999']); // Not in directory
      assert.equal(mockApiCalls.length, 1);
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].phone, '+15550009999');
      assert.equal(res.contacts[0].userId, '');
      assert.equal(res.contacts[0].isRegistered, false);
      assert.equal(res.contacts[0].is_registered, false);

      // Check SQLite negative record
      const dbRows = await dbService.getCachedContacts(['+15550009999']);
      assert.equal(dbRows.length, 1);
      assert.equal(dbRows[0].isRegistered, false);
      assert.equal(dbRows[0].userId, '');

      // Subsequent lookup within 15 minutes uses negative cache without network request
      const res2 = await contactCacheService.lookupContacts(['+15550009999']);
      assert.equal(mockApiCalls.length, 1, 'Negative cache hit must not trigger network request');
      assert.equal(res2.contacts[0].isRegistered, false);
    });

    test('15-minute negative cache expiration causes re-query to OllaCore', async () => {
      // Manually insert an expired negative cache entry (16 minutes old)
      const sixteenMinsAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await dbService.saveCachedContacts([{
        phone: '+15550009999',
        userId: null,
        displayName: null,
        isRegistered: false,
        cachedAt: sixteenMinsAgo,
        updatedAt: sixteenMinsAgo
      }]);

      await contactCacheService.lookupContacts(['+15550009999']);
      assert.equal(mockApiCalls.length, 1, 'Expired negative cache must trigger network re-query');
    });

    test('24-hour fresh TTL serves cache without background refresh', async () => {
      // Insert a fresh positive record (2 hours old, well within 24h)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await dbService.saveCachedContacts([{
        phone: '+15553334444',
        userId: 'usr_charlie',
        displayName: 'Charlie Brown',
        isRegistered: true,
        cachedAt: twoHoursAgo,
        updatedAt: twoHoursAgo
      }]);

      const res = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(mockApiCalls.length, 0);
      assert.equal(res.contacts[0].userId, 'usr_charlie');
    });

    test('stale-while-revalidate (between 24h and 7d) returns cached record immediately and triggers background refresh', async () => {
      // Record is 48 hours old (stale)
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      await dbService.saveCachedContacts([{
        phone: '+15553334444',
        userId: 'usr_charlie',
        displayName: 'Old Charlie Name',
        isRegistered: true,
        cachedAt: fortyEightHoursAgo,
        updatedAt: fortyEightHoursAgo
      }]);

      const res = await contactCacheService.lookupContacts(['+15553334444']);
      // Immediate return of cached value
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].displayName, 'Old Charlie Name');

      // Wait a moment for fire-and-forget background refresh to execute
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(mockApiCalls.length, 1, 'Background refresh must have dispatched network call');

      // Verify SQLite was updated in background with fresh display name
      const updated = await dbService.getCachedContacts(['+15553334444']);
      assert.equal(updated[0].displayName, 'Charlie Brown');
    });

    test('expired record past 7-day boundary queries OllaCore', async () => {
      // Record is 8 days old
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await dbService.saveCachedContacts([{
        phone: '+15553334444',
        userId: 'usr_charlie',
        displayName: 'Very Old Name',
        isRegistered: true,
        cachedAt: eightDaysAgo,
        updatedAt: eightDaysAgo
      }]);

      const res = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(mockApiCalls.length, 1, 'Past 7 days boundary must query network');
      assert.equal(res.contacts[0].displayName, 'Charlie Brown');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Offline Resilience & Fallbacks
  // ═════════════════════════════════════════════════════════════════
  describe('Offline Behavior & Conversations Fallback', () => {
    test('offline lookup succeeds when contact exists in contact_cache', async () => {
      // Pre-populate cache
      await dbService.saveCachedContacts([{
        phone: '+15553334444',
        userId: 'usr_charlie',
        displayName: 'Charlie Offline',
        isRegistered: true,
        cachedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }]);

      // Make chatApi throw network error
      mockChatApi.lookupContacts = async () => {
        const err = new Error('fetch failed: network offline');
        err.code = 'ENOTFOUND';
        throw err;
      };

      const res = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].userId, 'usr_charlie');
      assert.equal(res.contacts[0].displayName, 'Charlie Offline');
      assert.equal(res.contacts[0].isRegistered, true);
    });

    test('offline lookup falls back to conversations table when missing from contact_cache', async () => {
      // Insert into conversations table as 1-on-1 peer
      await dbService.saveConversation({
        roomId: 'room_direct_offline_friend',
        kind: 'direct',
        peerPhone: '+15558887777',
        peerUserId: 'usr_offline_friend',
        peerDisplayName: 'Offline Friend'
      });

      // Chat API fails offline
      mockChatApi.lookupContacts = async () => {
        const err = new Error('network down');
        err.code = 'ECONNREFUSED';
        throw err;
      };

      const res = await contactCacheService.lookupContacts(['+15558887777']);
      assert.equal(res.contacts.length, 1);
      assert.equal(res.contacts[0].userId, 'usr_offline_friend');
      assert.equal(res.contacts[0].displayName, 'Offline Friend');
      assert.equal(res.contacts[0].isRegistered, true);

      // Verify it was saved to contact_cache for subsequent fast access
      const cached = await dbService.getCachedContacts(['+15558887777']);
      assert.equal(cached.length, 1);
      assert.equal(cached[0].userId, 'usr_offline_friend');
    });

    test('offline lookup throws clean offline error when contact is completely unknown locally', async () => {
      mockChatApi.lookupContacts = async () => {
        const err = new Error('fetch failed: disconnected');
        err.code = 'ENETUNREACH';
        throw err;
      };

      await assert.rejects(
        async () => await contactCacheService.lookupContacts(['+15559990000']),
        (err) => {
          assert.equal(err.code, 'OFFLINE_CACHE_MISS');
          assert.equal(err.httpStatus, 503);
          assert.ok(err.message.includes('Device is offline'));
          return true;
        }
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Normalization, Deduplication, and Concurrency
  // ═════════════════════════════════════════════════════════════════
  describe('Input Normalization & In-Flight Concurrency', () => {
    test('normalizes formatted phone numbers consistently', () => {
      assert.equal(normalizePhone('+1 (555) 333-4444'), '+15553334444');
      assert.equal(normalizePhone('  +1-555-333-4444  '), '+15553334444');
      assert.equal(normalizePhone('+1.555.333.4444'), '+15553334444');
      assert.equal(normalizePhone('555-333-4444'), '5553334444');
      assert.equal(normalizePhone(''), '');
      assert.equal(normalizePhone(null), '');
    });

    test('deduplicates duplicate phone numbers in input', async () => {
      const res = await contactCacheService.lookupContacts([
        '+1 (555) 333-4444',
        '+15553334444',
        '  +1-555-333-4444  '
      ]);

      assert.equal(mockApiCalls.length, 1);
      assert.deepEqual(mockApiCalls[0].phones, ['+15553334444']);
      assert.equal(res.contacts.length, 1);
    });

    test('deduplicates concurrent in-flight lookups for the same phone', async () => {
      let callCount = 0;
      mockChatApi.lookupContacts = async (_token, phones) => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20)); // simulated latency
        return {
          contacts: [{ user_id: 'usr_charlie', phone: phones[0], display_name: 'Charlie Brown' }]
        };
      };

      // Launch 3 simultaneous concurrent lookups for the same phone
      const [res1, res2, res3] = await Promise.all([
        contactCacheService.lookupContacts(['+15553334444']),
        contactCacheService.lookupContacts(['+15553334444']),
        contactCacheService.lookupContacts(['+1 (555) 333-4444'])
      ]);

      assert.equal(callCount, 1, 'Only 1 network request should be made across concurrent lookups');
      assert.equal(res1.contacts[0].userId, 'usr_charlie');
      assert.equal(res2.contacts[0].userId, 'usr_charlie');
      assert.equal(res3.contacts[0].userId, 'usr_charlie');
    });

    test('normalizes response fields for both camelCase and snake_case compatibility', () => {
      const raw = {
        user_id: 'usr_1',
        phone: '+15551234567',
        display_name: 'Test Name'
      };
      const norm = normalizeContactRecord(raw);

      assert.equal(norm.userId, 'usr_1');
      assert.equal(norm.user_id, 'usr_1');
      assert.equal(norm.displayName, 'Test Name');
      assert.equal(norm.display_name, 'Test Name');
      assert.equal(norm.isRegistered, true);
      assert.equal(norm.is_registered, true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. Data Reconciliation & Nickname Preservation
  // ═════════════════════════════════════════════════════════════════
  describe('Data Reconciliation & Nickname Preservation', () => {
    test('reconciles conversation peer display name when refreshed from directory', async () => {
      // 1. Existing conversation row
      await dbService.saveConversation({
        roomId: 'room_direct_dave',
        kind: 'direct',
        peerPhone: '+15559998888',
        peerUserId: 'usr_dave',
        peerDisplayName: 'Old Dave Name'
      });

      // 2. Refresh contact in background
      await contactCacheService.refreshContactsInBackground(['+15559998888'], 'session_token_alice_secret');

      // 3. Conversation table display name must be updated
      const conv = await dbService.databaseManager.get(
        'SELECT peer_display_name FROM conversations WHERE room_id = ?;',
        ['room_direct_dave']
      );
      assert.equal(conv.peer_display_name, 'Dave Smith');
    });

    test('preserves user-defined custom contact nicknames in app_metadata', async () => {
      // User set personal nickname for Dave
      await dbService.setMetadata({
        key: 'contact_nicknames',
        value: JSON.stringify({ usr_dave: 'My Dave Bro' })
      });

      // Background refresh updates Dave's directory name
      await contactCacheService.refreshContactsInBackground(['+15559998888'], 'session_token_alice_secret');

      // Check that custom nickname was NOT overwritten
      const meta = await dbService.getMetadata('contact_nicknames');
      const nicknames = JSON.parse(meta.value);
      assert.equal(nicknames.usr_dave, 'My Dave Bro', 'Custom nickname must be preserved intact');
    });

    test('notifies onContactUpdated listener when display name changes', async () => {
      let notifiedContact = null;
      contactCacheService.onContactUpdated = (c) => {
        notifiedContact = c;
      };

      // Prime with old name
      await dbService.saveCachedContacts([{
        phone: '+15559998888',
        userId: 'usr_dave',
        displayName: 'Old Name',
        isRegistered: true,
        cachedAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }]);

      await contactCacheService.refreshContactsInBackground(['+15559998888'], 'session_token_alice_secret');
      assert.ok(notifiedContact);
      assert.equal(notifiedContact.userId, 'usr_dave');
      assert.equal(notifiedContact.displayName, 'Dave Smith');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 6. Security, Isolation, & Maintenance
  // ═════════════════════════════════════════════════════════════════
  describe('Security, Multi-User Isolation & Maintenance', () => {
    test('never stores session or auth tokens in contact_cache table', async () => {
      await contactCacheService.lookupContacts(['+15553334444']);
      const row = await dbService.databaseManager.get(
        'SELECT * FROM contact_cache WHERE phone = ?;',
        ['+15553334444']
      );

      // Verify schema columns
      assert.strictEqual(row.token, undefined);
      assert.strictEqual(row.session_token, undefined);
      assert.strictEqual(row.auth_token, undefined);
      assert.strictEqual(row.secret, undefined);
    });

    test('multi-user database isolation keeps contact caches separate', async () => {
      // User Alice looks up Charlie
      await contactCacheService.lookupContacts(['+15553334444']);

      // Switch session to User Bob
      mockSessionStore.currentSession = {
        userId: 'test_user_bob',
        sessionToken: 'session_token_bob',
        phone: '+15557770000'
      };

      // Bob's database should NOT have Alice's cached contacts
      const bobCached = await dbService.getCachedContacts(['+15553334444']);
      assert.equal(bobCached.length, 0, "Bob's database must not contain Alice's contact cache");
    });

    test('safely handles special and invalid characters without SQL injection', async () => {
      const maliciousPhone = "'+OR+1=1;--";
      const res = await contactCacheService.lookupContacts([maliciousPhone]);
      assert.deepEqual(res.contacts, [], 'Invalid characters should normalize safely');

      // Valid query continues to work
      const cleanRes = await contactCacheService.lookupContacts(['+15553334444']);
      assert.equal(cleanRes.contacts.length, 1);
    });

    test('prunes stale contact cache records older than 30 days', async () => {
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

      await dbService.saveCachedContacts([
        { phone: '+15551111111', userId: 'u1', isRegistered: true, cachedAt: fortyDaysAgo, updatedAt: fortyDaysAgo },
        { phone: '+15552222222', userId: 'u2', isRegistered: true, cachedAt: tenDaysAgo, updatedAt: tenDaysAgo }
      ]);

      const pruneRes = await contactCacheService.pruneOldCache(CONTACT_TTL.MAX_AGE_MS);
      assert.equal(pruneRes.deleted, 1);

      const remaining = await dbService.getCachedContacts(['+15551111111', '+15552222222']);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].phone, '+15552222222');
    });

    test('background refresh failures are caught silently without throwing', async () => {
      mockChatApi.lookupContacts = async () => {
        throw new Error('Fatal socket crash');
      };

      // Should not throw
      await assert.doesNotReject(async () => {
        await contactCacheService.refreshContactsInBackground(['+15553334444'], 'token');
      });
    });
  });
});
