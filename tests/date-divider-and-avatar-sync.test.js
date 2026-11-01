import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupMessagesByDay, formatDayDivider } from '../src/renderer/chat-shell-state.js';
import { OllacoreApi, normalizeUserProfile } from '../src/api/ollacore-api.js';
import { ChatApi, normalizeInboxItem, normalizeGroupMember } from '../src/api/chat-api.js';
import { SessionStore } from '../src/storage/session-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Bug 1: Date Divider Deduplication and Non-Stacking UI Tests', () => {
  const fixedNow = new Date('2026-10-24T12:00:00Z');

  test('1. Strictly one date divider is generated per calendar date boundary', () => {
    const messages = [
      { id: 'm1', createdAt: '2026-10-22T08:00:00Z', body: { text: 'Day 1 morning' } },
      { id: 'm2', createdAt: '2026-10-22T14:00:00Z', body: { text: 'Day 1 afternoon' } },
      { id: 'm3', createdAt: '2026-10-23T09:00:00Z', body: { text: 'Day 2 morning' } },
      { id: 'm4', createdAt: '2026-10-23T11:00:00Z', body: { text: 'Day 2 late morning' } },
      { id: 'm5', createdAt: '2026-10-24T10:00:00Z', body: { text: 'Today' } }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 3, 'Should produce exactly 3 groups for 3 distinct dates');
    assert.equal(groups[0].messages.length, 2, '2 messages on Day 1');
    assert.equal(groups[1].messages.length, 2, '2 messages on Day 2');
    assert.equal(groups[2].messages.length, 1, '1 message on Today');

    const dateKeys = groups.map(g => g.dateKey);
    const uniqueKeys = new Set(dateKeys);
    assert.equal(uniqueKeys.size, groups.length, 'No duplicate dateKey entries allowed');
  });

  test('2. Disordered or fragmented messages coalesce into single date groups without duplicate dividers', () => {
    // Simulated out-of-order or intermingled messages
    const messages = [
      { id: 'm1', createdAt: '2026-10-23T10:00:00Z', body: { text: 'Day 2 msg 1' } },
      { id: 'm2', createdAt: '2026-10-22T08:00:00Z', body: { text: 'Day 1 msg 1' } },
      { id: 'm3', createdAt: '2026-10-23T12:00:00Z', body: { text: 'Day 2 msg 2' } },
      { id: 'm4', createdAt: '2026-10-22T14:00:00Z', body: { text: 'Day 1 msg 2' } }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 2, 'Should coalesce into exactly 2 day groups');
    assert.equal(groups[0].messages.length, 2, 'Day 1 has both messages coalesced');
    assert.equal(groups[1].messages.length, 2, 'Day 2 has both messages coalesced');
  });

  test('3. CSS removes position: sticky to prevent divider pill border/background stacking during scroll', () => {
    const cssPath = path.join(__dirname, '../src/renderer/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // Extract .day-divider rule block
    const dividerMatch = css.match(/\.day-divider\s*\{([^}]+)\}/);
    assert.ok(dividerMatch, 'CSS must define .day-divider');
    const body = dividerMatch[1];

    assert.ok(!body.includes('position: sticky'), '.day-divider must NOT use position: sticky');
    assert.ok(body.includes('position: relative'), '.day-divider should use position: relative');
  });

  test('4. Date divider pill uses a single background, border, and readable typography', () => {
    const cssPath = path.join(__dirname, '../src/renderer/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    const pillMatch = css.match(/\.day-divider-pill\s*\{([^}]+)\}/);
    assert.ok(pillMatch, 'CSS must define .day-divider-pill');
    const pillBody = pillMatch[1];

    assert.ok(pillBody.includes('border-radius: var(--radius-full)'), 'Pill shape border radius');
    assert.ok(pillBody.includes('border: 1px solid'), 'Single 1px solid border');
    assert.ok(pillBody.includes('background-color: rgba('), 'Semi-transparent background');
  });
});

