/**
 * MimeValidator for OllaChat Windows Media Sharing.
 * Faithfully matches Android reference implementation (MimeValidator.kt).
 * Enforces file size limits, blocked MIME types, magic bytes, safe extension mappings,
 * and double extension protection.
 */

// Blocked executable/script MIME types
export const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-bat',
  'application/x-sh',
  'application/x-php',
  'application/x-httpd-php',
  'text/html',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/x-shellscript',
  'application/x-perl',
  'application/x-ruby',
  'application/x-python',
  'application/x-java-archive',
  'application/x-dex',
  'application/x-sharedlib',
  'application/x-object',
  'application/x-executable-elf'
]);

// Blocked file extensions (dangerous executables and scripts)
export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'sh', 'bash',
  'php', 'js', 'mjs', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'apk', 'jar', 'dex', 'dll', 'so', 'dylib', 'bin', 'elf'
]);

// Known magic bytes for signature validation (supports single pattern or list of valid signature patterns)
export const MAGIC_BYTES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF
  'image/bmp': [0x42, 0x4D],
  'image/tiff': [0x49, 0x49, 0x2A, 0x00],
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'application/zip': [0x50, 0x4B, 0x03, 0x04], // PK..
  'application/x-rar-compressed': [0x52, 0x61, 0x72, 0x21], // Rar!
  'application/gzip': [0x1F, 0x8B],
  'video/webm': [
    [0x1A, 0x45, 0xDF, 0xA3], // Standard EBML header ID
    [0x1A, 0x45, 0xDF, 0xFF]
  ],
  'audio/webm': [
    [0x1A, 0x45, 0xDF, 0xA3], // Standard EBML header ID (MediaRecorder WebM Opus)
    [0x1A, 0x45, 0xDF, 0xFF]
  ],
  'video/quicktime': [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70],
  'audio/mpeg': [
    [0x49, 0x44, 0x33], // ID3 tag (standard in 99% of MP3 files)
    [0xFF, 0xFB],       // MPEG-1 Layer 3 with Protection
    [0xFF, 0xFA],       // MPEG-1 Layer 3 without Protection
    [0xFF, 0xF3],       // MPEG-2 Layer 3
    [0xFF, 0xF2],       // MPEG-2 Layer 3
    [0xFF, 0xE3]        // MPEG-2.5 Layer 3
  ],
  'audio/aac': [
    [0x49, 0x44, 0x33], // ID3 tag
    [0xFF, 0xF1],       // ADTS header
    [0xFF, 0xF9]        // ADTS header
  ],
  'audio/ogg': [0x4F, 0x67, 0x67, 0x53], // OggS
  'audio/wav': [0x52, 0x49, 0x46, 0x46], // RIFF
  'audio/flac': [0x66, 0x4C, 0x61, 0x43], // fLaC
  'application/x-msdownload': [0x4D, 0x5A] // MZ executable header
};

// Extension-to-MIME mapping
export const EXTENSION_MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

// Maximum file size (50MB default - matches Android reference)
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Single PUT threshold (10MB - matches Android reference)
export const SINGLE_PUT_THRESHOLD = 10 * 1024 * 1024;

// Multipart part size (8MB - matches Android reference)
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

/**
 * Checks if a filename has suspicious double extensions (e.g. "image.png.exe" or "doc.pdf.bat").
 * @param {string} filename
 * @returns {boolean}
 */
