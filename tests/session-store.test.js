import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore, DEFAULT_SESSION } from '../src/storage/session-store.js';
import {
  generateEphemeralDeviceId,
  getOrCreatePersistentDeviceId,
  getDeviceId,
  _resetCachedDeviceIdForTesting
} from '../src/storage/device-id.js';

describe('SessionStore and Device ID Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create isolated temporary directory for test instance
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacore-session-test-'));
    _resetCachedDeviceIdForTesting();
  });

  afterEach(async () => {
    _resetCachedDeviceIdForTesting();
    // Clean up temporary test directory
    if (tempDir && fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('1. Default session state matches expected initial shape', async () => {
    const store = new SessionStore(tempDir);
    const session = await store.load();

    assert.deepEqual(session, {
      sessionToken: null,
      userId: null,
      phone: null,
      displayName: null,
      about: null,
      avatarUrl: null,
      onboardingDone: false
    });
    assert.deepEqual(store.getSession(), DEFAULT_SESSION);
  });

  test('2. saveSession() persists credentials while preserving onboardingDone', async () => {
    const store = new SessionStore(tempDir);
    await store.load();

    const saved = await store.saveSession({
      sessionToken: 'test_token_123',
      userId: 'user_abc',
      phone: '+15550001111',
      displayName: 'Alice'
    });

    assert.equal(saved.sessionToken, 'test_token_123');
    assert.equal(saved.userId, 'user_abc');
    assert.equal(saved.phone, '+15550001111');
    assert.equal(saved.displayName, 'Alice');
    assert.equal(saved.about, null);
    assert.equal(saved.avatarUrl, null);
    assert.equal(saved.onboardingDone, false);

    // Verify on disk
    const rawDisk = JSON.parse(await fs.readFile(path.join(tempDir, 'ollacore_session.json'), 'utf8'));
    assert.equal(rawDisk.sessionToken, 'test_token_123');
    assert.equal(rawDisk.userId, 'user_abc');
  });

  test('3. load() retrieves previously persisted session', async () => {
    const store1 = new SessionStore(tempDir);
    await store1.saveSession({
      sessionToken: 'persistent_token_456',
      userId: 'user_456',
      phone: '+15550002222',
      displayName: 'Bob'
    });

    // Create a new instance pointing to same directory
    const store2 = new SessionStore(tempDir);
    const loaded = await store2.load();

    assert.equal(loaded.sessionToken, 'persistent_token_456');
    assert.equal(loaded.userId, 'user_456');
    assert.equal(loaded.phone, '+15550002222');
    assert.equal(loaded.displayName, 'Bob');
  });

  test('4. updateProfile() updates only supplied profile fields', async () => {
    const store = new SessionStore(tempDir);
    await store.saveSession({
      sessionToken: 'token_xyz',
      userId: 'user_xyz',
      phone: '+15550003333',
      displayName: 'Charlie'
    });

    await store.updateProfile({
      about: 'Available on OllaChat',
      avatarUrl: 'https://example.com/avatar.png'
    });

    const session = store.getSession();
    assert.equal(session.displayName, 'Charlie', 'displayName must not be overwritten if omitted');
    assert.equal(session.about, 'Available on OllaChat');
    assert.equal(session.avatarUrl, 'https://example.com/avatar.png');
    assert.equal(session.sessionToken, 'token_xyz', 'token must remain intact');
  });

  test('5. setOnboardingDone() updates only onboardingDone', async () => {
    const store = new SessionStore(tempDir);
    await store.load();

    assert.equal(store.getSession().onboardingDone, false);
    await store.setOnboardingDone(true);
    assert.equal(store.getSession().onboardingDone, true);

    // Verify persistence
    const reloadedStore = new SessionStore(tempDir);
    const reloaded = await reloadedStore.load();
    assert.equal(reloaded.onboardingDone, true);
  });

  test('6. clear() strictly preserves onboardingDone (Android parity)', async () => {
    const store = new SessionStore(tempDir);
    await store.setOnboardingDone(true);
    await store.saveSession({
      sessionToken: 'auth_token',
      userId: 'user_1',
      phone: '+15550001111',
      displayName: 'Dave'
    });

    assert.equal(store.getSession().onboardingDone, true);
    assert.equal(store.getSession().sessionToken, 'auth_token');

    const cleared = await store.clear();
    assert.equal(cleared.onboardingDone, true, 'onboardingDone must be preserved across logout/clear');
  });

  test('7. clear() removes session identity and token fields', async () => {
    const store = new SessionStore(tempDir);
    await store.saveSession({
      sessionToken: 'secret_token',
      userId: 'user_99',
      phone: '+15550009999',
      displayName: 'Eve',
      about: 'Busy',
      avatarUrl: 'https://example.com/eve.png'
    });

    const cleared = await store.clear();
    assert.equal(cleared.sessionToken, null);
    assert.equal(cleared.userId, null);
    assert.equal(cleared.phone, null);
    assert.equal(cleared.displayName, null);
    assert.equal(cleared.about, null);
    assert.equal(cleared.avatarUrl, null);

    // Verify on disk
    const diskStore = new SessionStore(tempDir);
    const fromDisk = await diskStore.load();
    assert.equal(fromDisk.sessionToken, null);
    assert.equal(fromDisk.userId, null);
  });

  test('8. Missing session file is handled gracefully', async () => {
    const nonExistentDir = path.join(tempDir, 'nested', 'deep', 'dir');
    const store = new SessionStore(nonExistentDir);
    const session = await store.load();

    assert.deepEqual(session, DEFAULT_SESSION);
    assert.equal(store.getSession().sessionToken, null);
  });

  test('9. Corrupt/invalid session file is handled safely without crashing', async () => {
    const sessionFile = path.join(tempDir, 'ollacore_session.json');
    // Write corrupt, truncated JSON
    await fs.writeFile(sessionFile, '{ "sessionToken": "corrupt_data", invalid_json', 'utf8');

    const store = new SessionStore(tempDir);
    const session = await store.load();

    // Must safely fall back to default session
    assert.deepEqual(session, DEFAULT_SESSION);
  });

  test('10. Ephemeral device ID format starts with "windows-" and returns unique values', () => {
    const id1 = generateEphemeralDeviceId();
    const id2 = generateEphemeralDeviceId();

    assert.ok(id1.startsWith('windows-'), 'Device ID must start with "windows-"');
    assert.ok(id2.startsWith('windows-'), 'Device ID must start with "windows-"');
    assert.notEqual(id1, id2, 'Each ephemeral ID must be unique');
  });

  test('11. Persistent device ID generates "windows-<uuid>" and writes to ollacore_device.json', () => {
    const devId = getOrCreatePersistentDeviceId(tempDir);
    assert.ok(devId.startsWith('windows-'), 'Device ID must start with "windows-"');
    const uuidPart = devId.slice('windows-'.length);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRegex.test(uuidPart), `UUID part must be valid UUID: ${uuidPart}`);

    // Verify on disk
    const filePath = path.join(tempDir, 'ollacore_device.json');
    assert.ok(fsSync.existsSync(filePath), 'ollacore_device.json must exist');
    const parsed = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    assert.equal(parsed.deviceId, devId);
    assert.ok(parsed.createdAt, 'Must record createdAt timestamp');
  });

  test('12. Persistent device ID is preserved and reloaded across restarts', () => {
    const devId1 = getOrCreatePersistentDeviceId(tempDir);
    _resetCachedDeviceIdForTesting();

    // Re-initialize from same directory (simulating app restart)
    const devId2 = getOrCreatePersistentDeviceId(tempDir);
    assert.equal(devId2, devId1, 'Device ID must remain stable across application restarts');
    assert.equal(getDeviceId(), devId1, 'Synchronous getter must return cached persistent ID');
  });

  test('13. Persistent device ID survives SessionStore clear() (logout)', async () => {
    const store = new SessionStore(tempDir);
    await store.saveSession({
      sessionToken: 'session_active_123',
      userId: 'user_active'
    });

    const persistentId = getOrCreatePersistentDeviceId(tempDir);

    // Logout
    await store.clear();
    assert.equal(store.getSession().sessionToken, null);

    // Confirm device file is untouched
    const filePath = path.join(tempDir, 'ollacore_device.json');
    assert.ok(fsSync.existsSync(filePath), 'ollacore_device.json must survive sessionStore.clear()');
    const parsed = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    assert.equal(parsed.deviceId, persistentId);
    assert.equal(getDeviceId(), persistentId);
  });

  test('14. Corrupted device file regenerates a new persistent ID safely', async () => {
    const filePath = path.join(tempDir, 'ollacore_device.json');
    await fs.writeFile(filePath, 'corrupted JSON string { missing brace', 'utf8');

    _resetCachedDeviceIdForTesting();
    const devId = getOrCreatePersistentDeviceId(tempDir);
    assert.ok(devId.startsWith('windows-'));
    assert.equal(getDeviceId(), devId);

    // File must have been rewritten with valid content
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(parsed.deviceId, devId);
  });
});