describe('Bug 2: Profile Picture Synchronization and Directory Avatar Contract Tests', () => {
  const fakeSessionToken = 'test-session-jwt-token-xyz';
  const fakeUserId = 'a8f85b84-4bfa-4edc-aff9-fca087d7c047';
  const fakeVersion = '2026-10-24T19:31:15.678897Z';

  test('1. OllacoreApi.initAvatarUpload sends correct POST to /directory/me/avatar/init', async () => {
    let capturedUrl = null;
    let capturedMethod = null;
    let capturedBody = null;
    let capturedHeaders = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        upload_id: 'upload-uuid-1234',
        upload_url: 'https://storage.ollacore.com/avatars/put-url',
        expires_at: '2026-10-24T20:30:00Z',
        max_bytes: 10485760
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const api = new OllacoreApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });
    const res = await api.initAvatarUpload(fakeSessionToken, { mime: 'image/png', byteSize: 5000 });

    assert.equal(capturedUrl, 'https://api.ollacore.com/v1/directory/me/avatar/init');
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedHeaders['Authorization'], `Bearer ${fakeSessionToken}`);
    assert.equal(capturedBody.declared_mime, 'image/png');
    assert.equal(capturedBody.byte_size, 5000);
    assert.equal(res.upload_id, 'upload-uuid-1234');
    assert.equal(res.upload_url, 'https://storage.ollacore.com/avatars/put-url');
  });

  test('2. OllacoreApi.completeAvatarUpload sends POST to /directory/me/avatar/complete and normalizes profile with avatarVersion', async () => {
    let capturedUrl = null;
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        id: fakeUserId,
        phone: '+15550002222',
        display_name: 'Malavika Rajesh',
        about: 'Coding',
        avatar_version: fakeVersion
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const api = new OllacoreApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });
    const profile = await api.completeAvatarUpload(fakeSessionToken, 'upload-uuid-1234');

    assert.equal(capturedUrl, 'https://api.ollacore.com/v1/directory/me/avatar/complete');
    assert.equal(capturedBody.upload_id, 'upload-uuid-1234');
    assert.equal(profile.userId, fakeUserId);
    assert.equal(profile.avatarVersion, fakeVersion);
    assert.ok(profile.avatarUrl.includes(encodeURIComponent(fakeVersion)), 'Avatar URL includes version parameter for cache-busting');
    assert.ok(profile.avatarUrl.includes(`/directory/users/${fakeUserId}/avatar?v=`), 'Avatar URL points to user avatar route');
  });

  test('3. OllacoreApi.deleteAvatar sends DELETE to /directory/me/avatar', async () => {
    let capturedMethod = null;

    const mockFetch = async (url, opts) => {
      capturedMethod = opts.method;
      return new Response(JSON.stringify({
        id: fakeUserId,
        phone: '+15550002222',
        display_name: 'Malavika Rajesh',
        about: 'Coding',
        avatar_version: null
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const api = new OllacoreApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });
    const profile = await api.deleteAvatar(fakeSessionToken);

    assert.equal(capturedMethod, 'DELETE');
    assert.equal(profile.avatarVersion, null);
    assert.equal(profile.avatarUrl, null);
  });

  test('4. OllacoreApi.updateProfile does NOT send avatar_url to PATCH /directory/me (avoids backend 400 rejection)', async () => {
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        id: fakeUserId,
        display_name: 'Updated Name',
        about: 'Updated About',
        avatar_version: fakeVersion
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const api = new OllacoreApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });
    await api.updateProfile(fakeSessionToken, {
      displayName: 'Updated Name',
      about: 'Updated About',
      avatarUrl: 'https://example.com/ignored-avatar.jpg'
    });

    assert.ok(capturedBody.display_name, 'Includes display_name');
    assert.ok(capturedBody.about, 'Includes about');
    assert.equal(capturedBody.avatar_url, undefined, 'avatar_url must NOT be sent to PATCH /directory/me');
  });

  test('5. normalizeInboxItem extracts peer avatar_version and constructs versioned avatar URL for other users', () => {
    const rawDirectItem = {
      room_id: 'room-dm-1',
      kind: 'direct',
      peer: {
        user_id: 'alice-uuid-999',
        display_name: 'Alice Nakamura',
        phone: '+15550001111',
        avatar_version: '2026-10-24T18:00:00Z'
      }
    };

    const normalized = normalizeInboxItem(rawDirectItem, 'https://api.ollacore.com/v1');
    assert.equal(normalized.peer.avatarVersion, '2026-10-24T18:00:00Z');
    assert.equal(
      normalized.peer.avatarUrl,
      'https://api.ollacore.com/v1/directory/users/alice-uuid-999/avatar?v=2026-10-24T18%3A00%3A00Z'
    );
    assert.equal(normalized.avatarUrl, normalized.peer.avatarUrl, 'Conversation avatarUrl reflects direct peer avatar');
  });

  test('6. normalizeInboxItem with null avatar_version results in null avatarUrl (fallback to initials)', () => {
    const rawDirectItem = {
      room_id: 'room-dm-2',
      kind: 'direct',
      peer: {
        user_id: 'bob-uuid-888',
        display_name: 'Bob Jones',
        avatar_version: null
      }
    };

    const normalized = normalizeInboxItem(rawDirectItem, 'https://api.ollacore.com/v1');
    assert.equal(normalized.peer.avatarVersion, null);
    assert.equal(normalized.peer.avatarUrl, null);
    assert.equal(normalized.avatarUrl, null);
  });

  test('7. normalizeGroupMember retains avatar_version and generates member avatar URL', () => {
    const rawMember = {
      user_id: 'carol-uuid-777',
      display_name: 'Carol Danvers',
      role: 'member',
      avatar_version: '2026-10-24T19:00:00Z'
    };

    const member = normalizeGroupMember(rawMember, 'https://api.ollacore.com/v1');
    assert.equal(member.avatarVersion, '2026-10-24T19:00:00Z');
    assert.equal(
      member.avatarUrl,
      'https://api.ollacore.com/v1/directory/users/carol-uuid-777/avatar?v=2026-10-24T19%3A00%3A00Z'
    );
  });

  test('8. SessionStore persists and updates avatarVersion across restarts', async () => {
    const tmpDir = path.join(__dirname, `../scratch/session-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const store = new SessionStore(tmpDir);
      await store.saveSession({
        sessionToken: fakeSessionToken,
        userId: fakeUserId,
        phone: '+15550002222',
        displayName: 'Malavika',
        avatarUrl: 'https://api.ollacore.com/v1/directory/users/' + fakeUserId + '/avatar?v=' + fakeVersion,
        avatarVersion: fakeVersion
      });

      const session1 = store.getSession();
      assert.equal(session1.avatarVersion, fakeVersion);

      // Simulate app restart by loading new store instance from same directory
      const store2 = new SessionStore(tmpDir);
      await store2.load();
      const session2 = store2.getSession();
      assert.equal(session2.avatarVersion, fakeVersion);
      assert.equal(session2.avatarUrl, session1.avatarUrl);

      // Update avatar version
      const newVersion = '2026-10-25T01:00:00Z';
      await store2.updateProfile({
        avatarVersion: newVersion,
        avatarUrl: 'https://api.ollacore.com/v1/directory/users/' + fakeUserId + '/avatar?v=' + newVersion
      });

      const session3 = store2.getSession();
      assert.equal(session3.avatarVersion, newVersion);
      assert.equal(session3.displayName, 'Malavika', 'Existing fields preserved');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('9. Updating avatarVersion updates avatarUrl query parameter to bust browser cache', () => {
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1' });
    const urlV1 = api.getAvatarUrl(fakeUserId, 'version-1');
    const urlV2 = api.getAvatarUrl(fakeUserId, 'version-2');

    assert.notEqual(urlV1, urlV2, 'URLs must differ between avatar versions');
    assert.ok(urlV1.includes('v=version-1'));
    assert.ok(urlV2.includes('v=version-2'));
  });
});
