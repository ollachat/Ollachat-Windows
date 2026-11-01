import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SINGLE_PUT_THRESHOLD = 10 * 1024 * 1024; // 10MB
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;    // 8MB default chunk size

/**
 * Determines whether an error is transient and eligible for retry.
 * 4xx errors (except 429) are considered permanent and fail immediately.
 * @param {Error|any} err
 * @returns {boolean}
 */
export function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const status = err.status || err.httpStatus;
  if (status) {
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  // Network connection drops, resets, DNS failures, fetch failed
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  if (
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('enotfound') ||
    code.includes('econnrefused') ||
    code.includes('pipe') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout')
  ) {
    return true;
  }
  return false;
}

/**
 * Executes an async operation with exponential backoff retry for transient errors.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.initialDelayMs=500]
 * @param {number} [options.maxDelayMs=5000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<T>}
 */
export async function executeWithRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const signal = options.signal;

  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      const err = new Error('Upload aborted by user');
      err.name = 'AbortError';
      throw err;
    }
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted) {
        const abortErr = new Error('Upload aborted by user');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (err.name === 'AbortError') {
        throw err;
      }
      if (!isTransientError(err) || attempt >= maxRetries) {
        throw err;
      }
      attempt++;
      const backoff = Math.min(initialDelayMs * Math.pow(3, attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * 200);
      const delay = backoff + jitter;

      await new Promise((resolve, reject) => {
        let timeout;
        const onAbort = () => {
          clearTimeout(timeout);
          const abortErr = new Error('Upload aborted by user');
          abortErr.name = 'AbortError';
          reject(abortErr);
        };
        timeout = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
}

/**
 * UploadManager handles bounded, resilient, resumable media uploads for OllaChat Windows.
 * Enforces bounded RAM consumption using file descriptor chunk reading,
 * tracks multipart progress and completed parts in SQLite,
 * provides exponential backoff for transient failures, and supports upload cancellation.
 */
export class UploadManager {
  /**
   * @param {object} options
   * @param {import('../chat-api.js').ChatApi} options.chatApi
   * @param {import('../storage/db/database-service.js').DatabaseService} [options.databaseService]
   * @param {number} [options.partSize=8388608] Default 8MB
   * @param {number} [options.singlePutThreshold=10485760] Default 10MB
   * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
   */
  constructor(options = {}) {
    if (!options.chatApi) {
      throw new Error('UploadManager requires chatApi');
    }
    this.chatApi = options.chatApi;
    this.databaseService = options.databaseService || null;
    this.partSize = options.partSize || MULTIPART_PART_SIZE;
    this.singlePutThreshold = options.singlePutThreshold || SINGLE_PUT_THRESHOLD;
    this.fetchFn = options.fetchFn || globalThis.fetch;

    /** @type {Map<string, { abortController: AbortController, sessionId: string, roomId: string }>} */
    this.activeUploads = new Map();
    /** @type {Set<string>} */
    this.cancelledSessionIds = new Set();
  }

  /**
   * Sets or updates database service reference (e.g. after database service initialized).
   * @param {import('../storage/db/database-service.js').DatabaseService} dbService
   */
  setDatabaseService(dbService) {
    this.databaseService = dbService;
  }

  /**
   * Reads a single bounded slice of a file from disk into a fresh Buffer.
   * Ensures the file handle is always closed, preventing file locking or memory leaks.
   * @param {string} filePath
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Buffer>}
   */
  async readChunkFromDisk(filePath, offset, length) {
    let handle = null;
    try {
      handle = await fsPromises.open(filePath, 'r');
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  /**
   * Generates a unique upload session identifier.
   * @returns {string}
   */
  generateSessionId() {
    return `up_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }

  /**
   * Normalizes MIME type for OllaCore backend compliance.
   * @param {string} filename
   * @param {string} mime
   * @returns {string}
   */
  normalizeMime(filename, mime) {
    const ext = (filename.split('.').pop() || '').toLowerCase().trim();
    let norm = (mime || '').toLowerCase().split(';')[0].trim();
    if (ext === 'webm' || norm === 'audio/webm' || norm === 'video/webm') {
      return 'video/webm';
    }
    if (ext === 'mp3' || norm === 'audio/mp3') {
      return 'audio/mpeg';
    }
    return norm || 'application/octet-stream';
  }

  /**
   * Cancels an active or pending upload session.
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, cancelled: boolean }>}
   */
  async cancelUpload(sessionId) {
    if (!sessionId) return { ok: false, cancelled: false };

    const active = this.activeUploads.get(sessionId);
    if (active) {
      active.abortController.abort();
    }

    if (this.databaseService) {
      try {
        await this.databaseService.updateUploadSession({
          id: sessionId,
          status: 'cancelled',
          errorMessage: 'Upload cancelled by user'
        });
      } catch (err) {
        console.warn(`[UploadManager] Failed to record cancellation in DB for ${sessionId}:`, err.message);
      }
    }

    return { ok: true, cancelled: true };
  }

  /**
   * Main entry point to upload a media file (single PUT or multipart).
   * @param {object} params
   * @param {string} params.roomToken
   * @param {string} params.roomId
   * @param {string} [params.filePath]
   * @param {Buffer|Uint8Array} [params.buffer]
   * @param {string} params.filename
   * @param {string} params.mime
   * @param {number} params.byteSize
   * @param {string} [params.kind]
   * @param {string} [params.sessionId]
   * @param {(progressInfo: { roomId: string, attachmentId: string, progress: number, filename: string, uploadedBytes: number, totalBytes: number }) => void} [params.onProgress]
   * @returns {Promise<{ ok: boolean, data?: object, error?: object }>}
   */
  async uploadMedia(params) {
    const {
      roomToken,
      roomId,
      filePath,
      buffer,
      filename,
      mime,
      byteSize,
      kind = 'document',
      onProgress
    } = params;

    if (!roomToken || !roomId) {
      throw new Error('roomToken and roomId are required for media upload');
    }
    if (!filePath && !buffer) {
      throw new Error('Either filePath or buffer must be provided');
    }
    const normalizedMime = this.normalizeMime(filename, mime);
    const size = typeof byteSize === 'number' && byteSize > 0
      ? byteSize
      : (buffer ? buffer.length : (await fsPromises.stat(filePath)).size);

    const isMultipart = size > this.singlePutThreshold;

    let recoverableSession = null;
    if (this.databaseService && filePath && isMultipart) {
      try {
        const pending = await this.databaseService.getPendingUploadSessions({ roomId });
        recoverableSession = pending.find(s =>
          s.filePath === filePath &&
          s.byteSize === size &&
          s.isMultipart &&
          s.attachmentId &&
          Array.isArray(s.partUrls) &&
          s.partUrls.length > 0 &&
          (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now() + 60000)
        );
      } catch (err) {
        console.warn(`[UploadManager] Recovery lookup error:`, err.message);
      }
    }

    const sessionId = recoverableSession ? recoverableSession.id : (params.sessionId || this.generateSessionId());
    const abortController = new AbortController();
    this.activeUploads.set(sessionId, { abortController, sessionId, roomId });
    if (this.cancelledSessionIds.has(sessionId)) {
      abortController.abort();
    }

    if (this.databaseService && !recoverableSession && !abortController.signal.aborted) {
      try {
        await this.databaseService.saveUploadSession({
          id: sessionId,
          roomId,
          filePath: filePath || '',
          filename,
          mimeType: mime,
          byteSize: size,
          isMultipart,
          status: 'pending'
        });
      } catch (err) {
        console.warn(`[UploadManager] DB save initial pending session warning:`, err.message);
      }
    }

    try {
      if (abortController.signal.aborted) {
        const err = new Error('Upload aborted by user');
        err.name = 'AbortError';
        throw err;
      }

      if (isMultipart) {
        return await this._uploadMultipart({
          sessionId,
          abortController,
          roomToken,
          roomId,
          filePath,
          buffer,
          filename,
          mime,
          normalizedMime,
          size,
          kind,
          onProgress,
          recoverableSession
        });
      } else {
        return await this._uploadSinglePut({
          sessionId,
          abortController,
          roomToken,
          roomId,
          filePath,
          buffer,
          filename,
          mime,
          normalizedMime,
          size,
          kind,
          onProgress
        });
      }
    } catch (err) {
      if (this.databaseService) {
        const isAbort = err.name === 'AbortError' || abortController.signal.aborted;
        await this.databaseService.updateUploadSession({
          id: sessionId,
          status: isAbort ? 'cancelled' : 'failed',
          errorMessage: err.message
        }).catch(() => {});
      }
      throw err;
    } finally {
      this.activeUploads.delete(sessionId);
      this.cancelledSessionIds.delete(sessionId);
    }
  }

  /**
   * Executes single PUT upload for files <= singlePutThreshold (10MB).
   * @private
   */
  async _uploadSinglePut(ctx) {
    const {
      sessionId,
      abortController,
      roomToken,
      roomId,
      filePath,
      buffer,
      filename,
      mime,
      normalizedMime,
      size,
      kind,
      onProgress
    } = ctx;

    const signal = abortController.signal;

    // 1. Initialize attachment metadata with backend
    const init = await this.chatApi.initAttachment(roomToken, roomId, {
      filename,
      mime: normalizedMime,
      byteSize: size
    });

    const attachmentId = init.attachmentId || init.attachment_id;
    const uploadUrl = init.uploadUrl || init.upload_url;
    if (!uploadUrl) {
      throw new Error('initAttachment did not return an uploadUrl');
    }

    // Persist session if DB is configured (DO NOT store roomToken or auth tokens!)
    if (this.databaseService && !signal.aborted) {
      try {
        await this.databaseService.saveUploadSession({
          id: sessionId,
          roomId,
          filePath: filePath || '',
          filename,
          mimeType: mime,
          byteSize: size,
          isMultipart: false,
          attachmentId,
          status: 'uploading'
        });
      } catch (err) {
        console.warn(`[UploadManager] DB save session warning:`, err.message);
      }
    }

    if (onProgress) {
      onProgress({ roomId, attachmentId, progress: 0.3, filename, uploadedBytes: Math.floor(size * 0.3), totalBytes: size });
    }

    // 2. Prepare headers
    const putHeaders = {};
    const reqHeaders = init.requiredHeaders || init.required_headers;
    if (Array.isArray(reqHeaders) && reqHeaders.length > 0) {
      for (const item of reqHeaders) {
        if (Array.isArray(item) && item.length >= 2) {
          putHeaders[item[0]] = item[1];
        } else if (item && typeof item === 'object') {
          if (item.name && item.value) {
            putHeaders[item.name] = item.value;
          } else {
            Object.assign(putHeaders, item);
          }
        }
      }
    } else if (reqHeaders && typeof reqHeaders === 'object') {
      Object.assign(putHeaders, reqHeaders);
    }
    if (!putHeaders['Content-Type'] && !putHeaders['content-type']) {
      putHeaders['Content-Type'] = normalizedMime || 'application/octet-stream';
    }

    // 3. Read payload boundedly
    const dataBuf = buffer || (await this.readChunkFromDisk(filePath, 0, size));

    // 4. Execute PUT with retry
    await executeWithRetry(async () => {
      const res = await this.fetchFn(uploadUrl, {
        method: 'PUT',
        headers: putHeaders,
        body: dataBuf,
        signal
      });
      if (!res.ok) {
        const err = new Error(`Single PUT upload failed with HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      return res;
    }, { signal });

    if (onProgress) {
      onProgress({ roomId, attachmentId, progress: 0.8, filename, uploadedBytes: Math.floor(size * 0.8), totalBytes: size });
    }

    // 5. Complete attachment
    await this.chatApi.completeAttachment(roomToken, roomId, attachmentId);

    // 6. Adaptive download URL polling
    const resolvedDownloadUrl = await this._pollDownloadUrl(roomToken, roomId, attachmentId);

    if (onProgress) {
      onProgress({ roomId, attachmentId, progress: 1.0, filename, uploadedBytes: size, totalBytes: size });
    }

    if (this.databaseService) {
      try {
        await this.databaseService.updateUploadSession({
          id: sessionId,
          status: 'completed'
        });
      } catch (err) {
        console.warn(`[UploadManager] DB update session warning:`, err.message);
      }
    }

    return {
      ok: true,
      data: {
        attachmentId,
        attachment_id: attachmentId,
        filename,
        mime,
        byteSize: size,
        byte_size: size,
        kind,
        downloadUrl: resolvedDownloadUrl,
        download_url: resolvedDownloadUrl
      }
    };
  }

  /**
   * Executes bounded, resumable multipart upload for files > singlePutThreshold (10MB).
   * Never loads full file into memory. Reads 1 chunk at a time from disk.
   * Records completed parts in SQLite so interruptions can resume without re-uploading parts.
   * @private
   */
  async _uploadMultipart(ctx) {
    const {
      sessionId,
      abortController,
      roomToken,
      roomId,
      filePath,
      buffer,
      filename,
      mime,
      normalizedMime,
      size,
      kind,
      onProgress,
      recoverableSession
    } = ctx;

    const signal = abortController.signal;
    let attachmentId = '';
    let uploadId = '';
    let partUrls = [];
    let partSize = this.partSize;
    let totalParts = Math.ceil(size / partSize);
    let completedParts = [];

    // 1. Check for recoverable existing session if DB is active and filePath exists
    let existingSession = recoverableSession || null;
    if (!existingSession && this.databaseService && filePath) {
      try {
        const pending = await this.databaseService.getPendingUploadSessions({ roomId });
        existingSession = pending.find(s =>
          s.filePath === filePath &&
          s.byteSize === size &&
          s.isMultipart &&
          s.attachmentId &&
          Array.isArray(s.partUrls) &&
          s.partUrls.length > 0
        );
        if (existingSession) {
          // Verify presigned URLs are not expired (if expiresAt given)
          if (existingSession.expiresAt) {
            const expTime = new Date(existingSession.expiresAt).getTime();
            if (expTime <= Date.now() + 60000) {
              existingSession = null; // Expired, start fresh
            }
          }
        }
      } catch (err) {
        console.warn(`[UploadManager] Recovery lookup error:`, err.message);
      }
    }

    if (existingSession && existingSession.attachmentId && existingSession.partUrls?.length > 0) {
      attachmentId = existingSession.attachmentId;
      uploadId = existingSession.uploadId;
      partUrls = existingSession.partUrls;
      partSize = existingSession.partSize || this.partSize;
      totalParts = existingSession.totalParts || partUrls.length;
      completedParts = Array.isArray(existingSession.completedParts) ? [...existingSession.completedParts] : [];
    } else {
      // 2. Initialize fresh multipart upload with backend
      const init = await this.chatApi.initMultipartUpload(roomToken, roomId, {
        filename,
        mime: normalizedMime,
        byteSize: size,
        partSize: this.partSize
      });

      attachmentId = init.attachmentId || init.attachment_id;
      uploadId = init.uploadId || init.upload_id || null;
      partUrls = init.partUrls || init.part_urls || [];
      partSize = init.partSize || init.part_size || this.partSize;
      totalParts = partUrls.length;
      completedParts = [];

      if (!attachmentId || partUrls.length === 0) {
        throw new Error('initMultipartUpload returned invalid attachmentId or empty partUrls');
      }

      // Persist new session in SQLite (NO auth tokens!)
      if (this.databaseService && !signal.aborted) {
        try {
          await this.databaseService.saveUploadSession({
            id: sessionId,
            roomId,
            filePath: filePath || '',
            filename,
            mimeType: mime,
            byteSize: size,
            isMultipart: true,
            attachmentId,
            uploadId,
            partSize,
            totalParts,
            partUrls,
            completedParts: [],
            status: 'uploading',
            expiresAt: init.expiresAt || init.expires_at || null
          });
        } catch (err) {
          console.warn(`[UploadManager] Failed to persist initial upload session:`, err.message);
        }
      }
    }

    // Create lookup of already completed part numbers to resume seamlessly
    const completedMap = new Map();
    for (const p of completedParts) {
      completedMap.set(p.partNumber, p.etag);
    }

    if (onProgress) {
      const initialBytes = completedParts.length * partSize;
      const initialProg = totalParts > 0 ? (completedParts.length / totalParts) * 0.9 : 0.05;
      onProgress({
        roomId,
        attachmentId,
        progress: Math.min(initialProg, 0.9),
        filename,
        uploadedBytes: initialBytes,
        totalBytes: size
      });
    }

    // 3. Upload parts sequentially with bounded memory reading
    for (let i = 0; i < partUrls.length; i++) {
      const partNumber = i + 1;

      // Skip already completed parts when resuming
      if (completedMap.has(partNumber)) {
        continue;
      }

      if (signal.aborted) {
        const err = new Error('Upload aborted by user');
        err.name = 'AbortError';
        throw err;
      }

      const start = i * partSize;
      const end = Math.min(start + partSize, size);
      const chunkLength = end - start;
      const partUrl = partUrls[i];

      // Read ONLY this chunk from disk into RAM (bounded memory usage)
      let chunk;
      if (buffer) {
        chunk = buffer.subarray(start, end);
      } else {
        chunk = await this.readChunkFromDisk(filePath, start, chunkLength);
      }

      // Upload chunk with exponential backoff retry for transient network/server failures
      const etag = await executeWithRetry(async () => {
        const putRes = await this.fetchFn(partUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(chunkLength)
          },
          body: chunk,
          signal
        });
        if (!putRes.ok) {
          const err = new Error(`Part ${partNumber} upload failed with HTTP ${putRes.status}`);
          err.httpStatus = putRes.status;
          throw err;
        }
        const rawEtag = putRes.headers.get('ETag') || `"${partNumber}"`;
        return rawEtag.replace(/['"]/g, '');
      }, { signal });

      // Unreference chunk buffer so GC can reclaim it immediately
      chunk = null;

      // Update completed parts
      completedParts.push({ partNumber, etag });
      completedMap.set(partNumber, etag);

      // Persist progress to SQLite
      if (this.databaseService) {
        try {
          await this.databaseService.updateUploadSession({
            id: sessionId,
            completedParts
          });
        } catch (err) {
          console.warn(`[UploadManager] DB update completed parts error:`, err.message);
        }
      }

      if (onProgress) {
        const prog = 0.05 + 0.85 * (completedParts.length / totalParts);
        const uploadedBytes = Math.min(completedParts.length * partSize, size);
        onProgress({
          roomId,
          attachmentId,
          progress: Number(prog.toFixed(3)),
          filename,
          uploadedBytes,
          totalBytes: size
        });
      }
    }

    // Sort parts strictly in ascending partNumber order for backend S3/GCS contract
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    // 4. Complete multipart upload
    await this.chatApi.completeMultipartUpload(roomToken, roomId, attachmentId, completedParts);

    // 5. Adaptive download URL polling
    const resolvedDownloadUrl = await this._pollDownloadUrl(roomToken, roomId, attachmentId);

    if (onProgress) {
      onProgress({
        roomId,
        attachmentId,
        progress: 1.0,
        filename,
        uploadedBytes: size,
        totalBytes: size
      });
    }

    // Mark session completed
    if (this.databaseService) {
      try {
        await this.databaseService.updateUploadSession({
          id: sessionId,
          status: 'completed'
        });
      } catch (err) {
        console.warn(`[UploadManager] DB update completed status error:`, err.message);
      }
    }

    return {
      ok: true,
      data: {
        attachmentId,
        attachment_id: attachmentId,
        filename,
        mime,
        byteSize: size,
        byte_size: size,
        kind,
        downloadUrl: resolvedDownloadUrl,
        download_url: resolvedDownloadUrl
      }
    };
  }

  /**
   * Polls downloadAttachment adaptively until backend has finalized the attachment.
   * @private
   */
  async _pollDownloadUrl(roomToken, roomId, attachmentId) {
    let resolvedDownloadUrl = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const dl = await this.chatApi.downloadAttachment(roomToken, roomId, attachmentId);
        const u = dl?.downloadUrl || dl?.download_url;
        if (u) {
          resolvedDownloadUrl = u;
          break;
        }
      } catch {}
      const delayMs = Math.min(50 + attempt * 50, 350);
      await new Promise(r => setTimeout(r, delayMs));
    }
    return resolvedDownloadUrl;
  }
}
