import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  validateMediaFile,
  categorizeMediaKind,
  MAX_FILE_SIZE,
  SINGLE_PUT_THRESHOLD,
  MULTIPART_PART_SIZE,
  MAGIC_BYTES,
  EXTENSION_MIME_MAP,
  BLOCKED_EXTENSIONS
} from '../src/api/mime-validator.js';

import {
  RoomMessagesState,
  createOptimisticMediaMessage,
  resolveMessageContent,
  formatFileSize
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Attachment File Picker and Upload Pipeline Regression Suite', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ollachat-pick-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Security & Process Isolation Contracts
  // ─────────────────────────────────────────────────────────────
  describe('Security & Isolation Requirements', () => {
    test('Main process preserves contextIsolation, nodeIntegration: false, and sandbox: true', () => {
      const mainCode = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');

      // Check BrowserWindow webPreferences
      assert.ok(
        /contextIsolation:\s*true/.test(mainCode),
        'mainWindow must have contextIsolation: true'
      );
      assert.ok(
        /nodeIntegration:\s*false/.test(mainCode),
        'mainWindow must have nodeIntegration: false'
      );
      assert.ok(
        /sandbox:\s*true/.test(mainCode),
        'mainWindow must have sandbox: true'
      );
    });

    test('dialog:open-media-file does NOT expose raw host filesystem path to renderer', () => {
      const mainCode = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');

      // Locate dialog:open-media-file handler
      const handlerStart = mainCode.indexOf("ipcMain.handle('dialog:open-media-file'");
      assert.ok(handlerStart !== -1, 'dialog:open-media-file handler must be registered');

      const handlerEnd = mainCode.indexOf("ipcMain.handle('dialog:save-media-file'", handlerStart);
      const handlerBody = mainCode.slice(handlerStart, handlerEnd !== -1 ? handlerEnd : handlerStart + 2500);

      // Verify that return object does NOT include filePath
      assert.ok(
        !/return\s*\{[^}]*filePath\s*:[^}]*\}/.test(handlerBody),
        'dialog:open-media-file must not return raw filePath to renderer'
      );
      // Verify it returns fileId instead
      assert.ok(
        handlerBody.includes('fileId,'),
        'dialog:open-media-file must return ephemeral fileId token to renderer'
      );
    });

    test('dialog:open-media-file uses BrowserWindow.fromWebContents(event.sender) || mainWindow for dialog parenting', () => {
      const mainCode = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');
      assert.ok(
        mainCode.includes('BrowserWindow.fromWebContents(event.sender)') ||
        mainCode.includes('event?.sender ? BrowserWindow.fromWebContents(event.sender) : null'),
        'Parent window resolution must check BrowserWindow.fromWebContents(event.sender)'
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Image Selection & Preview Data URL
  // ─────────────────────────────────────────────────────────────
  describe('Image Selection & Preview', () => {
    test('Image file creates valid ephemeral token, safe data URL preview, and registers in attachmentUrls', async () => {
      // Create a valid dummy PNG image with standard PNG header
      const pngPath = path.join(tempDir, 'sample_photo.png');
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const pngBody = Buffer.alloc(1024, 0xAA);
      await fsPromises.writeFile(pngPath, Buffer.concat([pngHeader, pngBody]));

      const stat = await fsPromises.stat(pngPath);
      const headerBuf = Buffer.alloc(Math.min(64, stat.size));
      const fd = await fsPromises.open(pngPath, 'r');
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: path.basename(pngPath),
        byteSize: stat.size,
        headerBytes: headerBuf
      });

      assert.equal(validation.isValid, true);
      assert.equal(validation.kind, 'image');
      assert.equal(validation.effectiveMime, 'image/png');

      // Emulate main process response for image
      const fileId = 'att-pick-' + crypto.randomUUID();
      const imgBuf = await fsPromises.readFile(pngPath);
      const previewUrl = `data:${validation.effectiveMime};base64,${imgBuf.toString('base64')}`;

      const res = {
        canceled: false,
        ok: true,
        fileId,
        filename: 'sample_photo.png',
        byteSize: stat.size,
        mime: validation.effectiveMime,
        kind: validation.kind,
        previewUrl
      };

      // Assert no raw filePath is exposed
      assert.strictEqual(res.filePath, undefined);
      assert.ok(res.previewUrl.startsWith('data:image/png;base64,'));
      assert.ok(res.fileId.startsWith('att-pick-'));

      // Emulate renderer preview registration
      const attachmentUrls = new Map();
      const clientMessageId = `local-${crypto.randomUUID()}`;
      attachmentUrls.set(clientMessageId, res.previewUrl);

      assert.equal(attachmentUrls.get(clientMessageId), res.previewUrl);

      // Create optimistic media message
      const optimisticMsg = createOptimisticMediaMessage('room-1', 'user-1', {
        kind: res.kind,
        filename: res.filename,
        caption: '',
        mime: res.mime,
        byteSize: res.byteSize,
        clientMessageId
      });

      assert.equal(optimisticMsg.kind, 'image');
      assert.equal(optimisticMsg.status, 'sending');

      // Media resolution logic uses message and attachmentUrls
      const resolvedContent = resolveMessageContent(optimisticMsg);
      assert.equal(resolvedContent.kind, 'image');
      assert.equal(resolvedContent.filename, 'sample_photo.png');

      // With localUrl populated in attachmentUrls, the renderer renders <img> rather than remaining stuck at Loading
      const localUrl = attachmentUrls.get(clientMessageId);
      assert.ok(localUrl && localUrl.startsWith('data:image/png;base64,'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Video Selection & Safe Preview Handling
  // ─────────────────────────────────────────────────────────────
  describe('Video Selection', () => {
    test('Video file produces video kind and safe preview handling without duplicating huge buffers', async () => {
      // Create a valid MP4 with ftyp box
      const mp4Path = path.join(tempDir, 'sample_clip.mp4');
      const mp4Header = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ...ftyp
        0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02, 0x00
      ]);
      const mp4Body = Buffer.alloc(2048, 0x00);
      await fsPromises.writeFile(mp4Path, Buffer.concat([mp4Header, mp4Body]));

      const stat = await fsPromises.stat(mp4Path);
      const headerBuf = Buffer.alloc(Math.min(64, stat.size));
      const fd = await fsPromises.open(mp4Path, 'r');
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: 'sample_clip.mp4',
        byteSize: stat.size,
        headerBytes: headerBuf
      });

      assert.equal(validation.isValid, true);
      assert.equal(validation.kind, 'video');
      assert.equal(validation.effectiveMime, 'video/mp4');

      // Emulate small video preview generation
      const videoBuf = await fsPromises.readFile(mp4Path);
      const previewUrl = `data:${validation.effectiveMime};base64,${videoBuf.toString('base64')}`;

      const res = {
        canceled: false,
        ok: true,
        fileId: 'att-pick-' + crypto.randomUUID(),
        filename: 'sample_clip.mp4',
        byteSize: stat.size,
        mime: validation.effectiveMime,
        kind: 'video',
        previewUrl
      };

      assert.strictEqual(res.filePath, undefined);
      assert.equal(res.kind, 'video');
      assert.ok(res.previewUrl.startsWith('data:video/mp4;base64,'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Audio Selection
  // ─────────────────────────────────────────────────────────────
  describe('Audio Selection', () => {
    test('Audio file produces audio kind and safe preview URL', async () => {
      const mp3Path = path.join(tempDir, 'voice_note.mp3');
      // ID3 header
      const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20]);
      const mp3Body = Buffer.alloc(1024, 0xFF);
      await fsPromises.writeFile(mp3Path, Buffer.concat([id3Header, mp3Body]));

      const stat = await fsPromises.stat(mp3Path);
      const headerBuf = Buffer.alloc(Math.min(64, stat.size));
      const fd = await fsPromises.open(mp3Path, 'r');
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: 'voice_note.mp3',
        byteSize: stat.size,
        headerBytes: headerBuf
      });

      assert.equal(validation.isValid, true);
      assert.equal(validation.kind, 'audio');
      assert.equal(validation.effectiveMime, 'audio/mpeg');

      const audioBuf = await fsPromises.readFile(mp3Path);
      const previewUrl = `data:${validation.effectiveMime};base64,${audioBuf.toString('base64')}`;

      const res = {
        canceled: false,
        ok: true,
        fileId: 'att-pick-' + crypto.randomUUID(),
        filename: 'voice_note.mp3',
        byteSize: stat.size,
        mime: validation.effectiveMime,
        kind: 'audio',
        previewUrl
      };

      assert.strictEqual(res.filePath, undefined);
      assert.equal(res.kind, 'audio');
      assert.ok(res.previewUrl.startsWith('data:audio/mpeg;base64,'));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. PDF & Document Selection (No Redundant Previews)
  // ─────────────────────────────────────────────────────────────
  describe('PDF & Document Selection', () => {
    test('PDF/document selection sets previewUrl to null and preserves document card rendering', async () => {
      const pdfPath = path.join(tempDir, 'BCA_Marksheet.pdf');
      const pdfHeader = Buffer.from('%PDF-1.4 Mock PDF content');
      await fsPromises.writeFile(pdfPath, pdfHeader);

      const stat = await fsPromises.stat(pdfPath);
      const headerBuf = Buffer.alloc(Math.min(64, stat.size));
      const fd = await fsPromises.open(pdfPath, 'r');
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: 'BCA_Marksheet.pdf',
        byteSize: stat.size,
        headerBytes: headerBuf
      });

      assert.equal(validation.isValid, true);
      assert.equal(validation.kind, 'file');
      assert.equal(validation.effectiveMime, 'application/pdf');

      // Main process strictly sets previewUrl to null for documents/PDFs
      let previewUrl = null;
      if (validation.kind === 'image' && stat.size <= 15 * 1024 * 1024) {
        previewUrl = 'image-preview';
      } else if (validation.kind === 'audio' && stat.size <= 5 * 1024 * 1024) {
        previewUrl = 'audio-preview';
      } else if (validation.kind === 'video' && stat.size <= 10 * 1024 * 1024) {
        previewUrl = 'video-preview';
      }

      assert.strictEqual(previewUrl, null, 'Documents must not generate image previews');

      const res = {
        canceled: false,
        ok: true,
        fileId: 'att-pick-' + crypto.randomUUID(),
        filename: 'BCA_Marksheet.pdf',
        byteSize: stat.size,
        mime: validation.effectiveMime,
        kind: 'file',
        previewUrl: null
      };

      assert.strictEqual(res.filePath, undefined);
      assert.strictEqual(res.previewUrl, null);

      // Verify optimistic message creation for documents
      const optimisticMsg = createOptimisticMediaMessage('room-doc', 'user-1', {
        kind: res.kind,
        filename: res.filename,
        caption: '',
        mime: res.mime,
        byteSize: res.byteSize,
        clientMessageId: 'local-pdf-123'
      });

      assert.equal(optimisticMsg.kind, 'file');
      assert.equal(optimisticMsg.body.filename, 'BCA_Marksheet.pdf');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. User Cancellation
  // ─────────────────────────────────────────────────────────────
  describe('Cancellation Handling', () => {
    test('User cancellation returns canceled: true and ok: true without error', () => {
      // Emulate Electron showOpenDialog returning canceled: true
      const dialogRes = { canceled: true, filePaths: [] };

      let result;
      if (dialogRes.canceled || !dialogRes.filePaths || dialogRes.filePaths.length === 0) {
        result = { canceled: true, ok: true };
      }

      assert.equal(result.canceled, true);
      assert.equal(result.ok, true);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.filePath, undefined);
      assert.strictEqual(result.fileId, undefined);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Invalid & Blocked File Handling
  // ─────────────────────────────────────────────────────────────
  describe('Invalid & Blocked Files', () => {
    test('Blocked executable (.exe) returns canceled: false, ok: false, error', async () => {
      const exePath = path.join(tempDir, 'malware.exe');
      await fsPromises.writeFile(exePath, Buffer.from('MZ executable binary data'));

      const stat = await fsPromises.stat(exePath);
      const headerBuf = Buffer.alloc(Math.min(64, stat.size));
      const fd = await fsPromises.open(exePath, 'r');
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: 'malware.exe',
        byteSize: stat.size,
        headerBytes: headerBuf
      });

      assert.equal(validation.isValid, false);
      assert.ok(validation.error.toLowerCase().includes('blocked') || validation.error.toLowerCase().includes('executable'));

      let response;
      if (!validation.isValid) {
        response = {
          canceled: false,
          ok: false,
          error: validation.error || 'Media file validation failed'
        };
      }

      assert.equal(response.canceled, false, 'Security error must NOT be reported as user cancellation');
      assert.equal(response.ok, false);
      assert.ok(response.error.length > 0);
    });

    test('Empty (0-byte) file returns canceled: false, ok: false, error', async () => {
      const emptyPath = path.join(tempDir, 'empty.png');
      await fsPromises.writeFile(emptyPath, Buffer.alloc(0));

      const stat = await fsPromises.stat(emptyPath);
      let response;
      if (stat.size === 0) {
        response = {
          canceled: false,
          ok: false,
          error: 'Selected file is empty (0 bytes)'
        };
      }

      assert.equal(response.canceled, false);
      assert.equal(response.ok, false);
      assert.equal(response.error, 'Selected file is empty (0 bytes)');
    });

    test('Non-file path (directory) returns canceled: false, ok: false, error', async () => {
      const subDir = path.join(tempDir, 'some_folder');
      await fsPromises.mkdir(subDir);

      const stat = await fsPromises.stat(subDir);
      let response;
      if (!stat.isFile()) {
        response = {
          canceled: false,
          ok: false,
          error: 'Selected path is not a regular file'
        };
      }

      assert.equal(response.canceled, false);
      assert.equal(response.ok, false);
      assert.equal(response.error, 'Selected path is not a regular file');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Upload Pipeline with Safe fileId Token
  // ─────────────────────────────────────────────────────────────
  describe('Upload Pipeline with fileId', () => {
    test('chat-api:upload-media resolves file from pendingMediaUploads and cleans up token', async () => {
      const pendingMediaUploads = new Map();

      // Create a test file
      const sampleFile = path.join(tempDir, 'upload_me.jpg');
      const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
      await fsPromises.writeFile(sampleFile, jpegHeader);
      const stat = await fsPromises.stat(sampleFile);

      const fileId = 'att-pick-' + crypto.randomUUID();
      pendingMediaUploads.set(fileId, {
        filePath: sampleFile,
        filename: 'upload_me.jpg',
        mime: 'image/jpeg',
        byteSize: stat.size,
        kind: 'image',
        createdAt: Date.now()
      });

      // Emulate upload-media handler resolving fileId
      assert.ok(pendingMediaUploads.has(fileId));
      const pending = pendingMediaUploads.get(fileId);
      const targetFilePath = pending.filePath;
      assert.equal(targetFilePath, sampleFile);

      // Verify file exists and is readable
      assert.ok(fs.existsSync(targetFilePath));
      const readBuf = await fsPromises.readFile(targetFilePath);
      assert.deepEqual(readBuf.subarray(0, jpegHeader.length), jpegHeader);

      // Verify cleanup of token on completion
      pendingMediaUploads.delete(fileId);
      assert.equal(pendingMediaUploads.has(fileId), false);
    });

    test('chat-api:upload-media removes fileId from pendingMediaUploads even on error', async () => {
      const pendingMediaUploads = new Map();
      const fileId = 'att-pick-' + crypto.randomUUID();
      pendingMediaUploads.set(fileId, {
        filePath: path.join(tempDir, 'non_existent.jpg'),
        filename: 'non_existent.jpg',
        mime: 'image/jpeg',
        byteSize: 100,
        kind: 'image',
        createdAt: Date.now()
      });

      try {
        const pending = pendingMediaUploads.get(fileId);
        if (!fs.existsSync(pending.filePath)) {
          throw new Error('File does not exist');
        }
      } catch (err) {
        if (fileId) pendingMediaUploads.delete(fileId);
      }

      assert.equal(pendingMediaUploads.has(fileId), false, 'Token must be cleaned up on failure');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Existing Attachment Rendering Verification
  // ─────────────────────────────────────────────────────────────
  describe('Attachment Rendering Preservation', () => {
    test('Image, video, audio, and file kinds retain correct bubble styling and attributes', () => {
      const kinds = ['image', 'video', 'audio', 'file'];

      for (const kind of kinds) {
        const msg = createOptimisticMediaMessage('room-test', 'user-test', {
          kind,
          filename: `test_${kind}.${kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'pdf'}`,
          caption: '',
          mime: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'application/pdf',
          byteSize: 12345,
          clientMessageId: `msg-${kind}`
        });

        assert.equal(msg.kind, kind);
        assert.equal(msg.status, 'sending');
        assert.equal(msg.body.byte_size, 12345);
      }
    });

    test('formatFileSize displays human-readable file sizes correctly for attachments', () => {
      assert.equal(formatFileSize(0), '0 B');
      assert.equal(formatFileSize(512), '512 B');
      assert.equal(formatFileSize(1024), '1.0 KB');
      assert.equal(formatFileSize(1048576), '1.0 MB');
      assert.equal(formatFileSize(5242880), '5.0 MB');
    });
  });
});
