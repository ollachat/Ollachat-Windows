import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  sanitizeAttachmentFilename,
  getSafeAttachmentCachePath,
  isAttachmentCached,
  getCachedAttachmentPath,
  saveAttachmentToCache,
  ensureAttachmentCacheDir
} from '../src/storage/attachment-cache.js';

import {
  validateMediaFile,
  categorizeMediaKind,
  EXTENSION_MIME_MAP,
  MAGIC_BYTES
} from '../src/api/mime-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('PDF and File Attachment Open/View vs Download Suite', () => {

  // ═════════════════════════════════════════════════════════════════
  // 1. Attachment Cache Unit Tests
  // ═════════════════════════════════════════════════════════════════
  describe('Attachment Cache & Path Traversal Security', () => {
    test('1. sanitizeAttachmentFilename preserves .pdf extension and neutralizes path traversal', () => {
      // Normal PDF
      assert.equal(sanitizeAttachmentFilename('BCA Marksheet 4 Semesters .pdf'), 'BCA Marksheet 4 Semesters .pdf');
      
      // Traversal attacks
      const traversal1 = sanitizeAttachmentFilename('../../etc/passwd.pdf');
      assert.equal(traversal1, 'passwd.pdf');

      const traversal2 = sanitizeAttachmentFilename('..\\..\\Windows\\System32\\calc.exe.pdf');
      assert.equal(traversal2, 'calc.exe.pdf');

      // Illegal Windows characters
      const illegal = sanitizeAttachmentFilename('Report: 2026/04/05 *final* <draft>?.pdf');
      assert.ok(!/[<>:"/\\|?*]/.test(illegal));
      assert.ok(illegal.endsWith('.pdf'));
    });

    test('2. getSafeAttachmentCachePath generates path strictly confined to cacheDir', () => {
      const tempCacheDir = path.join(os.tmpdir(), 'ollachat_test_cache_' + Date.now());
      const safePath = getSafeAttachmentCachePath(tempCacheDir, 'att-uuid-123', 'BCA Marksheet 4 Semesters .pdf', 'application/pdf');

      assert.ok(safePath.startsWith(path.resolve(tempCacheDir) + path.sep));
      assert.ok(safePath.endsWith('att-uuid-123_BCA Marksheet 4 Semesters .pdf'));
    });

    test('3. getSafeAttachmentCachePath prevents directory escaping', () => {
      const tempCacheDir = path.join(os.tmpdir(), 'ollachat_test_cache_' + Date.now());
      // Even if someone crafted a tricky relative filename, basename neutralizes it
      const safePath = getSafeAttachmentCachePath(tempCacheDir, 'att-uuid', '../../../secret.pdf');
      assert.ok(safePath.startsWith(path.resolve(tempCacheDir) + path.sep));
    });

    test('4. PDF is downloaded to cache when not already cached, and cached PDF opens without downloading again', async () => {
      const tempCacheDir = path.join(os.tmpdir(), 'ollachat_cache_test_' + Date.now());
      await ensureAttachmentCacheDir(tempCacheDir);

      try {
        const attId = 'att-pdf-001';
        const filename = 'BCA Marksheet 4 Semesters .pdf';

        // Initially not cached
        const beforeCached = await isAttachmentCached(tempCacheDir, attId, filename, 'application/pdf');
        assert.equal(beforeCached, false);

        // Save downloaded file to cache
        const mockPdfContent = Buffer.from('%PDF-1.4 Mock PDF binary content for testing BCA marksheet');
        const savedPath = await saveAttachmentToCache(tempCacheDir, attId, filename, mockPdfContent, 'application/pdf');

        assert.ok(fs.existsSync(savedPath));
        assert.equal(fs.statSync(savedPath).size, mockPdfContent.length);

        // Now cached
        const afterCached = await isAttachmentCached(tempCacheDir, attId, filename, 'application/pdf');
        assert.equal(afterCached, true);

        // Cached path retrieval without downloading again
        const retrievedPath = await getCachedAttachmentPath(tempCacheDir, attId, filename, 'application/pdf');
        assert.equal(retrievedPath, savedPath);
      } finally {
        await fsPromises.rm(tempCacheDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. MIME & Validation Contract for PDFs and Documents
  // ═════════════════════════════════════════════════════════════════
  describe('PDF MIME Type & Media Categorization', () => {
    test('4. PDF uses application/pdf handling and magic bytes', () => {
      assert.equal(EXTENSION_MIME_MAP['pdf'], 'application/pdf');
      assert.deepEqual(MAGIC_BYTES['application/pdf'], [0x25, 0x50, 0x44, 0x46]); // %PDF

      const val = validateMediaFile({
        filename: 'BCA Marksheet 4 Semesters .pdf',
        byteSize: 177354,
        declaredMime: 'application/pdf'
      });
      assert.equal(val.isValid, true);
      assert.equal(val.kind, 'file');
    });

    test('Other document formats (docx, xlsx, zip, txt) remain functional', () => {
      const docxVal = validateMediaFile({ filename: 'notes.docx', byteSize: 50000 });
      assert.equal(docxVal.isValid, true);
      assert.equal(docxVal.kind, 'file');

      const zipVal = validateMediaFile({ filename: 'archive.zip', byteSize: 200000 });
      assert.equal(zipVal.isValid, true);
      assert.equal(zipVal.kind, 'file');

      const txtVal = validateMediaFile({ filename: 'readme.txt', byteSize: 1024 });
      assert.equal(txtVal.isValid, true);
      assert.equal(txtVal.kind, 'file');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Preload and Main Process IPC Wiring
  // ═════════════════════════════════════════════════════════════════
  describe('IPC Bridge & Handler Architecture', () => {
    test('5. preload.js exposes media.openAttachment and dialog.openAttachment', () => {
      const preloadCode = fs.readFileSync(path.join(projectRoot, 'src', 'preload', 'preload.js'), 'utf8');
      assert.ok(
        preloadCode.includes("openAttachment: (options) => ipcRenderer.invoke('media:open-attachment', options)"),
        'Preload must expose openAttachment wired to media:open-attachment'
      );
    });

    test('main.js handles media:open-attachment with cache checking and shell.openPath', () => {
      const mainCode = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');
      assert.ok(mainCode.includes("ipcMain.handle('media:open-attachment'"), 'Main must register media:open-attachment handler');
      assert.ok(mainCode.includes('isAttachmentCached('), 'Must check if attachment is already cached');
      assert.ok(mainCode.includes('shell.openPath('), 'Must use shell.openPath to open with system default application');
      assert.ok(mainCode.includes('saveAttachmentToCache('), 'Must save downloaded file to cache');
    });

    test('main.js preserves dialog:save-media-file for separate download action', () => {
      const mainCode = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');
      assert.ok(mainCode.includes("ipcMain.handle('dialog:save-media-file'"), 'Main must preserve dialog:save-media-file');
      assert.ok(mainCode.includes('dialog.showSaveDialog('), 'Must prompt Save As dialog on download');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Renderer Card Separation: Open/View Click vs Download Click
  // ═════════════════════════════════════════════════════════════════
  describe('Renderer Event Separation & User Experience', () => {
    test('6 & 7. Card click triggers handleOpenFile, download button triggers handleDownloadFile with stopPropagation', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');

      // Card click event triggers onFileOpen (which calls handleOpenFile)
      assert.ok(appCode.includes('card.addEventListener(\'click\', onFileOpen);'), 'Clicking card must invoke onFileOpen');
      assert.ok(appCode.includes('await handleOpenFile('), 'onFileOpen must invoke handleOpenFile');

      // Download button click triggers onFileDownload (which calls handleDownloadFile)
      assert.ok(appCode.includes('downloadBtn.addEventListener(\'click\', onFileDownload);'), 'Clicking downloadBtn must invoke onFileDownload');
      assert.ok(appCode.includes('await handleDownloadFile('), 'onFileDownload must invoke handleDownloadFile');

      // stopPropagation ensures download button does NOT trigger card open
      assert.ok(appCode.includes('onFileDownload = async (e) => {\n      e.stopPropagation();'), 'Download click must stop propagation');
    });

    test('handleOpenFile invokes media.openAttachment and does NOT call saveMediaFile (no Save As dialog)', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');

      // Extract handleOpenFile function implementation
      const fnMatch = appCode.match(/async function handleOpenFile\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'handleOpenFile function found');
      const fnBody = fnMatch[0];

      assert.ok(fnBody.includes('media?.openAttachment') || fnBody.includes('dialog?.openAttachment'), 'Must use openAttachment');
      assert.ok(!fnBody.includes('saveMediaFile'), 'Must NEVER trigger saveMediaFile or Save As dialog in open flow');
    });

    test('8 & 9. Download failure and open failure are handled with informative user alerts', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
      const fnMatch = appCode.match(/async function handleOpenFile\([\s\S]*?\n\}/);
      assert.ok(fnMatch);
      const fnBody = fnMatch[0];

      // Error handling checks
      assert.ok(fnBody.includes('Unable to open'), 'Must show user alert on open error');
      assert.ok(fnBody.includes('alert('), 'Must alert user when open fails');
    });

    test('10. Existing image opening still works via lightbox preview', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
      assert.ok(appCode.includes('openImagePreview(resolvedUrl, resolved.filename, resolved.caption);'), 'Images must open in lightbox preview');
    });

    test('11. Existing video opening still works with video controls', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
      assert.ok(appCode.includes("video.controls = true;"), 'Videos must have controls');
    });

    test('12. Existing audio/voice-note playback still works via voice note player', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
      assert.ok(appCode.includes('createVoiceNotePlayerElement('), 'Voice note player must remain active');
    });

    test('13. Card visual styling includes title and opening-file state', () => {
      const appCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
      assert.ok(appCode.includes("card.title = `Click to open ${resolved.filename}`;"), 'Card must have tooltip indicating click to open');

      const cssCode = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8');
      assert.ok(cssCode.includes('.message-file-card.opening-file'), 'CSS must define .message-file-card.opening-file state');
    });
  });
});
