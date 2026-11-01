import fsPromises from 'node:fs/promises';
import path from 'node:path';

/**
 * Sanitizes an attachment filename ensuring safety against path traversal
 * and illegal Windows filesystem characters.
 * Preserves file extension (such as .pdf).
 *
 * @param {string} filename Original filename
 * @param {string} [fallbackExt=''] Fallback extension if filename has none
 * @returns {string} Safe filename
 */
export function sanitizeAttachmentFilename(filename, fallbackExt = '') {
  if (typeof filename !== 'string' || !filename.trim()) {
    const ext = fallbackExt ? (fallbackExt.startsWith('.') ? fallbackExt : `.${fallbackExt}`) : '';
    return `attachment_${Date.now()}${ext}`;
  }

  // Extract base filename (strips any directory traversal components)
  const base = path.basename(filename.trim());

  // Replace invalid Windows filename characters: < > : " / \ | ? * and control chars
  let sanitized = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();

  // If sanitization resulted in empty string or only dots
  if (!sanitized || /^\.+$/.test(sanitized)) {
    sanitized = `attachment_${Date.now()}`;
  }

  // Preserve or append extension if missing
  if (fallbackExt && !path.extname(sanitized)) {
    const ext = fallbackExt.startsWith('.') ? fallbackExt : `.${fallbackExt}`;
    sanitized += ext;
  }

  return sanitized;
}

/**
 * Generates an absolute, secure local cache path for an attachment inside cacheDir.
 * Enforces strict boundary verification to prevent directory traversal.
 *
 * @param {string} cacheDir Path to cache directory
 * @param {string|null} attachmentId Attachment UUID/ID
 * @param {string} filename Original filename
 * @param {string} [mime=''] MIME type (e.g. 'application/pdf')
 * @returns {string} Absolute resolved file path
 * @throws {Error} If path traversal or invalid path is detected
 */
export function getSafeAttachmentCachePath(cacheDir, attachmentId, filename, mime = '') {
  if (!cacheDir || typeof cacheDir !== 'string') {
    throw new Error('cacheDir is required');
  }

  let fallbackExt = '';
  if (mime === 'application/pdf' || (!filename && mime?.includes('pdf'))) {
    fallbackExt = '.pdf';
  }

  const safeFilename = sanitizeAttachmentFilename(filename, fallbackExt);
  const safeId = (attachmentId || 'doc').replace(/[^a-zA-Z0-9_-]/g, '');
  const finalFilename = `${safeId}_${safeFilename}`;
  const targetPath = path.join(cacheDir, finalFilename);

  // Security: Guarantee path is strictly inside cacheDir
  const resolvedTarget = path.resolve(targetPath);
  const resolvedCache = path.resolve(cacheDir);

  if (!resolvedTarget.startsWith(resolvedCache + path.sep) && resolvedTarget !== resolvedCache) {
    throw new Error('Invalid path traversal detected in attachment cache path');
  }

  return resolvedTarget;
}

/**
 * Ensures the attachment cache directory exists.
 * @param {string} cacheDir
 * @returns {Promise<void>}
 */
export async function ensureAttachmentCacheDir(cacheDir) {
  if (!cacheDir) return;
  await fsPromises.mkdir(cacheDir, { recursive: true });
}

/**
 * Checks if an attachment is already cached and non-empty.
 * @param {string} cacheDir
 * @param {string|null} attachmentId
 * @param {string} filename
 * @param {string} [mime='']
 * @returns {Promise<boolean>}
 */
