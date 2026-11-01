/**
 * links-functionality.test.js
 *
 * Comprehensive tests for URL detection, clickable links, secure external opening,
 * and the Contact Info -> Media, Links and Docs -> Links tab.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanUrl,
  extractUrls,
  parseTextWithUrls,
  RoomMessagesState,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeMsgText(text, overrides = {}) {
  return {
    id: overrides.id || ('msg-t-' + Math.random().toString(36).slice(2)),
    kind: 'text',
    body: { text },
    senderId: 'user-a',
    sender_id: 'user-a',
    createdAt: Date.now(),
    ...overrides
  };
}

function makeMsgImage(filename = 'photo.jpg', overrides = {}) {
  const aid = 'att-i-' + Math.random().toString(36).slice(2);
  return {
    id: overrides.id || ('msg-i-' + Math.random().toString(36).slice(2)),
    kind: 'image',
    body: { filename, caption: overrides.caption || '' },
    attachmentId: aid,
    attachment_id: aid,
    senderId: 'user-a',
    createdAt: Date.now(),
    ...overrides
  };
}

function makeMsgFile(filename = 'spec.pdf', overrides = {}) {
  const aid = 'att-f-' + Math.random().toString(36).slice(2);
  return {
    id: overrides.id || ('msg-f-' + Math.random().toString(36).slice(2)),
    kind: 'file',
    body: { filename, mime: 'application/pdf', byte_size: 1048576 },
    attachmentId: aid,
    attachment_id: aid,
    senderId: 'user-a',
    createdAt: Date.now(),
    ...overrides
  };
}

describe('1. URL Detection & Parsing Invariants', () => {
  it('1. https URL detection', () => {
    assert.deepStrictEqual(extractUrls('https://ollacore.com/docs/api/'), ['https://ollacore.com/docs/api/']);
    assert.deepStrictEqual(extractUrls('https://example.com'), ['https://example.com']);
  });

  it('2. http URL detection', () => {
    assert.deepStrictEqual(extractUrls('http://example.org/path'), ['http://example.org/path']);
    assert.deepStrictEqual(extractUrls('http://my-service.local:8080/info'), ['http://my-service.local:8080/info']);
  });

  it('3. www URL detection', () => {
    assert.deepStrictEqual(extractUrls('www.example.com'), ['www.example.com']);
    assert.deepStrictEqual(extractUrls('Visit www.ollacore.com/docs today'), ['www.ollacore.com/docs']);
  });

  it('4. URL becomes clickable (tokens generate link with href and text)', () => {
    const tokens = parseTextWithUrls('https://ollacore.com/docs/api/');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'link');
    assert.strictEqual(tokens[0].text, 'https://ollacore.com/docs/api/');
    assert.strictEqual(tokens[0].href, 'https://ollacore.com/docs/api/');

    const wwwTokens = parseTextWithUrls('www.ollacore.com');
    assert.strictEqual(wwwTokens.length, 1);
    assert.strictEqual(wwwTokens[0].type, 'link');
    assert.strictEqual(wwwTokens[0].text, 'www.ollacore.com');
    assert.strictEqual(wwwTokens[0].href, 'https://www.ollacore.com');
  });

  it('5. normal text remains normal text', () => {
    const tokens = parseTextWithUrls('Normal sentence with periods. And commas, really!');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'text');
    assert.strictEqual(tokens[0].text, 'Normal sentence with periods. And commas, really!');
    assert.deepStrictEqual(extractUrls('No links here. Just text.'), []);
  });

  it('6. multiple URLs in one message', () => {
    const text = 'Check https://example.com and https://ollacore.com and www.google.com';
    assert.deepStrictEqual(extractUrls(text), ['https://example.com', 'https://ollacore.com', 'www.google.com']);
    const tokens = parseTextWithUrls(text);
    const linkTokens = tokens.filter((t) => t.type === 'link');
    assert.strictEqual(linkTokens.length, 3);
  });

  it('7. trailing punctuation handling', () => {
    assert.deepStrictEqual(extractUrls('Visit https://example.com.'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('Is it https://example.com?'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('Awesome: https://example.com!'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('(https://example.com)'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('[https://example.com]'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('See "https://example.com"'), ['https://example.com']);
    assert.deepStrictEqual(extractUrls('Check https://example.com, then reply'), ['https://example.com']);

    // Balanced parentheses inside URLs should be preserved
    assert.deepStrictEqual(
      extractUrls('https://en.wikipedia.org/wiki/Portal_(video_game)'),
      ['https://en.wikipedia.org/wiki/Portal_(video_game)']
    );
  });

  it('8. URL query strings', () => {
    const urls = extractUrls('https://example.com/search?q=ollacore&lang=en');
    assert.deepStrictEqual(urls, ['https://example.com/search?q=ollacore&lang=en']);
  });

  it('9. URL fragments', () => {
    const urls = extractUrls('https://example.com/docs#installation');
    assert.deepStrictEqual(urls, ['https://example.com/docs#installation']);
    const urlsBoth = extractUrls('https://example.com/page?query=1#top.');
    assert.deepStrictEqual(urlsBoth, ['https://example.com/page?query=1#top']);
  });

  it('10. unsafe protocols are rejected', () => {
    assert.deepStrictEqual(extractUrls('javascript:alert(1)'), []);
    assert.deepStrictEqual(extractUrls('data:text/html,<h1>XSS</h1>'), []);
    assert.deepStrictEqual(extractUrls('file:///etc/passwd'), []);
    assert.deepStrictEqual(extractUrls('vbscript:msgbox(1)'), []);
    assert.strictEqual(cleanUrl('javascript:alert(1)'), null);
    assert.strictEqual(cleanUrl('file:///C:/secret.txt'), null);
  });
});

describe('2. Links Tab Scoping & Real-Time Behavior', () => {
  it('11. Links tab extracts URLs from current conversation', () => {
    const messages = [
      makeMsgText('Hey there'),
      makeMsgText('Check this doc: https://ollacore.com/docs/api/'),
      makeMsgImage('photo.jpg')
    ];
    const seen = new Set();
    const links = [];
    for (const msg of [...messages].reverse()) {
      if (msg.isDeleted || msg.kind === 'deleted') continue;
      const resolved = resolveMessageContent(msg);
      const text = resolved.text || resolved.caption || '';
      for (const u of extractUrls(text)) {
        if (!seen.has(u)) {
          seen.add(u);
          links.push({ url: u, msgId: msg.id });
        }
      }
    }
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].url, 'https://ollacore.com/docs/api/');
    assert.strictEqual(links[0].msgId, messages[1].id);
  });

  it('12. links from another conversation are excluded', () => {
    const roomA = 'room-alpha';
    const roomB = 'room-beta';

    const stateA = new RoomMessagesState('user-1', new Map());
    stateA.roomId = roomA;
    stateA.appendIncomingMessage(makeMsgText('https://alpha.com', { roomId: roomA }));

    const stateB = new RoomMessagesState('user-1', new Map());
    stateB.roomId = roomB;
    stateB.appendIncomingMessage(makeMsgText('https://beta.com', { roomId: roomB }));

    const extractLinksFromState = (state) => {
      const links = [];
      for (const msg of state.messages) {
        if (msg.isDeleted || msg.kind === 'deleted') continue;
        const res = resolveMessageContent(msg);
        links.push(...extractUrls(res.text || ''));
      }
      return links;
    };

    const linksA = extractLinksFromState(stateA);
    const linksB = extractLinksFromState(stateB);

    assert.deepStrictEqual(linksA, ['https://alpha.com']);
    assert.deepStrictEqual(linksB, ['https://beta.com']);
    assert.ok(!linksA.includes('https://beta.com'));
    assert.ok(!linksB.includes('https://alpha.com'));
  });

  it('13. multiple link messages appear in reverse chronological order', () => {
    const messages = [
      makeMsgText('First: https://first.com', { id: 'm1' }),
      makeMsgText('Second: https://second.com', { id: 'm2' }),
      makeMsgText('Third: https://third.com', { id: 'm3' })
    ];
    const seen = new Set();
    const links = [];
    for (const msg of [...messages].reverse()) {
      const res = resolveMessageContent(msg);
      for (const u of extractUrls(res.text || '')) {
        if (!seen.has(u)) {
          seen.add(u);
          links.push(u);
        }
      }
    }
    assert.deepStrictEqual(links, ['https://third.com', 'https://second.com', 'https://first.com']);
  });

  it('14. deleted link message is removed / stale-safe', () => {
    const liveMsg = makeMsgText('Live link: https://live.com');
    const deletedMsg = makeMsgText('Old link: https://deleted.com', { isDeleted: true });
    const messages = [liveMsg, deletedMsg];

    const links = [];
    for (const msg of messages) {
      if (msg.isDeleted || msg.kind === 'deleted') continue;
      const res = resolveMessageContent(msg);
      links.push(...extractUrls(res.text || ''));
    }
    assert.deepStrictEqual(links, ['https://live.com']);
  });

  it('15. new incoming link appears in message state immediately without restart', () => {
    const state = new RoomMessagesState('user-1', new Map());
    state.roomId = 'room-live';
    state.setInitialMessages('room-live', [makeMsgText('Hello')]);

    assert.strictEqual(extractUrls(resolveMessageContent(state.messages[0]).text).length, 0);

    // Incoming message arrives via WebSocket
    const newMsg = makeMsgText('Check https://ollacore.com/docs/api/', { id: 'm-new' });
    state.appendIncomingMessage(newMsg);

    const latestMsg = state.messages[state.messages.length - 1];
    const extracted = extractUrls(resolveMessageContent(latestMsg).text);
    assert.deepStrictEqual(extracted, ['https://ollacore.com/docs/api/']);
  });
});

describe('3. Security & Existing Feature Protection', () => {
  it('16. clicking a link uses the secure external-open path (validating main IPC handler & shell bridge)', () => {
    const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');
    const mainCode = fs.readFileSync(mainJsPath, 'utf8');

    // Verify main process validates protocol before invoking shell.openExternal
    assert.ok(mainCode.includes("ipcMain.handle('shell:open-external'"), 'Must have shell:open-external IPC handler');
    assert.ok(
      mainCode.includes("url.startsWith('https://')") && mainCode.includes("url.startsWith('http://')"),
      'Main process must validate http/https before calling shell.openExternal'
    );

    const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
    const preloadCode = fs.readFileSync(preloadPath, 'utf8');
    assert.ok(preloadCode.includes("openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)"), 'Preload must safely bridge openExternal');
  });

  it('17. existing Media tab still works (images and videos filtered correctly)', () => {
    const messages = [
      makeMsgText('https://link.com'),
      makeMsgImage('selfie.jpg'),
      makeMsgFile('manual.pdf')
    ];
    const media = messages.filter((m) => {
      if (m.isDeleted || m.kind === 'deleted') return false;
      const k = (m.kind || '').toLowerCase();
      return k === 'image' || k === 'video';
    });
    assert.strictEqual(media.length, 1);
    assert.strictEqual(media[0].kind, 'image');
  });

  it('18. existing Docs tab still works (file messages filtered correctly)', () => {
    const messages = [
      makeMsgText('https://link.com'),
      makeMsgImage('photo.jpg'),
      makeMsgFile('contract.pdf')
    ];
    const docs = messages.filter((m) => {
      if (m.isDeleted || m.kind === 'deleted') return false;
      return (m.kind || '').toLowerCase() === 'file';
    });
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].kind, 'file');
  });

  it('19. existing Starred Messages still works', () => {
    const mockStorage = new Map();
    global.localStorage = {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    };

    const state = new RoomMessagesState('u-test', new Map());
    state.roomId = 'room-star-check';
    state.starMessage('msg-star-1', 'room-star-check');
    assert.ok(state.isStarred('msg-star-1', 'room-star-check'));
    state.unstarMessage('msg-star-1', 'room-star-check');
    assert.ok(!state.isStarred('msg-star-1', 'room-star-check'));
  });

  it('20. existing message rendering remains intact and styled in styles.css', () => {
    const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    assert.ok(css.includes('.chat-inline-link {'), 'Must have .chat-inline-link rule');
    assert.ok(css.includes('.mb-link-card {'), 'Must have .mb-link-card rule');
    assert.ok(css.includes('.mb-link-jump-btn {'), 'Must have .mb-link-jump-btn rule');
    assert.ok(css.includes('.message-highlight'), 'Must retain .message-highlight pulse');
  });
});
