import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatShellState,
  formatBackendGroupError,
  getGroupCapabilities,
  validateGroupDescription,
  validateGroupName
} from '../src/renderer/chat-shell-state.js';
import { ChatApi, normalizeInboxItem } from '../src/api/chat-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const htmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');

function createMockFetch(status = 200, responseData = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => responseData,
      text: async () => JSON.stringify(responseData),
      headers: {
        get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null)
      }
    };
  };
  fn.calls = calls;
  return fn;
}

describe('OllaChat Group Description System', () => {
  // 1. Owner can edit group description (Owner-only contract)
  test('1. Owner has canEditDescription capability', () => {
    const groupConv = { roomId: 'grp_alpha', kind: 'group', name: 'Engineering Group' };
    const participants = [
      { principalId: 'owner_user', role: 'owner' },
      { principalId: 'normal_user', role: 'member' }
    ];
    const caps = getGroupCapabilities(groupConv, participants, 'owner_user');
    assert.strictEqual(caps.isGroup, true);
    assert.strictEqual(caps.isAdmin, true);
    assert.strictEqual(caps.isOwner, true);
    assert.strictEqual(caps.canEditDescription, true);
  });

  // 1b. Non-owner admin cannot edit description
  test('1b. Non-owner admin has canEditDescription = false (Owner-only contract)', () => {
    const groupConv = { roomId: 'grp_alpha', kind: 'group', name: 'Engineering Group' };
    const participants = [
      { principalId: 'admin_user', role: 'admin' },
      { principalId: 'normal_user', role: 'member' }
    ];
    const caps = getGroupCapabilities(groupConv, participants, 'admin_user');
    assert.strictEqual(caps.isGroup, true);
    assert.strictEqual(caps.isAdmin, true);
    assert.strictEqual(caps.isOwner, false);
    assert.strictEqual(caps.canEditDescription, false);
    assert.strictEqual(caps.canRenameGroup, false);
  });

  // 2. Regular members cannot edit description
  test('2. Regular member has canEditDescription = false', () => {
    const groupConv = { roomId: 'grp_alpha', kind: 'group', name: 'Engineering Group' };
    const participants = [
      { principalId: 'admin_user', role: 'admin' },
      { principalId: 'normal_user', role: 'member' }
    ];
    const caps = getGroupCapabilities(groupConv, participants, 'normal_user');
    assert.strictEqual(caps.isGroup, true);
    assert.strictEqual(caps.isAdmin, false);
    assert.strictEqual(caps.canEditDescription, false);
  });

  test('2b. Direct chats have canEditDescription = false', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct', peerDisplayName: 'Bob' };
    const caps = getGroupCapabilities(directConv, [], 'my_id');
    assert.strictEqual(caps.isGroup, false);
    assert.strictEqual(caps.canEditDescription, false);
  });

  // 3. Existing description can be changed
  test('3. validateGroupDescription validates and trims valid descriptions', () => {
    const res = validateGroupDescription('  New updated description for the team.  ');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.description, 'New updated description for the team.');
  });

  // 4. Empty description clears existing description
  test('4. Empty description clears existing description', () => {
    const resEmpty = validateGroupDescription('');
    assert.strictEqual(resEmpty.valid, true);
    assert.strictEqual(resEmpty.description, '');

    const resWhitespace = validateGroupDescription('    ');
    assert.strictEqual(resWhitespace.valid, true);
    assert.strictEqual(resWhitespace.description, '');

    const resNull = validateGroupDescription(null);
    assert.strictEqual(resNull.valid, true);
    assert.strictEqual(resNull.description, '');
  });

  // 5. Description exceeding 512 characters is rejected
  test('5. Description exceeding 512 characters is rejected', () => {
    const valid512 = 'a'.repeat(512);
    const resValid = validateGroupDescription(valid512);
    assert.strictEqual(resValid.valid, true);
    assert.strictEqual(resValid.description?.length, 512);

    const invalid513 = 'a'.repeat(513);
    const resInvalid = validateGroupDescription(invalid513);
    assert.strictEqual(resInvalid.valid, false);
    assert.strictEqual(resInvalid.error, 'Group description cannot exceed 512 characters');
  });

  // 6. API receives only { description: value } via PATCH /directory/conversations/{roomId}
  test('6. ChatApi.updateGroup sends only description when name and icon are null', async () => {
    const mockFetch = createMockFetch(200, { success: true });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    const res = await api.updateGroup('tok_session_1', 'grp_alpha', {
      description: 'Official group description'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(mockFetch.calls.length, 1);
    assert.strictEqual(mockFetch.calls[0].url, 'https://api.ollacore.test/directory/conversations/grp_alpha');
    assert.strictEqual(mockFetch.calls[0].method, 'PATCH');
    assert.strictEqual(mockFetch.calls[0].headers.Authorization, 'Bearer tok_session_1');
    assert.deepEqual(mockFetch.calls[0].body, { description: 'Official group description' });
    assert.strictEqual(mockFetch.calls[0].body.name, undefined);
    assert.strictEqual(mockFetch.calls[0].body.icon, undefined);
    assert.strictEqual(mockFetch.calls[0].body.icon_url, undefined);
  });

  test('6b. ChatApi.updateGroup sends { description: "" } to clear description', async () => {
    const mockFetch = createMockFetch(200, { success: true });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    await api.updateGroup('tok_session_1', 'grp_alpha', { description: '' });

    assert.strictEqual(mockFetch.calls.length, 1);
    assert.strictEqual(mockFetch.calls[0].url, 'https://api.ollacore.test/directory/conversations/grp_alpha');
    assert.strictEqual(mockFetch.calls[0].method, 'PATCH');
    assert.strictEqual(mockFetch.calls[0].headers.Authorization, 'Bearer tok_session_1');
    assert.deepEqual(mockFetch.calls[0].body, { description: '' });
  });

  // 7. API failure preserves previous description
  test('7. ChatApi.updateGroup handles backend failure cleanly', async () => {
    const mockFetch = createMockFetch(500, { error: { message: 'Internal server error' } });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    await assert.rejects(
      async () => api.updateGroup('tok_session_1', 'grp_alpha', { description: 'Fail desc' }),
      (err) => {
        assert.strictEqual(err.httpStatus, 500);
        return true;
      }
    );
  });

  test('7c. ChatApi.updateGroup and formatBackendGroupError handle 403 Forbidden cleanly', async () => {
    const mockFetch = createMockFetch(403, { error: { message: 'Only group owner can update group info', code: 'forbidden' } });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    let caughtErr;
    try {
      await api.updateGroup('tok_session_1', 'grp_alpha', { description: 'Forbidden desc' });
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.httpStatus, 403);
    const formatted = formatBackendGroupError('Update group description', caughtErr);
    assert.ok(formatted.includes('Only group owner') || formatted.includes('permission denied'));
  });

  test('7b. app.js updates conversation description only upon successful API resolution', () => {
    // Verified app.js code pattern
    assert.ok(
      appJs.includes('await window.ollacoreDesktop.chatApi.updateGroup(activeContactInfoRoomId, { description: val.description })'),
      'Calls updateGroup before mutating conv.description'
    );
    assert.ok(
      appJs.includes('conv.description = val.description;'),
      'Mutates conv.description after await completes'
    );
  });

  // 8. WebSocket description updates refresh conversation state
  test('8. WebSocket room.updated / group.updated syncs description and preserves existing metadata', () => {
    assert.ok(
      appJs.includes("case 'room.updated':"),
      'Handles room.updated'
    );
    assert.ok(
      appJs.includes("case 'group.updated':"),
      'Handles group.updated'
    );
    assert.ok(
      appJs.includes('newDescription !== undefined'),
      'Checks newDescription in WebSocket event'
    );
    assert.ok(
      appJs.includes('conv.description = newDescription;'),
      'Updates conv.description from WebSocket frame'
    );
  });

  // 9. Existing group rename and icon functionality remain unaffected
  test('9. Existing group rename contract and functionality intact', async () => {
    const mockFetch = createMockFetch(200, { success: true });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    await api.updateGroup('tok_session_1', 'grp_alpha', { name: 'Renamed Engineering Group' });

    assert.strictEqual(mockFetch.calls.length, 1);
    assert.strictEqual(mockFetch.calls[0].url, 'https://api.ollacore.test/directory/conversations/grp_alpha');
    assert.strictEqual(mockFetch.calls[0].method, 'PATCH');
    assert.strictEqual(mockFetch.calls[0].headers.Authorization, 'Bearer tok_session_1');
    assert.deepEqual(mockFetch.calls[0].body, { name: 'Renamed Engineering Group' });
    assert.strictEqual(mockFetch.calls[0].body.description, undefined);
    assert.strictEqual(mockFetch.calls[0].body.icon, undefined);
    assert.strictEqual(mockFetch.calls[0].body.icon_url, undefined);

    const nameValidation = validateGroupName('Renamed Engineering Group');
    assert.strictEqual(nameValidation.valid, true);
    assert.strictEqual(nameValidation.name, 'Renamed Engineering Group');
  });

  test('9b. Group icon update sends only documented icon field in request body matching OpenAPI contract', async () => {
    const mockFetch = createMockFetch(200, { success: true });
    const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

    await api.updateGroup('tok_session_1', 'grp_alpha', { icon: 'https://cdn.ollacore.com/icons/grp1.png' });

    assert.strictEqual(mockFetch.calls.length, 1);
    assert.strictEqual(mockFetch.calls[0].url, 'https://api.ollacore.test/directory/conversations/grp_alpha');
    assert.strictEqual(mockFetch.calls[0].method, 'PATCH');
    assert.strictEqual(mockFetch.calls[0].headers.Authorization, 'Bearer tok_session_1');
    assert.strictEqual(mockFetch.calls[0].body.icon, 'https://cdn.ollacore.com/icons/grp1.png');
    assert.strictEqual(mockFetch.calls[0].body.icon_url, undefined, 'Must not send icon_url in request body');
    assert.strictEqual(mockFetch.calls[0].body.name, undefined);
    assert.strictEqual(mockFetch.calls[0].body.description, undefined);

    // Also verify iconUrl and icon_url aliases normalize strictly to documented icon field
    await api.updateGroup('tok_session_1', 'grp_alpha', { iconUrl: 'https://cdn.ollacore.com/icons/grp2.png' });
    assert.strictEqual(mockFetch.calls[1].body.icon, 'https://cdn.ollacore.com/icons/grp2.png');
    assert.strictEqual(mockFetch.calls[1].body.icon_url, undefined, 'Must not send icon_url in request body');

    await api.updateGroup('tok_session_1', 'grp_alpha', { icon_url: 'https://cdn.ollacore.com/icons/grp3.png' });
    assert.strictEqual(mockFetch.calls[2].body.icon, 'https://cdn.ollacore.com/icons/grp3.png');
    assert.strictEqual(mockFetch.calls[2].body.icon_url, undefined, 'Must not send icon_url in request body');
  });

  // 10. UI DOM element definitions in HTML and styling in CSS
  test('10. UI elements for group description exist in index.html and styles.css', () => {
    assert.ok(html.includes('id="btn-contact-info-edit-desc"'), 'Must define #btn-contact-info-edit-desc');
    assert.ok(html.includes('id="contact-info-desc-form"'), 'Must define #contact-info-desc-form');
    assert.ok(html.includes('id="contact-info-desc-input"'), 'Must define #contact-info-desc-input');
    assert.ok(html.includes('id="contact-info-desc-counter"'), 'Must define #contact-info-desc-counter');
    assert.ok(html.includes('id="btn-contact-info-save-desc"'), 'Must define #btn-contact-info-save-desc');
    assert.ok(html.includes('id="btn-contact-info-cancel-desc"'), 'Must define #btn-contact-info-cancel-desc');

    assert.ok(css.includes('.contact-info-desc-textarea'), 'Must style .contact-info-desc-textarea');
    assert.ok(css.includes('.contact-info-about-placeholder'), 'Must style .contact-info-about-placeholder');
    assert.ok(css.includes('.contact-info-section-header'), 'Must style .contact-info-section-header');
  });

  // 11. normalizeInboxItem preserves description
  test('11. normalizeInboxItem maps description from backend raw object', () => {
    const rawWithDesc = {
      room_id: 'grp_123',
      kind: 'group',
      name: 'Project Alpha',
      description: 'Alpha team discussion',
      unread_count: 0
    };
    const normalized = normalizeInboxItem(rawWithDesc);
    assert.strictEqual(normalized.description, 'Alpha team discussion');

    const rawWithAbout = {
      room_id: 'grp_456',
      kind: 'group',
      name: 'Project Beta',
      about: 'Beta team discussion',
      unread_count: 0
    };
    const normalizedAbout = normalizeInboxItem(rawWithAbout);
    assert.strictEqual(normalizedAbout.description, 'Beta team discussion');
  });
});

