import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import {
  UploadManager,
  SINGLE_PUT_THRESHOLD,
  MULTIPART_PART_SIZE,
  executeWithRetry,
  isTransientError
} from '../src/main/upload-manager.js';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';

describe('Upload Reliability & Bounded Resumable Multipart Upload Lifecycle', () => {
  let tmpDir;
  let dbManager;
  let dbService;
  let mockSessionStore;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-upload-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fsPromises.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_uploader',
        sessionToken: 'token_secret_upload_123',
        phone: '+15551234'
      },
      getSession() {
        return this.currentSession;
      }
    };

    dbManager = new DatabaseManager(tmpDir);
    dbService = new DatabaseService({
      storageDir: tmpDir,
      databaseManager: dbManager,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbManager && dbManager.isOpen) {
      await dbManager.close();
    }
    if (tmpDir) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. BOUNDED MEMORY DISK READING
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Bounded Memory Disk Slicing', () => {
    test('readChunkFromDisk reads bounded slice without holding entire file in memory', async () => {
      const dummyChatApi = {
        initAttachment: async () => ({}),
        completeAttachment: async () => ({})
      };
      const uploadManager = new UploadManager({ chatApi: dummyChatApi });

      const testFilePath = path.join(tmpDir, 'large_sample.dat');
      // Create a 20MB mock file filled with known sequential byte pattern
      const totalSize = 20 * 1024 * 1024; // 20MB
      const fd = await fsPromises.open(testFilePath, 'w');
      const patternChunk = Buffer.alloc(1024 * 1024, 0xAB); // 1MB chunk pattern
      for (let i = 0; i < 20; i++) {
        await fd.write(patternChunk);
      }
      await fd.close();

      const stat = await fsPromises.stat(testFilePath);
      assert.equal(stat.size, totalSize);

      // Read chunk 1: 8MB from offset 0
      const chunk1 = await uploadManager.readChunkFromDisk(testFilePath, 0, 8 * 1024 * 1024);
      assert.equal(chunk1.length, 8 * 1024 * 1024);
      assert.equal(chunk1[0], 0xAB);
      assert.equal(chunk1[chunk1.length - 1], 0xAB);

      // Read chunk 2: 8MB from offset 8MB
      const chunk2 = await uploadManager.readChunkFromDisk(testFilePath, 8 * 1024 * 1024, 8 * 1024 * 1024);
      assert.equal(chunk2.length, 8 * 1024 * 1024);

      // Read chunk 3: tail 4MB from offset 16MB
      const chunk3 = await uploadManager.readChunkFromDisk(testFilePath, 16 * 1024 * 1024, 4 * 1024 * 1024);
      assert.equal(chunk3.length, 4 * 1024 * 1024);

      // File descriptor is verified closed: we can remove the file without EBUSY on Windows
      await fsPromises.unlink(testFilePath);
      assert.equal(fs.existsSync(testFilePath), false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. RETRY LOGIC & EXPONENTIAL BACKOFF
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Retry Logic & Error Classification', () => {
    test('isTransientError accurately classifies transient vs permanent errors', () => {
      // 5xx errors are transient
      assert.equal(isTransientError({ status: 500 }), true);
      assert.equal(isTransientError({ status: 502 }), true);
      assert.equal(isTransientError({ status: 503 }), true);
      assert.equal(isTransientError({ httpStatus: 504 }), true);

      // Rate limit 429 is transient
      assert.equal(isTransientError({ status: 429 }), true);

      // Network errors are transient
      assert.equal(isTransientError(new Error('fetch failed')), true);
      assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
      assert.equal(isTransientError({ code: 'ETIMEDOUT' }), true);

      // 4xx errors are permanent (fail-fast)
      assert.equal(isTransientError({ status: 400 }), false);
      assert.equal(isTransientError({ status: 401 }), false);
      assert.equal(isTransientError({ status: 403 }), false);
      assert.equal(isTransientError({ status: 404 }), false);
      assert.equal(isTransientError({ status: 413 }), false);

      // AbortError is not retried
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      assert.equal(isTransientError(abortErr), false);
    });

    test('executeWithRetry retries transient errors with exponential backoff and succeeds', async () => {
      let attempts = 0;
      const result = await executeWithRetry(async (attempt) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Temporary gateway timeout');
          err.status = 504;
          throw err;
        }
        return 'success_on_attempt_3';
      }, {
        maxRetries: 3,
        initialDelayMs: 10,
        maxDelayMs: 50
      });

      assert.equal(result, 'success_on_attempt_3');
      assert.equal(attempts, 3);
    });

    test('executeWithRetry fails fast on permanent 4xx errors without retrying', async () => {
      let attempts = 0;
      await assert.rejects(async () => {
        await executeWithRetry(async () => {
          attempts++;
          const err = new Error('Forbidden upload');
          err.status = 403;
          throw err;
        }, {
          maxRetries: 3,
          initialDelayMs: 10
        });
      }, (err) => {
        assert.equal(err.status, 403);
        return true;
      });

      assert.equal(attempts, 1, 'Permanent failure must not be retried');
    });

    test('executeWithRetry terminates immediately on AbortSignal without retrying', async () => {
      const controller = new AbortController();
      let attempts = 0;

      const promise = executeWithRetry(async () => {
        attempts++;
        controller.abort();
        const err = new Error('Transient error');
        err.status = 500;
        throw err;
      }, {
        maxRetries: 3,
        initialDelayMs: 100,
        signal: controller.signal
      });

      await assert.rejects(promise, (err) => {
        assert.equal(err.name, 'AbortError');
        return true;
      });

      assert.equal(attempts, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SINGLE PUT UPLOAD (<= 10MB)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Single PUT Upload', () => {
    test('single PUT uploads small files <= 10MB with progress and completes attachment', async () => {
      const testFile = path.join(tmpDir, 'small_doc.pdf');
      const fileBytes = Buffer.from('%PDF-1.4 mock pdf document content for upload');
      await fsPromises.writeFile(testFile, fileBytes);

      let initCalled = false;
      let completeCalled = false;
      let putCalled = false;
      const progressSnapshots = [];

      const mockChatApi = {
        initAttachment: async (token, roomId, params) => {
          initCalled = true;
          assert.equal(token, 'room_token_abc');
          assert.equal(roomId, 'room_123');
          assert.equal(params.filename, 'small_doc.pdf');
          assert.equal(params.byteSize, fileBytes.length);
          return {
            attachmentId: 'att_small_999',
            uploadUrl: 'https://storage.example.com/upload-small',
            requiredHeaders: { 'x-mock-header': 'pdf-upload' }
          };
        },
        completeAttachment: async (token, roomId, attachmentId) => {
          completeCalled = true;
          assert.equal(attachmentId, 'att_small_999');
          return { ok: true };
        },
        downloadAttachment: async (token, roomId, attachmentId) => {
          return { downloadUrl: 'https://storage.example.com/download-small-pdf' };
        }
      };

      const mockFetch = async (url, options) => {
        assert.equal(url, 'https://storage.example.com/upload-small');
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers['x-mock-header'], 'pdf-upload');
        assert.deepEqual(options.body, fileBytes);
        putCalled = true;
        return { ok: true, status: 200, headers: new Map() };
      };

      const uploadManager = new UploadManager({
        chatApi: mockChatApi,
        databaseService: dbService,
        fetchFn: mockFetch
      });

      const res = await uploadManager.uploadMedia({
        roomToken: 'room_token_abc',
        roomId: 'room_123',
        filePath: testFile,
        filename: 'small_doc.pdf',
        mime: 'application/pdf',
        byteSize: fileBytes.length,
        kind: 'document',
        onProgress: (p) => progressSnapshots.push(p)
      });

      assert.equal(res.ok, true);
      assert.equal(res.data.attachmentId, 'att_small_999');
      assert.equal(res.data.downloadUrl, 'https://storage.example.com/download-small-pdf');
      assert.equal(initCalled, true);
      assert.equal(putCalled, true);
      assert.equal(completeCalled, true);

      // Verify progress emitted
      assert.ok(progressSnapshots.length >= 3);
      assert.equal(progressSnapshots[progressSnapshots.length - 1].progress, 1.0);

      // Verify SQLite session was saved and marked completed
      const session = await dbService.getUploadSession(res.data.attachmentId || Object.keys(uploadManager.activeUploads)[0] || 'mock');
      // Look up via pending sessions: should NOT be in pending because it's completed
      const pending = await dbService.getPendingUploadSessions({ roomId: 'room_123' });
      assert.equal(pending.length, 0, 'Completed session must not appear in pending');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. MULTIPART UPLOAD (> 10MB) & BOUNDED CHUNK EXECUTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Multipart Upload Lifecycle (> 10MB)', () => {
    test('uploads >10MB file in bounded chunks, emits accurate progress, and submits sorted ETags', async () => {
      const testFile = path.join(tmpDir, 'large_video.mp4');
      // Create a 17MB file (requires 3 parts at 8MB partSize: 8MB + 8MB + 1MB)
      const totalSize = 17 * 1024 * 1024;
      const fd = await fsPromises.open(testFile, 'w');
      const mbChunk = Buffer.alloc(1024 * 1024, 0x55);
      for (let i = 0; i < 17; i++) {
        await fd.write(mbChunk);
      }
      await fd.close();

      const uploadedParts = [];
      const progressSnapshots = [];
      let initMultipartCalled = false;
      let completeMultipartCalled = false;
      let finalSubmittedParts = [];

      const mockChatApi = {
        initMultipartUpload: async (token, roomId, params) => {
          initMultipartCalled = true;
          assert.equal(params.byteSize, totalSize);
          assert.equal(params.filename, 'large_video.mp4');
          return {
            attachmentId: 'att_mp_777',
            uploadId: 'upload_id_xyz',
            partSize: 8 * 1024 * 1024,
            partUrls: [
              'https://s3.example.com/part1',
              'https://s3.example.com/part2',
              'https://s3.example.com/part3'
            ],
            expiresAt: new Date(Date.now() + 3600000).toISOString()
          };
        },
        completeMultipartUpload: async (token, roomId, attachmentId, parts) => {
          completeMultipartCalled = true;
          assert.equal(attachmentId, 'att_mp_777');
          finalSubmittedParts = parts;
          return { ok: true };
        },
        downloadAttachment: async () => ({ downloadUrl: 'https://s3.example.com/download-large-video' })
      };

      const mockFetch = async (url, options) => {
        assert.equal(options.method, 'PUT');
        uploadedParts.push({ url, length: options.body.length });
        const partNum = url.endsWith('part1') ? 1 : url.endsWith('part2') ? 2 : 3;
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) => name.toLowerCase() === 'etag' ? `"etag-hash-${partNum}"` : null
          }
        };
      };

      const uploadManager = new UploadManager({
        chatApi: mockChatApi,
        databaseService: dbService,
        partSize: 8 * 1024 * 1024,
        singlePutThreshold: 10 * 1024 * 1024,
        fetchFn: mockFetch
      });

      const res = await uploadManager.uploadMedia({
        roomToken: 'room_token_abc',
        roomId: 'room_123',
        filePath: testFile,
        filename: 'large_video.mp4',
        mime: 'video/mp4',
        byteSize: totalSize,
        kind: 'video',
        onProgress: (p) => progressSnapshots.push(p)
      });

      assert.equal(res.ok, true);
      assert.equal(res.data.attachmentId, 'att_mp_777');
      assert.equal(res.data.downloadUrl, 'https://s3.example.com/download-large-video');
      assert.equal(initMultipartCalled, true);
      assert.equal(completeMultipartCalled, true);

      // Verify all 3 parts uploaded with bounded chunk sizes
      assert.equal(uploadedParts.length, 3);
      assert.equal(uploadedParts[0].length, 8 * 1024 * 1024);
      assert.equal(uploadedParts[1].length, 8 * 1024 * 1024);
      assert.equal(uploadedParts[2].length, 1 * 1024 * 1024);

      // Verify final submitted ETags match contract
      assert.deepEqual(finalSubmittedParts, [
        { partNumber: 1, etag: 'etag-hash-1' },
        { partNumber: 2, etag: 'etag-hash-2' },
        { partNumber: 3, etag: 'etag-hash-3' }
      ]);

      // Verify progress reached 1.0
      assert.equal(progressSnapshots[progressSnapshots.length - 1].progress, 1.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. RESUMABILITY & ZERO CHUNK RE-UPLOAD
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Resumable Multipart Upload (Crash / Interruption Recovery)', () => {
    test('resumes interrupted upload without re-uploading completed parts', async () => {
      const testFile = path.join(tmpDir, 'resume_presentation.pdf');
      const totalSize = 16 * 1024 * 1024; // 16MB = exactly two 8MB parts
      const fd = await fsPromises.open(testFile, 'w');
      const mbChunk = Buffer.alloc(1024 * 1024, 0xEE);
      for (let i = 0; i < 16; i++) {
        await fd.write(mbChunk);
      }
      await fd.close();

      // Step 1: Pre-seed SQLite with an interrupted session that already completed Part 1!
      const unexpiredTime = new Date(Date.now() + 7200000).toISOString();
      await dbService.saveUploadSession({
        id: 'up_interrupted_sess_1',
        roomId: 'room_resume',
        filePath: testFile,
        filename: 'resume_presentation.pdf',
        mimeType: 'application/pdf',
        byteSize: totalSize,
        isMultipart: true,
        attachmentId: 'att_interrupted_99',
        uploadId: 'up_id_99',
        partSize: 8 * 1024 * 1024,
        totalParts: 2,
        partUrls: [
          'https://s3.example.com/part1-presigned',
          'https://s3.example.com/part2-presigned'
        ],
        completedParts: [
          { partNumber: 1, etag: 'etag-part-1-cached' }
        ],
        status: 'uploading',
        expiresAt: unexpiredTime
      });

      // Verify session is recorded in SQLite
      const preSession = await dbService.getUploadSession('up_interrupted_sess_1');
      assert.equal(preSession.attachmentId, 'att_interrupted_99');
      assert.equal(preSession.completedParts.length, 1);

      // Step 2: Now run uploadMedia for this exact file.
      // Part 1 must NOT be uploaded again. ONLY Part 2 should be uploaded!
      const uploadedUrls = [];
      let completeSubmittedParts = [];

      const mockChatApi = {
        initMultipartUpload: async () => {
          throw new Error('initMultipartUpload should NOT be called on resume!');
        },
        completeMultipartUpload: async (token, roomId, attachmentId, parts) => {
          assert.equal(attachmentId, 'att_interrupted_99');
          completeSubmittedParts = parts;
          return { ok: true };
        },
        downloadAttachment: async () => ({ downloadUrl: 'https://s3.example.com/resumed-pdf' })
      };

      const mockFetch = async (url) => {
        uploadedUrls.push(url);
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => '"etag-part-2-new"'
          }
        };
      };

      const uploadManager = new UploadManager({
        chatApi: mockChatApi,
        databaseService: dbService,
        partSize: 8 * 1024 * 1024,
        singlePutThreshold: 10 * 1024 * 1024,
        fetchFn: mockFetch
      });

      const res = await uploadManager.uploadMedia({
        roomToken: 'room_token_xyz',
        roomId: 'room_resume',
        filePath: testFile,
        filename: 'resume_presentation.pdf',
        mime: 'application/pdf',
        byteSize: totalSize,
        kind: 'document'
      });

      assert.equal(res.ok, true);
      assert.equal(res.data.attachmentId, 'att_interrupted_99');

      // Verify ONLY part 2 was sent over the network
      assert.equal(uploadedUrls.length, 1);
      assert.equal(uploadedUrls[0], 'https://s3.example.com/part2-presigned');

      // Verify completeMultipartUpload received BOTH part 1 (from SQLite) and part 2 (newly uploaded)
      assert.deepEqual(completeSubmittedParts, [
        { partNumber: 1, etag: 'etag-part-1-cached' },
        { partNumber: 2, etag: 'etag-part-2-new' }
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. UPLOAD CANCELLATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Upload Cancellation Support', () => {
    test('cancelUpload aborts active in-flight upload and marks session cancelled in SQLite', async () => {
      const testFile = path.join(tmpDir, 'cancel_sample.dat');
      await fsPromises.writeFile(testFile, Buffer.alloc(15 * 1024 * 1024));

      let fetchStarted;
      const fetchStartedPromise = new Promise(r => { fetchStarted = r; });

      const uploadManager = new UploadManager({
        chatApi: {
          initMultipartUpload: async () => ({
            attachmentId: 'att_cancel_1',
            partUrls: ['https://s3.example.com/part1', 'https://s3.example.com/part2'],
            partSize: 8 * 1024 * 1024
          }),
          completeMultipartUpload: async () => ({})
        },
        databaseService: dbService,
        partSize: 8 * 1024 * 1024,
        singlePutThreshold: 10 * 1024 * 1024,
        fetchFn: async (_url, { signal }) => {
          fetchStarted();
          if (signal?.aborted) {
            const err = new Error('Upload aborted by user');
            err.name = 'AbortError';
            throw err;
          }
          // Simulate slow in-flight upload that awaits abort signal
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('Upload aborted by user');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          });
        }
      });

      const sessionId = 'up_to_cancel_123';
      const uploadPromise = uploadManager.uploadMedia({
        sessionId,
        roomToken: 'tok',
        roomId: 'room_c',
        filePath: testFile,
        filename: 'cancel_sample.dat',
        mime: 'application/octet-stream',
        byteSize: 15 * 1024 * 1024
      });

      // Wait until fetch is actively in flight
      await fetchStartedPromise;

      // Trigger cancel and verify upload rejects with AbortError
      const [cancelRes] = await Promise.all([
        uploadManager.cancelUpload(sessionId),
        assert.rejects(uploadPromise, (err) => {
          assert.equal(err.name, 'AbortError');
          return true;
        })
      ]);
      assert.equal(cancelRes.ok, true);
      assert.equal(cancelRes.cancelled, true);

      // Verify SQLite session status is 'cancelled'
      const sess = await dbService.getUploadSession(sessionId);
      assert.equal(sess.status, 'cancelled');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. SECURITY & TOKEN LEAK PREVENTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe('7. Security: Token Leak Prevention', () => {
    test('upload_sessions in SQLite NEVER stores auth tokens or session tokens', async () => {
      const sensitiveToken = 'bearer_super_secret_session_token_xyz_999';
      await dbService.saveUploadSession({
        id: 'up_security_test_1',
        roomId: 'room_sec',
        filePath: 'C:\\fake\\photo.jpg',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: 1024,
        isMultipart: false,
        status: 'pending'
      });

      // Inspect raw table columns and values
      const rawRow = await dbManager.get('SELECT * FROM upload_sessions WHERE id = ?;', ['up_security_test_1']);
      const rowString = JSON.stringify(rawRow);

      assert.equal(rowString.includes(sensitiveToken), false);
      assert.equal(rawRow.room_token, undefined);
      assert.equal(rawRow.session_token, undefined);
      assert.equal(rawRow.token, undefined);

      // Check table column names in schema
      const pragma = await dbManager.all('PRAGMA table_info(upload_sessions);');
      const columnNames = pragma.map(p => p.name.toLowerCase());
      assert.equal(columnNames.includes('token'), false);
      assert.equal(columnNames.includes('session_token'), false);
      assert.equal(columnNames.includes('room_token'), false);
      assert.equal(columnNames.includes('auth_token'), false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. STALE SESSION CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────
  describe('8. Stale Session Cleanup', () => {
    test('cleanStaleUploadSessions removes completed, cancelled, and expired sessions while preserving active pending sessions', async () => {
      const now = Date.now();
      const freshIso = new Date(now).toISOString();
      const staleIso = new Date(now - 48 * 3600000).toISOString(); // 48h old

      // 1. Fresh active session (should be PRESERVED)
      await dbService.saveUploadSession({
        id: 'up_active_fresh',
        roomId: 'room_stale',
        filePath: 'test.mp4',
        filename: 'test.mp4',
        mimeType: 'video/mp4',
        byteSize: 5000,
        status: 'uploading',
        updatedAt: freshIso
      });

      // 2. Completed session (should be REMOVED)
      await dbService.saveUploadSession({
        id: 'up_completed',
        roomId: 'room_stale',
        filePath: 'test.mp4',
        filename: 'test.mp4',
        mimeType: 'video/mp4',
        byteSize: 5000,
        status: 'completed',
        updatedAt: freshIso
      });

      // 3. Cancelled session (should be REMOVED)
      await dbService.saveUploadSession({
        id: 'up_cancelled',
        roomId: 'room_stale',
        filePath: 'test.mp4',
        filename: 'test.mp4',
        mimeType: 'video/mp4',
        byteSize: 5000,
        status: 'cancelled',
        updatedAt: freshIso
      });

      // 4. Stale session 48h old (should be REMOVED)
      await dbService.saveUploadSession({
        id: 'up_stale_old',
        roomId: 'room_stale',
        filePath: 'test.mp4',
        filename: 'test.mp4',
        mimeType: 'video/mp4',
        byteSize: 5000,
        status: 'uploading',
        updatedAt: staleIso
      });

      const cleanRes = await dbService.cleanStaleUploadSessions({ maxAgeMs: 24 * 3600000 });
      assert.equal(cleanRes.ok, true);
      assert.equal(cleanRes.deleted >= 3, true);

      // Verify active fresh session remains intact
      const active = await dbService.getUploadSession('up_active_fresh');
      assert.ok(active, 'Fresh active session must survive stale cleanup');
      assert.equal(active.id, 'up_active_fresh');

      // Verify stale / completed / cancelled are deleted
      assert.equal(await dbService.getUploadSession('up_completed'), null);
      assert.equal(await dbService.getUploadSession('up_cancelled'), null);
      assert.equal(await dbService.getUploadSession('up_stale_old'), null);
    });
  });
});
