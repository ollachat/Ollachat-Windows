import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartHidden, setAutoStart, isAutoStartEnabled } from '../src/main/auto-start.js';

describe('Windows Auto-Start & Background Lifecycle Helper Suite', () => {
  // 1. Detection of CLI hidden flags
  test('1. shouldStartHidden detects --hidden, --background, and --minimized in argv', () => {
    assert.equal(shouldStartHidden(['OllaChat.exe', '--hidden']), true);
    assert.equal(shouldStartHidden(['OllaChat.exe', '--background']), true);
    assert.equal(shouldStartHidden(['OllaChat.exe', '--minimized']), true);
    assert.equal(shouldStartHidden(['OllaChat.exe']), false);
    assert.equal(shouldStartHidden([]), false);
  });

  // 2. Detection of Windows login item settings
  test('2. shouldStartHidden detects wasOpenedAsHidden or wasOpenedAtLogin from login settings', () => {
    assert.equal(shouldStartHidden([], { wasOpenedAsHidden: true }), true);
    assert.equal(shouldStartHidden([], { wasOpenedAtLogin: true }), true);
    assert.equal(shouldStartHidden([], { wasOpenedAsHidden: false, wasOpenedAtLogin: false }), false);
    assert.equal(shouldStartHidden([], null), false);
  });

  // 3. Enabling auto-start configuration
  test('3. setAutoStart passes correct parameters to app.setLoginItemSettings', () => {
    let capturedSettings = null;
    const mockApp = {
      setLoginItemSettings: (settings) => {
        capturedSettings = settings;
      }
    };

    const res = setAutoStart(mockApp, true, { execPath: 'C:\\App\\OllaChat.exe' });
    assert.equal(res, true);
    assert.deepEqual(capturedSettings, {
      openAtLogin: true,
      openAsHidden: true,
      path: 'C:\\App\\OllaChat.exe',
      args: ['--hidden']
    });
  });

  // 4. Disabling auto-start configuration
  test('4. setAutoStart(false) disables openAtLogin and clears args', () => {
    let capturedSettings = null;
    const mockApp = {
      setLoginItemSettings: (settings) => {
        capturedSettings = settings;
      }
    };

    const res = setAutoStart(mockApp, false, { execPath: 'C:\\App\\OllaChat.exe' });
    assert.equal(res, true);
    assert.deepEqual(capturedSettings, {
      openAtLogin: false,
      openAsHidden: false,
      path: 'C:\\App\\OllaChat.exe',
      args: []
    });
  });

  // 5. Querying auto-start status
  test('5. isAutoStartEnabled queries login item settings correctly', () => {
    const mockAppEnabled = {
      getLoginItemSettings: () => ({ openAtLogin: true })
    };
    assert.equal(isAutoStartEnabled(mockAppEnabled), true);

    const mockAppDisabled = {
      getLoginItemSettings: () => ({ openAtLogin: false })
    };
    assert.equal(isAutoStartEnabled(mockAppDisabled), false);

    assert.equal(isAutoStartEnabled(null), false);
  });
});