export async function isAttachmentCached(cacheDir, attachmentId, filename, mime = '') {
  try {
    const targetPath = getSafeAttachmentCachePath(cacheDir, attachmentId, filename, mime);
    const stat = await fsPromises.stat(targetPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Retrieves the cached path if the file exists and is non-empty, or null.
 * @param {string} cacheDir
 * @param {string|null} attachmentId
 * @param {string} filename
 * @param {string} [mime='']
 * @returns {Promise<string|null>}
 */
export async function getCachedAttachmentPath(cacheDir, attachmentId, filename, mime = '') {
  const cached = await isAttachmentCached(cacheDir, attachmentId, filename, mime);
  if (!cached) return null;
  return getSafeAttachmentCachePath(cacheDir, attachmentId, filename, mime);
}

/**
 * Saves downloaded binary attachment data atomically into cacheDir.
 * @param {string} cacheDir
 * @param {string|null} attachmentId
 * @param {string} filename
 * @param {Buffer|Uint8Array} dataBuffer
 * @param {string} [mime='']
 * @returns {Promise<string>} Cached file path
 */
export async function saveAttachmentToCache(cacheDir, attachmentId, filename, dataBuffer, mime = '') {
  await ensureAttachmentCacheDir(cacheDir);
  const targetPath = getSafeAttachmentCachePath(cacheDir, attachmentId, filename, mime);
  const tempPath = `${targetPath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await fsPromises.writeFile(tempPath, Buffer.from(dataBuffer));
  await fsPromises.rename(tempPath, targetPath);
  return targetPath;
}

/**
 * Safely deletes cached attachment files matching the given attachment IDs.
 * Strictly verifies that all files reside within cacheDir to prevent directory traversal.
 * Never throws if a candidate file does not exist or has already been deleted.
 *
 * @param {string} cacheDir Path to attachment cache directory
 * @param {string[]|Set<string>} attachmentIds Array or Set of attachment IDs to delete
 * @returns {Promise<{ deletedCount: number, deletedFiles: string[] }>}
 */
export async function deleteCachedAttachments(cacheDir, attachmentIds) {
  if (!cacheDir || typeof cacheDir !== 'string') {
    throw new Error('cacheDir is required');
  }

  const ids = Array.isArray(attachmentIds)
    ? attachmentIds
    : (attachmentIds instanceof Set ? Array.from(attachmentIds) : []);

  if (ids.length === 0) {
    return { deletedCount: 0, deletedFiles: [] };
  }

  const resolvedCache = path.resolve(cacheDir);

  // Check if cache directory exists
  try {
    const stat = await fsPromises.stat(resolvedCache);
    if (!stat.isDirectory()) {
      return { deletedCount: 0, deletedFiles: [] };
    }
  } catch {
    return { deletedCount: 0, deletedFiles: [] };
  }

  // Sanitize all target attachment IDs to their safe prefixes
  const safePrefixes = new Set();
  for (const id of ids) {
    if (id === null || id === undefined) continue;
    const idStr = typeof id === 'string' ? id : String(id);
    const safeId = idStr.replace(/[^a-zA-Z0-9_-]/g, '').trim();
    if (safeId) {
      safePrefixes.add(`${safeId}_`);
    }
  }

  if (safePrefixes.size === 0) {
    return { deletedCount: 0, deletedFiles: [] };
  }

  const deletedFiles = [];

  try {
    const entries = await fsPromises.readdir(resolvedCache, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const filename = entry.name;
      // Check if filename matches any safe prefix
      let matches = false;
      for (const prefix of safePrefixes) {
        if (filename.startsWith(prefix)) {
          matches = true;
          break;
        }
      }

      if (!matches) continue;

      const targetPath = path.join(resolvedCache, filename);
      const resolvedTarget = path.resolve(targetPath);

      // Strict boundary security: Guarantee file is strictly inside cacheDir
      if (!resolvedTarget.startsWith(resolvedCache + path.sep)) {
        continue;
      }

      try {
        await fsPromises.unlink(resolvedTarget);
        deletedFiles.push(filename);
      } catch (err) {
        // Ignore nonexistent or locked files safely
        if (err.code !== 'ENOENT') {
          console.warn('[deleteCachedAttachments] Could not delete file:', filename, err.message);
        }
      }
    }
  } catch (err) {
    console.warn('[deleteCachedAttachments] Failed to read cache directory:', err.message);
  }

  return { deletedCount: deletedFiles.length, deletedFiles };
}