export function hasSuspiciousExtension(filename) {
  if (!filename || typeof filename !== 'string') return true;
  const parts = filename.toLowerCase().trim().split('.');
  if (parts.length < 2) return false;

  // The last extension
  const lastExt = parts[parts.length - 1];
  if (BLOCKED_EXTENSIONS.has(lastExt)) return true;

  // If there are multiple extensions and any previous part is a known media/doc ext while last is executable/script
  if (parts.length > 2) {
    for (let i = 1; i < parts.length; i++) {
      if (BLOCKED_EXTENSIONS.has(parts[i])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determines whether two MIME types are a known safe mismatch (e.g., image/jpg vs image/jpeg).
 * @param {string} extMime
 * @param {string} declaredMime
 * @returns {boolean}
 */
export function isSafeMimeMismatch(extMime, declaredMime) {
  if (extMime === declaredMime) return true;
  const normalExt = extMime.toLowerCase().split(';')[0].trim();
  const normalDecl = declaredMime.toLowerCase().split(';')[0].trim();
  if (normalExt === normalDecl) return true;

  if ((normalExt === 'image/jpeg' && normalDecl === 'image/jpg') ||
      (normalExt === 'image/jpg' && normalDecl === 'image/jpeg')) {
    return true;
  }
  if ((normalExt === 'audio/mpeg' && normalDecl === 'audio/mp3') ||
      (normalExt === 'audio/mp3' && normalDecl === 'audio/mpeg')) {
    return true;
  }
  if ((normalExt === 'audio/wav' && normalDecl === 'audio/x-wav') ||
      (normalExt === 'audio/x-wav' && normalDecl === 'audio/wav')) {
    return true;
  }
  if ((normalExt === 'video/webm' && normalDecl === 'audio/webm') ||
      (normalExt === 'audio/webm' && normalDecl === 'video/webm')) {
    return true;
  }
  return false;
}

/**
 * Categorizes a MIME type or extension into the 4 verified message kinds:
 * 'image' | 'video' | 'audio' | 'file'
 * @param {string} mime
 * @param {string} [filename='']
 * @returns {'image' | 'video' | 'audio' | 'file'}
 */
export function categorizeMediaKind(mime, filename = '') {
  const normalMime = (mime || '').toLowerCase().trim();
  const ext = (filename.split('.').pop() || '').toLowerCase().trim();

  if (normalMime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(ext)) {
    return 'image';
  }
  if (normalMime.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv'].includes(ext) || (ext === 'webm' && normalMime.startsWith('video/'))) {
    return 'video';
  }
  if (normalMime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'flac', 'aac', 'm4a'].includes(ext) || (ext === 'webm' && normalMime.startsWith('audio/'))) {
    return 'audio';
  }
  return 'file';
}

/**
 * Validates a file's metadata and byte header against security constraints.
 * @param {object} params
 * @param {string} params.filename
 * @param {number} params.byteSize
 * @param {string} [params.declaredMime]
 * @param {Uint8Array|Buffer|null} [params.headerBytes] First 16+ bytes of the file
 * @param {number} [params.maxSize=MAX_FILE_SIZE]
 * @returns {{ isValid: boolean, error?: string, effectiveMime: string, kind: 'image' | 'video' | 'audio' | 'file' }}
 */
export function validateMediaFile(params = {}) {
  const filename = params.filename || params.name;
  const byteSize = typeof params.byteSize === 'number' ? params.byteSize : (typeof params.size === 'number' ? params.size : undefined);
  const declaredMime = params.declaredMime || params.type || params.mime || '';
  const headerBytes = params.headerBytes || params.buffer || null;
  const maxSize = params.maxSize || MAX_FILE_SIZE;

  if (!filename || typeof filename !== 'string' || filename.trim() === '') {
    return { isValid: false, valid: false, error: 'Filename is required', effectiveMime: '', kind: 'file' };
  }

  // 1. Check file size
  if (typeof byteSize !== 'number' || byteSize <= 0) {
    return { isValid: false, valid: false, error: 'File is empty (0 bytes)', effectiveMime: '', kind: 'file' };
  }
  if (byteSize > maxSize) {
    return { isValid: false, valid: false, error: `File too large: ${byteSize} bytes (max: ${maxSize} bytes)`, effectiveMime: '', kind: 'file' };
  }

  // 2. Check for suspicious extensions or double extensions
  if (hasSuspiciousExtension(filename)) {
    return { isValid: false, error: `Executable or dangerous file extension rejected: ${filename}`, effectiveMime: '', kind: 'file' };
  }

  const ext = (filename.split('.').pop() || '').toLowerCase().trim();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { isValid: false, error: `Extension .${ext} is blocked for security`, effectiveMime: '', kind: 'file' };
  }

  // Resolve MIME from extension or declared MIME
  const extMime = EXTENSION_MIME_MAP[ext] || null;
  let effectiveMime = (declaredMime || extMime || 'application/octet-stream').toLowerCase().trim();

  // Check if MIME type is blocked
  if (BLOCKED_MIME_TYPES.has(effectiveMime)) {
    return { isValid: false, error: `MIME type not allowed: ${effectiveMime}`, effectiveMime, kind: 'file' };
  }

  // Check for extension vs declared MIME mismatch
  if (extMime && declaredMime && extMime !== declaredMime && !isSafeMimeMismatch(extMime, declaredMime)) {
    // If extension suggests an executable or blocked type, reject immediately
    if (BLOCKED_MIME_TYPES.has(extMime)) {
      return { isValid: false, error: `Extension suggests blocked type: ${extMime}`, effectiveMime, kind: 'file' };
    }
  }

  // 3. Header bytes / magic bytes validation if available
  if (headerBytes && headerBytes.length >= 2) {
    // Check if header starts with MZ executable header
    if (headerBytes[0] === 0x4D && headerBytes[1] === 0x5A) {
      return { isValid: false, error: 'Windows executable file (MZ header) detected and blocked', effectiveMime, kind: 'file' };
    }

    // Check expected magic bytes if we have pattern(s) for effectiveMime
    const baseMime = effectiveMime.split(';')[0].trim();
    const expected = MAGIC_BYTES[effectiveMime] || MAGIC_BYTES[baseMime];
    if (expected) {
      const patterns = Array.isArray(expected[0]) ? expected : [expected];
      let matchesAny = false;
      for (const pattern of patterns) {
        if (headerBytes.length >= pattern.length) {
          let matchesThis = true;
          for (let i = 0; i < pattern.length; i++) {
            if (headerBytes[i] !== pattern[i]) {
              matchesThis = false;
              break;
            }
          }
          if (matchesThis) {
            matchesAny = true;
            break;
          }
        }
      }
      if (!matchesAny) {
        return {
          isValid: false,
          error: `File content magic bytes do not match declared MIME ${effectiveMime}`,
          effectiveMime,
          kind: categorizeMediaKind(effectiveMime, filename)
        };
      }
    }
  }

  const kind = categorizeMediaKind(effectiveMime, filename);
  return { isValid: true, valid: true, effectiveMime, kind };
}
