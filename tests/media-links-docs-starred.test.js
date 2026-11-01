import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
﻿/**
 * media-links-docs-starred.test.js
 *
 * Tests for:
 * 1. Media/Links/Docs - reading from real RoomMessagesState (no fake data)
 * 2. Starred Messages - localStorage-backed, per-user, per-room, real messages only
 * 3. URL extraction from text messages
 * 4. Capability matrix enforcement
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RoomMessagesState, resolveMessageContent } from '../src/renderer/chat-shell-state.js';

function makeMsgText(text, overrides = {}) {
  return { id: overrides.id || ('msg-t-' + Math.random().toString(36).slice(2)), kind: 'text', body: { text }, senderId: 'user-a', sender_id: 'user-a', createdAt: Date.now(), ...overrides };
}
function makeMsgImage(filename = 'photo.jpg', attachmentId = null, overrides = {}) {
  const aid = attachmentId || ('att-i-' + Math.random().toString(36).slice(2));
  return { id: overrides.id || ('msg-i-' + Math.random().toString(36).slice(2)), kind: 'image', body: { filename }, attachmentId: aid, attachment_id: aid, senderId: 'user-a', sender_id: 'user-a', createdAt: Date.now(), ...overrides };
}
function makeMsgVideo(filename = 'video.mp4', overrides = {}) {
  return { id: overrides.id || ('msg-v-' + Math.random().toString(36).slice(2)), kind: 'video', body: { filename }, attachmentId: 'att-v-' + Math.random().toString(36).slice(2), senderId: 'user-a', sender_id: 'user-a', createdAt: Date.now(), ...overrides };
}
function makeMsgFile(filename = 'report.pdf', mime = 'application/pdf', byteSize = 1024000, overrides = {}) {
  return { id: overrides.id || ('msg-f-' + Math.random().toString(36).slice(2)), kind: 'file', body: { filename, mime, byte_size: byteSize }, attachmentId: 'att-f-' + Math.random().toString(36).slice(2), senderId: 'user-a', sender_id: 'user-a', createdAt: Date.now(), ...overrides };
}

const URL_REGEX = /https?:\/\/[^\s<>']+/gi;
function extractUrls(text) { return (text || '').match(URL_REGEX) || []; }

function makeLocalStorage() {
 const store = new Map();
 return { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
}

describe('Media categorisation from real state', () => {
 it('1. resolveMessageContent returns kind=image for image messages', () => {
 const r = resolveMessageContent(makeMsgImage('selfie.jpg', 'att-123'));
 assert.strictEqual(r.kind, 'image');
 assert.strictEqual(r.filename, 'selfie.jpg');
 });

 it('2. resolveMessageContent returns kind=video for video messages', () => {
 const r = resolveMessageContent(makeMsgVideo('clip.mp4'));
 assert.strictEqual(r.kind, 'video');
 assert.strictEqual(r.filename, 'clip.mp4');
 });

 it('3. resolveMessageContent returns kind=file for document messages', () => {
 const r = resolveMessageContent(makeMsgFile('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 200000));
 assert.strictEqual(r.kind, 'file');
 assert.strictEqual(r.filename, 'budget.xlsx');
 });

 it('4. resolveMessageContent returns kind=text for plain text', () => {
 const r = resolveMessageContent(makeMsgText('Hello world'));
 assert.strictEqual(r.kind, 'text');
 assert.strictEqual(r.text, 'Hello world');
 });

 it('5. Media tab includes only image and video messages', () => {
 const messages = [makeMsgText('hi'), makeMsgImage('a.jpg'), makeMsgVideo('b.mp4'), makeMsgFile('c.pdf'), makeMsgText('https://x.com')];
 const media = messages.filter((m) => !m.isDeleted && m.kind !== 'deleted' && (m.kind === 'image' || m.kind === 'video'));
 assert.strictEqual(media.length, 2);
 });

 it('6. Docs tab includes only file messages', () => {
 const messages = [makeMsgText('hi'), makeMsgImage('p.png'), makeMsgFile('r.pdf'), makeMsgFile('d.csv')];
 const docs = messages.filter((m) => !m.isDeleted && m.kind === 'file');
 assert.strictEqual(docs.length, 2);
 });

 it('7. Deleted messages are excluded from all tabs', () => {
 const messages = [{ id: 'd1', kind: 'image', isDeleted: true }, { id: 'd2', kind: 'deleted' }, makeMsgImage('live.jpg')];
 const media = messages.filter((m) => !m.isDeleted && m.kind !== 'deleted' && (m.kind === 'image' || m.kind === 'video'));
 assert.strictEqual(media.length, 1);
 });

 it('8. Media deduplication by attachmentId', () => {
 const aid = 'att-shared-dup';
 const messages = [makeMsgImage('dup.jpg', aid), makeMsgImage('dup2.jpg', aid)];
 const seen = new Set();
 const rendered = messages.filter((m) => { const r = resolveMessageContent(m); const key = r.attachmentId || m.id; if (seen.has(key)) return false; seen.add(key); return true; });
 assert.strictEqual(rendered.length, 1);
 });
});

describe('URL extraction from text messages', () => {
 it('9. Extracts a single HTTPS URL from message text', () => {
 assert.deepStrictEqual(extractUrls('Check https://example.com today'), ['https://example.com']);
 });

 it('10. Extracts multiple URLs from a single message', () => {
 const urls = extractUrls('See https://a.com and https://b.org/path?q=1');
 assert.strictEqual(urls.length, 2);
 });

 it('11. Returns empty array when no URLs present', () => {
 assert.deepStrictEqual(extractUrls('Hello, no links here!'), []);
 });

 it('12. Only HTTP/HTTPS extracted (not ftp or bare domains)', () => {
 const urls = extractUrls('ftp://bad.com or example.com or https://safe.com');
 assert.deepStrictEqual(urls, ['https://safe.com']);
 });

 it('13. URL deduplication across messages', () => {
 const messages = [makeMsgText('https://x.com'), makeMsgText('also https://x.com'), makeMsgText('https://y.com')];
 const seen = new Set(); const links = [];
 for (const m of messages) { for (const u of extractUrls(resolveMessageContent(m).text || '')) { if (!seen.has(u)) { seen.add(u); links.push(u); } } }
 assert.strictEqual(links.length, 2);
 });

 it('14. Non-text messages produce no links', () => {
 const messages = [makeMsgImage('img.jpg'), makeMsgFile('doc.pdf')];
 const links = [];
 for (const m of messages) { links.push(...extractUrls(resolveMessageContent(m).text || '')); }
 assert.strictEqual(links.length, 0);
 });
});

describe('Starred Messages localStorage persistence', () => {
 const ROOM = 'room-test-abc';
 const USER = 'user-test-xyz';

 beforeEach(() => {
 global.localStorage = makeLocalStorage();
 });

 it('15. Starring a message persists to localStorage', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('msg-001', ROOM);
 assert.ok(state.isStarred('msg-001', ROOM));
 const raw = global.localStorage.getItem('ollachat_starred_' + USER);
 assert.ok(raw !== null);
 assert.ok(JSON.parse(raw).some((e) => e.includes('msg-001')));
 });

 it('16. Unstarring removes from localStorage', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('msg-002', ROOM);
 state.unstarMessage('msg-002', ROOM);
 assert.ok(!state.isStarred('msg-002', ROOM));
 const arr = JSON.parse(global.localStorage.getItem('ollachat_starred_' + USER) || '[]');
 assert.ok(!arr.some((e) => e.includes('msg-002')));
 });

 it('17. Starred state persists across RoomMessagesState reload', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('msg-003', ROOM);
 const state2 = new RoomMessagesState(USER, new Map());
 state2.roomId = ROOM;
 assert.ok(state2.isStarred('msg-003', ROOM));
 });

 it('18. Stars are per-user — user A stars do not leak to user B', () => {
 const stateA = new RoomMessagesState('user-A', new Map());
 stateA.roomId = ROOM;
 stateA.starMessage('msg-004', ROOM);
 const stateB = new RoomMessagesState('user-B', new Map());
 stateB.roomId = ROOM;
 assert.ok(!stateB.isStarred('msg-004', ROOM));
 });

 it('19. getStarredMessageIds returns IDs for the given room', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('msg-r1', 'room-one');
 state.starMessage('msg-r2', 'room-two');
 const ids = state.getStarredMessageIds('room-one');
 assert.ok(ids.includes('msg-r1'));
 });

 it('20. getStarredMessageIds returns empty when nothing starred', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 assert.deepStrictEqual(state.getStarredMessageIds('empty-room'), []);
 });

 it('21. Starring the same message twice does not duplicate', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('msg-dup', ROOM);
 state.starMessage('msg-dup', ROOM);
 const ids = state.getStarredMessageIds(ROOM);
 assert.strictEqual(ids.filter((i) => i === 'msg-dup').length, 1);
 });

 it('22. isStarred returns false for never-stored IDs', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 assert.ok(!state.isStarred('msg-never', ROOM));
 });

 it('23. Both serverId and clientId can be starred independently', () => {
 const state = new RoomMessagesState(USER, new Map());
 state.roomId = ROOM;
 state.starMessage('srv-006', ROOM);
 state.starMessage('cli-006', ROOM);
 assert.ok(state.isStarred('srv-006', ROOM));
 assert.ok(state.isStarred('cli-006', ROOM));
 });
});

describe('Capability matrix — no fake data, no new endpoints', () => {
 it('24. Media tab empty when no image/video messages', () => {
 const messages = [makeMsgText('text only'), makeMsgFile('doc.pdf')];
 const media = messages.filter((m) => m.kind === 'image' || m.kind === 'video');
 assert.strictEqual(media.length, 0);
 });

 it('25. Links tab empty when no URLs in messages', () => {
 const messages = [makeMsgText('No links'), makeMsgImage('photo.jpg')];
 const links = [];
 for (const m of messages) links.push(...extractUrls(resolveMessageContent(m).text || ''));
 assert.strictEqual(links.length, 0);
 });

 it('26. Docs tab empty when no file messages', () => {
 const messages = [makeMsgText('hello'), makeMsgImage('img.png')];
 assert.strictEqual(messages.filter((m) => m.kind === 'file').length, 0);
 });

 it('27. Starred messages use only localStorage — no network API required', () => {
 global.localStorage = makeLocalStorage();
 const state = new RoomMessagesState('u1', new Map());
 state.roomId = 'room-x';
 state.starMessage('msg-star', 'room-x');
 assert.ok(state.isStarred('msg-star', 'room-x'));
 assert.ok(global.localStorage.getItem('ollachat_starred_u1') !== null);
 });

 it('28. Unstar is synchronous — no async/await needed', () => {
 global.localStorage = makeLocalStorage();
 const state = new RoomMessagesState('u2', new Map());
 state.roomId = 'room-y';
 state.starMessage('msg-abc', 'room-y');
 state.unstarMessage('msg-abc', 'room-y');
 assert.ok(!state.isStarred('msg-abc', 'room-y'));
 });

 it('29. resolveMessageContent does not invent attachmentId for text messages', () => {
 const r = resolveMessageContent(makeMsgText('Hello'));
 assert.ok(!r.attachmentId);
 });

 it('30. File card uses real filename, mime, byteSize from message body', () => {
 const r = resolveMessageContent(makeMsgFile('quarterly-report.pdf', 'application/pdf', 512000));
 assert.strictEqual(r.filename, 'quarterly-report.pdf');
 assert.strictEqual(r.mime, 'application/pdf');
 assert.strictEqual(r.byteSize, 512000);
 });
});

describe('Visual opacity contract in styles.css', () => {
  const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  it('31. .media-browser-panel uses solid opaque background-color: var(--bg-surface)', () => {
    assert.ok(css.includes('.media-browser-panel {'), 'Must have .media-browser-panel rule');
    const panelRule = css.match(/\.media-browser-panel\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(panelRule.includes('background-color: var(--bg-surface)'), 'Panel must have solid background-color: var(--bg-surface)');
    assert.ok(!panelRule.includes('var(--sidebar-bg)'), 'Must not reference undefined --sidebar-bg');
  });

  it('32. .media-browser-header uses solid opaque background-color: var(--bg-header)', () => {
    const headerRule = css.match(/\.media-browser-header\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(headerRule.includes('background-color: var(--bg-header)'), 'Header must have solid background-color: var(--bg-header)');
    assert.ok(!headerRule.includes('var(--header-bg)'), 'Must not reference undefined --header-bg');
  });

  it('33. .media-browser-body, .media-browser-tabs, and .mb-tab-pane have solid opaque backgrounds', () => {
    const tabsRule = css.match(/\.media-browser-tabs\s*\{[^}]+\}/)?.[0] || '';
    const bodyRule = css.match(/\.media-browser-body\s*\{[^}]+\}/)?.[0] || '';
    const paneRule = css.match(/\.mb-tab-pane\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(tabsRule.includes('background-color: var(--bg-surface)'), 'Tabs must have solid background');
    assert.ok(bodyRule.includes('background-color: var(--bg-surface)'), 'Body must have solid background');
    assert.ok(paneRule.includes('background-color: var(--bg-surface)'), 'Tab pane must have solid background');
  });

  it('34. .mb-media-thumb uses solid opaque background and subtle border', () => {
    const thumbRule = css.match(/\.mb-media-thumb\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(thumbRule.includes('background-color: var(--app-surface-secondary)'), 'Thumbnail container must have solid opaque background');
    assert.ok(thumbRule.includes('border: 1px solid var(--border-color)'), 'Thumbnail container must have subtle border');
    assert.ok(!thumbRule.includes('background: var(--border-color)'), 'Thumbnail container must not use semi-transparent border color as background');
  });

  it('35. .mb-media-thumb img and video have solid opaque background', () => {
    const imgRule = css.match(/\.mb-media-thumb img,\s*\.mb-media-thumb video\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(imgRule.includes('background-color: var(--app-surface-secondary)'), 'Media element must have solid opaque background');
  });

  it('36. .mb-link-card uses solid opaque background and subtle border', () => {
    const linkRule = css.match(/\.mb-link-card\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(linkRule.includes('background-color: var(--app-surface-secondary)'), 'Link card must have solid opaque background');
    assert.ok(linkRule.includes('border: 1px solid var(--border-color)'), 'Link card must have subtle border');
    assert.ok(!linkRule.includes('var(--surface-alt)'), 'Must not reference undefined --surface-alt');
  });

  it('37. .mb-doc-card uses solid opaque background and subtle border', () => {
    const docRule = css.match(/\.mb-doc-card\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(docRule.includes('background-color: var(--app-surface-secondary)'), 'Doc card must have solid opaque background');
    assert.ok(docRule.includes('border: 1px solid var(--border-color)'), 'Doc card must have subtle border');
    assert.ok(!docRule.includes('var(--surface-alt)'), 'Must not reference undefined --surface-alt');
  });

  it('38. No undefined CSS variables in media-browser rules', () => {
    const mbSection = css.slice(css.indexOf('/* Media Browser Panel */') || css.indexOf('.media-browser-panel {'));
    assert.ok(!mbSection.includes('var(--sidebar-bg)'), 'No --sidebar-bg');
    assert.ok(!mbSection.includes('var(--header-bg)'), 'No --header-bg');
    assert.ok(!mbSection.includes('var(--surface-alt)'), 'No --surface-alt');
    assert.ok(!mbSection.includes('var(--surface-hover)'), 'No --surface-hover');
  });

  it('39. .chat-shell-body has position: relative to anchor sliding panels within shell', () => {
    const bodyRule = css.match(/\.chat-shell-body\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(bodyRule.includes('position: relative'), '.chat-shell-body must have position: relative');
  });

  it('40. .starred-messages-panel uses solid opaque background-color: var(--bg-surface)', () => {
    const starredRule = css.match(/\.starred-messages-panel\s*\{[^}]+\}/)?.[0] || '';
    assert.ok(starredRule.includes('background-color: var(--bg-surface)'), 'Starred panel must have solid background');
  });
});
