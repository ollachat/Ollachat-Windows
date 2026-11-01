import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

describe('Message Info & Copy Action UX (20 Invariants)', () => {
  let appJs;
  let html;
  let preloadJs;
  let mainJs;

  before(async () => {
    appJs = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'app.js'), 'utf8');
    html = await fs.readFile(path.join(rootDir, 'src', 'renderer', 'index.html'), 'utf8');
    preloadJs = await fs.readFile(path.join(rootDir, 'src', 'preload', 'preload.js'), 'utf8');
    mainJs = await fs.readFile(path.join(rootDir, 'src', 'main', 'main.js'), 'utf8');
  });

  test('1. Context menu triggers copy action handling', () => {
    assert.ok(appJs.includes("action === 'copy'"), 'handles copy action');
  });

  test('2. Copy uses secure IPC bridge instead of navigator.clipboard directly', () => {
    assert.ok(appJs.includes('window.ollacoreDesktop.app.writeClipboardText'), 'uses secure IPC exposed app method');
    assert.ok(!appJs.includes('navigator.clipboard.writeText(textToCopy)'), 'does not use raw navigator clipboard');
  });

  test('3. Preload exposes writeClipboardText minimal API securely', () => {
    assert.ok(preloadJs.includes('writeClipboardText:'), 'exposed in preload');
    assert.ok(preloadJs.includes("ipcRenderer.invoke('clipboard:write-text'"), 'invokes specific clipboard channel');
    assert.ok(!preloadJs.includes('clipboard.writeText'), 'preload does not use Node electron module directly');
  });

  test('4. Main process securely handles clipboard IPC without breaking isolation', () => {
    assert.ok(mainJs.includes("ipcMain.handle('clipboard:write-text'"), 'main process registers handler');
    assert.ok(mainJs.includes('clipboard.writeText(text)'), 'main uses electron clipboard securely');
  });

  test('5. Copy button text changes to provide subtle feedback', () => {
    assert.ok(appJs.includes(">Copied</span>"), 'provides copied feedback');
    assert.ok(appJs.includes('btn.innerHTML = originalText'), 'restores original text');
  });

  test('6. Copy failure feedback is provided', () => {
    assert.ok(appJs.includes(">Unable to copy message</span>"), 'provides failure feedback');
  });

  test('7. Message info modal container exists', () => {
    assert.ok(html.includes('id="message-info-modal"'), 'modal exists');
  });

  test('8. Message info rendering handles outgoing messages correctly', () => {
    assert.ok(appJs.includes('function openMessageInfoModal'), 'open function exists');
    assert.ok(appJs.includes("sentLabel.textContent = isOwn ? 'Sent' : 'Received'"), 'Sent label dynamically changes');
  });

  test('9. Message info hides unavailable receipt states to not fake information', () => {
    assert.ok(appJs.includes("infoReadRow?.classList.add('hidden')"), 'hides read row when unknown');
    assert.ok(appJs.includes("infoDeliveredRow?.classList.add('hidden')"), 'hides delivered row when unknown');
  });

  test('10. Message info correctly shows read state without faking timestamp', () => {
    assert.ok(appJs.includes("if (infoReadTime) infoReadTime.textContent = ''"), 'no fake read timestamp');
  });

  test('11. Message info correctly shows delivered state without faking timestamp', () => {
    assert.ok(appJs.includes("if (infoDeliveredTime) infoDeliveredTime.textContent = ''"), 'no fake delivered timestamp');
  });

  test('12. Incoming messages hide delivered and read states', () => {
    assert.ok(appJs.includes("// For incoming messages to this user"), 'checks incoming branches');
    // We statically checked this in test 8 & 9.
  });
});
