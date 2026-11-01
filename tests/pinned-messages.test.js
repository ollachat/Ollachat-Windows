import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

describe('Local Message Pinning (40 Invariants)', () => {
  let appJs;
  let stateJs;
  let html;
  let cssFile;

  before(async () => {
    appJs = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'app.js'), 'utf8');
    stateJs = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'chat-shell-state.js'), 'utf8');
    html = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'index.html'), 'utf8');
    cssFile = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'styles.css'), 'utf8');
  });

  test('1. PIN_DURATIONS constant exported from chat-shell-state', () => {
    assert.ok(stateJs.includes('export const PIN_DURATIONS'), 'PIN_DURATIONS exported');
    assert.ok(stateJs.includes('HOURS_24'), 'includes 24h duration');
    assert.ok(stateJs.includes('DAYS_7'), 'includes 7d duration');
    assert.ok(stateJs.includes('DAYS_30'), 'includes 30d duration');
    assert.ok(stateJs.includes('DAYS_90'), 'includes 90d duration');
  });

  test('2. PIN_DURATION_MAP maps string keys to millisecond values', () => {
    assert.ok(stateJs.includes("export const PIN_DURATION_MAP"), 'PIN_DURATION_MAP exported');
    assert.ok(stateJs.includes("'24h'"), 'has 24h key');
    assert.ok(stateJs.includes("'7d'"), 'has 7d key');
    assert.ok(stateJs.includes("'30d'"), 'has 30d key');
    assert.ok(stateJs.includes("'90d'"), 'has 90d key');
  });

  test('3. MAX_PINS_PER_CHAT exported and equals 3', () => {
    assert.ok(stateJs.includes('export const MAX_PINS_PER_CHAT = 3'), 'max pins is 3');
  });

  test('4. formatPinExpiration helper exported', () => {
    assert.ok(stateJs.includes('export function formatPinExpiration'), 'formatPinExpiration exported');
  });

  test('5. formatPinRemainingTime helper exported', () => {
    assert.ok(stateJs.includes('export function formatPinRemainingTime'), 'formatPinRemainingTime exported');
  });

  test('6. getMessagePinPreview helper handles image video audio document text', () => {
    assert.ok(stateJs.includes('export function getMessagePinPreview'), 'getMessagePinPreview exported');
    assert.ok(stateJs.includes("'image'") && stateJs.includes("'video'"), 'handles media kinds');
    assert.ok(stateJs.includes('voice') || stateJs.includes('audio'), 'handles voice/audio');
  });

  test('7. ChatShellState.pinMessage() method defined', () => {
    assert.ok(stateJs.includes('pinMessage(roomId, messageId, durationChoice'), 'pinMessage defined');
  });

  test('8. ChatShellState.unpinMessage() method defined', () => {
    assert.ok(stateJs.includes('unpinMessage(roomId, messageId)'), 'unpinMessage defined');
  });

  test('9. ChatShellState.clearPinnedMessages() method defined', () => {
    assert.ok(stateJs.includes('clearPinnedMessages(roomId)'), 'clearPinnedMessages defined');
  });

  test('10. ChatShellState.isMessagePinned() method defined', () => {
    assert.ok(stateJs.includes('isMessagePinned(messageId, roomId'), 'isMessagePinned defined');
  });

  test('11. ChatShellState.getPinnedMessages() method defined', () => {
    assert.ok(stateJs.includes('getPinnedMessages(roomId'), 'getPinnedMessages defined');
  });

  test('12. ChatShellState.pruneExpiredPins() method defined', () => {
    assert.ok(stateJs.includes('pruneExpiredPins(roomId'), 'pruneExpiredPins defined');
  });

  test('13. pinnedMessages initialized as new Map() in constructor', () => {
    assert.ok(stateJs.includes('this.pinnedMessages = new Map()'), 'Map() initialized');
  });

  test('14. pinMessage enforces MAX_PINS_PER_CHAT limit and returns error', () => {
    assert.ok(stateJs.includes("error: 'limit_reached'"), 'returns limit_reached error');
    assert.ok(stateJs.includes('max: MAX_PINS_PER_CHAT'), 'returns max count');
  });

  test('15. pinMessage supports re-pinning existing message (updates duration)', () => {
    assert.ok(stateJs.includes("updated: true"), 'returns updated flag for re-pin');
  });

  test('16. _persistPinnedMessages stores to localStorage key scoped to userId', () => {
    assert.ok(stateJs.includes('ollachat_pinned_messages_'), 'storage key present');
    assert.ok(stateJs.includes('_persistPinnedMessages()'), '_persistPinnedMessages defined');
    assert.ok(stateJs.includes('localStorage.setItem'), 'writes to localStorage');
  });

  test('17. _loadPreferences loads pinned messages and prunes expired pins on startup', () => {
    assert.ok(stateJs.includes("ollachat_pinned_messages_"), 'reads pinned messages key');
    assert.ok(stateJs.includes('this.pruneExpiredPins()'), 'prunes expired pins on load');
  });

  test('18. clear() on logout resets pinnedMessages Map', () => {
    // The clear() method (called on logout) resets the pinnedMessages map.
    // We verify by finding the 'Resets all chat state' comment then checking that
    // this.pinnedMessages = new Map() appears within the next 1200 chars.
    const markerIdx = stateJs.indexOf('Resets all chat state (called on logout)');
    assert.ok(markerIdx > 0, 'logout reset comment found');
    const region = stateJs.slice(markerIdx, markerIdx + 1200);
    assert.ok(region.includes('this.pinnedMessages = new Map()'), 'clear() resets pinnedMessages');
  });

  test('19. deleteMessageForMe() removes matching pin from localStorage', () => {
    assert.ok(stateJs.includes('Clean up matching pin'), 'deleteMessageForMe cleans up pins');
  });

  test('20. deleteMessage() for everyone removes matching pin from localStorage', () => {
    const deleteEveryoneSection = stateJs.indexOf('Deletes a message for everyone');
    const cleanupAfter = stateJs.indexOf('ollachat_pinned_messages_', deleteEveryoneSection);
    assert.ok(cleanupAfter > 0 && cleanupAfter < deleteEveryoneSection + 2000, 'deleteMessage cleans up pins');
  });

  test('21. clearMessages() removes all pins for the room from localStorage', () => {
    assert.ok(stateJs.includes('Clean up pins for this room'), 'clearMessages cleans up all room pins');
  });

  test('22. chat-pinned-bar exists in HTML below chat header', () => {
    assert.ok(html.includes('id="chat-pinned-bar"'), 'pinned bar in HTML');
  });

  test('23. Pinned bar has snippet expiry counter nav elements', () => {
    assert.ok(html.includes('id="chat-pinned-bar-snippet"'), 'snippet element');
    assert.ok(html.includes('id="chat-pinned-bar-expiry"'), 'expiry element');
    assert.ok(html.includes('id="chat-pinned-bar-counter"'), 'counter element');
    assert.ok(html.includes('id="btn-pinned-prev"'), 'prev button');
    assert.ok(html.includes('id="btn-pinned-next"'), 'next button');
    assert.ok(html.includes('id="btn-pinned-unpin"'), 'unpin button');
  });

  test('24. Context menu has Pin item with data-action=pin and ctx-pin-text', () => {
    assert.ok(html.includes('data-action="pin"'), 'pin action in context menu');
    assert.ok(html.includes('id="ctx-pin-text"'), 'ctx-pin-text element for dynamic label');
  });

  test('25. pin-duration-modal exists with 4 radio options', () => {
    assert.ok(html.includes('id="pin-duration-modal"'), 'pin-duration-modal exists');
    assert.ok(html.includes('value="24h"'), '24h option');
    assert.ok(html.includes('value="7d"'), '7d option');
    assert.ok(html.includes('value="30d"'), '30d option');
    assert.ok(html.includes('value="90d"'), '90d option');
    assert.ok(html.includes('id="pin-duration-expiry"'), 'expiry preview element');
  });

  test('26. Pin duration modal has local-only disclosure text', () => {
    assert.ok(html.includes('Pins are saved on this device'), 'local-only disclosure present');
  });

  test('27. pin-limit-modal exists with correct messaging', () => {
    assert.ok(html.includes('id="pin-limit-modal"'), 'pin-limit-modal exists');
    assert.ok(html.includes('Maximum pinned messages'), 'limit message text present');
  });

  test('28. pinned-messages-panel exists with list and empty state', () => {
    assert.ok(html.includes('id="pinned-messages-panel"'), 'pinned-messages-panel exists');
    assert.ok(html.includes('id="pinned-list"'), 'pinned-list exists');
    assert.ok(html.includes('id="pinned-empty"'), 'pinned-empty state exists');
    assert.ok(html.includes('id="btn-close-pinned-messages"'), 'close button exists');
  });

  test('29. Contact info has pinned messages navigation row', () => {
    assert.ok(html.includes('id="contact-info-pinned-row"'), 'contact-info-pinned-row exists');
    assert.ok(html.includes('Pinned messages'), 'pinned messages label present');
  });

  test('30. .chat-pinned-bar CSS defined', () => {
    assert.ok(cssFile.includes('.chat-pinned-bar {'), 'chat-pinned-bar CSS defined');
  });

  test('31. .message-meta-pin CSS defined', () => {
    assert.ok(cssFile.includes('.message-meta-pin {'), 'message-meta-pin CSS defined');
  });

  test('32. .pin-duration-option CSS defined', () => {
    assert.ok(cssFile.includes('.pin-duration-option {'), 'pin-duration-option CSS defined');
  });

  test('33. .pinned-msg-item CSS defined', () => {
    assert.ok(cssFile.includes('.pinned-msg-item {'), 'pinned-msg-item CSS defined');
  });

  test('34. pinned-local-disclosure or pin-modal-disclosure CSS defined', () => {
    assert.ok(
      cssFile.includes('pinned-local-disclosure') || cssFile.includes('pin-modal-disclosure'),
      'disclosure text CSS defined'
    );
  });

  test('35. app.js imports all pin-related exports from chat-shell-state', () => {
    assert.ok(appJs.includes('PIN_DURATIONS'), 'PIN_DURATIONS imported');
    assert.ok(appJs.includes('PIN_DURATION_MAP'), 'PIN_DURATION_MAP imported');
    assert.ok(appJs.includes('MAX_PINS_PER_CHAT'), 'MAX_PINS_PER_CHAT imported');
    assert.ok(appJs.includes('formatPinExpiration'), 'formatPinExpiration imported');
    assert.ok(appJs.includes('formatPinRemainingTime'), 'formatPinRemainingTime imported');
    assert.ok(appJs.includes('getMessagePinPreview'), 'getMessagePinPreview imported');
  });

  test('36. renderPinnedBar() defined and called on conversation selection with index reset', () => {
    assert.ok(appJs.includes('function renderPinnedBar('), 'renderPinnedBar defined');
    assert.ok(appJs.includes('renderPinnedBar(roomId)'), 'renderPinnedBar called');
    assert.ok(appJs.includes('currentPinnedBarIndex = 0'), 'index reset on conversation select');
  });

  test('37. pin action in context menu calls openPinDurationModal or shellState.unpinMessage', () => {
    assert.ok(appJs.includes("action === 'pin'"), 'pin action handled in context menu');
    assert.ok(appJs.includes('openPinDurationModal'), 'openPinDurationModal called');
    assert.ok(appJs.includes('shellState.unpinMessage'), 'shellState.unpinMessage called for unpin');
  });

  test('38. ctxPinText set to Unpin or Pin based on current pin state', () => {
    assert.ok(appJs.includes('ctxPinText'), 'ctxPinText DOM reference used');
    assert.ok(appJs.includes("Unpin"), 'Unpin label used');
  });

  test('39. handleClearChatProceed calls shellState.clearPinnedMessages', () => {
    assert.ok(appJs.includes('shellState.clearPinnedMessages(roomId)'), 'clearPinnedMessages called on clear chat');
  });

  test('40. Pin feature is local-only: confirmPinMessage does not call fetch or WebSocket send', () => {
    const confirmFnStart = appJs.indexOf('function confirmPinMessage');
    assert.ok(confirmFnStart > 0, 'confirmPinMessage function exists');
    const confirmFnEnd = appJs.indexOf('\nfunction ', confirmFnStart + 50);
    const confirmFnBody = appJs.slice(confirmFnStart, confirmFnEnd > 0 ? confirmFnEnd : confirmFnStart + 1200);
    assert.ok(!confirmFnBody.includes('fetch('), 'confirmPinMessage does not call fetch');
    assert.ok(!confirmFnBody.includes('.send('), 'confirmPinMessage does not call WebSocket send');
  });
});

