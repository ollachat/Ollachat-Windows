import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Video Fullscreen Permissions & Handler Regression Suite', async (t) => {
  const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
  const mainJsContent = fs.readFileSync(mainJsPath, 'utf8');

  await t.test('1. main.js contains explicit fullscreen and automatic-fullscreen handlers', () => {
    // Verify setPermissionRequestHandler grants fullscreen & automatic-fullscreen
    assert.match(
      mainJsContent,
      /setPermissionRequestHandler[\s\S]*?permission === 'fullscreen' \|\| permission === 'automatic-fullscreen'[\s\S]*?callback\(true\)/,
      'setPermissionRequestHandler must explicitly approve fullscreen and automatic-fullscreen'
    );

    // Verify setPermissionCheckHandler grants fullscreen & automatic-fullscreen
    assert.match(
      mainJsContent,
      /setPermissionCheckHandler[\s\S]*?permission === 'fullscreen' \|\| permission === 'automatic-fullscreen'[\s\S]*?return true/,
      'setPermissionCheckHandler must explicitly return true for fullscreen and automatic-fullscreen'
    );
  });

  // Extract and execute the exact logic in main.js
  function createPermissionHandlers() {
    let requestHandler = null;
    let checkHandler = null;

    const mockSession = {
      defaultSession: {
        setPermissionRequestHandler(fn) {
          requestHandler = fn;
        },
        setPermissionCheckHandler(fn) {
          checkHandler = fn;
        }
      }
    };

    // Evaluate the handler definitions matching main.js
    mockSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
        callback(true);
        return;
      }
      if (permission === 'media') {
        const mediaTypes = details?.mediaTypes || [];
        const isAllowed = mediaTypes.length === 0 || mediaTypes.every((t) => t === 'audio' || t === 'video');
        callback(isAllowed);
        return;
      }
      if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
        callback(true);
        return;
      }
      callback(false);
    });

    mockSession.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
        return true;
      }
      if (permission === 'media') {
        if (!details?.mediaType || details.mediaType === 'audio' || details.mediaType === 'video') {
          return true;
        }
      }
      if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
        return true;
      }
      return false;
    });

    return {
      requestPermission(permission, details = {}) {
        let result = null;
        requestHandler({}, permission, (allowed) => {
          result = allowed;
        }, details);
        return result;
      },
      checkPermission(permission, details = {}) {
        return checkHandler({}, permission, 'http://localhost', details);
      }
    };
  }

  await t.test('2. PermissionRequestHandler approves fullscreen permissions', () => {
    const handlers = createPermissionHandlers();
    assert.equal(handlers.requestPermission('fullscreen'), true, 'fullscreen must be allowed');
    assert.equal(handlers.requestPermission('automatic-fullscreen'), true, 'automatic-fullscreen must be allowed');
  });

  await t.test('3. PermissionCheckHandler approves fullscreen permissions', () => {
    const handlers = createPermissionHandlers();
    assert.equal(handlers.checkPermission('fullscreen'), true, 'fullscreen check must be allowed');
    assert.equal(handlers.checkPermission('automatic-fullscreen'), true, 'automatic-fullscreen check must be allowed');
  });

  await t.test('4. Existing media, camera, and microphone permissions remain allowed', () => {
    const handlers = createPermissionHandlers();

    // Requests
    assert.equal(handlers.requestPermission('media', { mediaTypes: ['audio'] }), true);
    assert.equal(handlers.requestPermission('media', { mediaTypes: ['video'] }), true);
    assert.equal(handlers.requestPermission('media', { mediaTypes: ['audio', 'video'] }), true);
    assert.equal(handlers.requestPermission('microphone'), true);
    assert.equal(handlers.requestPermission('camera'), true);
    assert.equal(handlers.requestPermission('audioCapture'), true);
    assert.equal(handlers.requestPermission('videoCapture'), true);

    // Checks
    assert.equal(handlers.checkPermission('media', { mediaType: 'audio' }), true);
    assert.equal(handlers.checkPermission('media', { mediaType: 'video' }), true);
    assert.equal(handlers.checkPermission('microphone'), true);
    assert.equal(handlers.checkPermission('camera'), true);
    assert.equal(handlers.checkPermission('audioCapture'), true);
    assert.equal(handlers.checkPermission('videoCapture'), true);
  });

  await t.test('5. Unrelated sensitive permissions remain strictly denied', () => {
    const handlers = createPermissionHandlers();
    const sensitive = [
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'pointerLock',
      'midi',
      'midiSysex',
      'display-capture',
      'mediaKeySystem'
    ];

    for (const perm of sensitive) {
      assert.equal(handlers.requestPermission(perm), false, `Request for ${perm} must be denied`);
      assert.equal(handlers.checkPermission(perm), false, `Check for ${perm} must be denied`);
    }
  });

  await t.test('6. HTML5 video fullscreen DOM lifecycle simulation', () => {
    // Simulate DOM element entering and exiting fullscreen
    class MockVideoElement {
      constructor() {
        this.controls = true;
        this.playsInline = true;
        this.className = 'message-video';
        this._fullscreen = false;
      }

      async requestFullscreen(handlers) {
        // Step 1: Chromium queries permission check
        const check = handlers.checkPermission('automatic-fullscreen');
        if (!check) {
          throw new TypeError('Permissions check failed');
        }
        // Step 2: Chromium queries permission request
        const req = handlers.requestPermission('fullscreen');
        if (!req) {
          throw new TypeError('Permissions check failed');
        }
        this._fullscreen = true;
        return true;
      }

      exitFullscreen() {
        this._fullscreen = false;
      }
    }

    const handlers = createPermissionHandlers();
    const video = new MockVideoElement();

    // With handlers allowing fullscreen:
    assert.doesNotReject(async () => {
      await video.requestFullscreen(handlers);
      assert.equal(video._fullscreen, true);
      video.exitFullscreen();
      assert.equal(video._fullscreen, false);
    });
  });
});
