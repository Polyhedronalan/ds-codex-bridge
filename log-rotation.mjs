/** Size-based, dependency-free log rotation for Bridge runtime logs. */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 5;

export function normalizeRotation(options = {}) {
  const maxBytes = Number(options.maxBytes ?? options.max_bytes ?? DEFAULT_LOG_MAX_BYTES);
  const maxFiles = Number(options.maxFiles ?? options.max_files ?? DEFAULT_LOG_MAX_FILES);
  return {
    maxBytes: Number.isSafeInteger(maxBytes) && maxBytes >= 1024 ? maxBytes : DEFAULT_LOG_MAX_BYTES,
    maxFiles: Number.isSafeInteger(maxFiles) && maxFiles >= 1 && maxFiles <= 100 ? maxFiles : DEFAULT_LOG_MAX_FILES,
  };
}

/**
 * Rotate file -> file.1 -> ... before an append would exceed maxBytes.
 * Rotation is best-effort: callers must be able to keep serving if logging fails.
 */
export function rotateBeforeAppend(file, incomingBytes = 0, options = {}) {
  if (!file) return false;
  const { maxBytes, maxFiles } = normalizeRotation(options);
  let size = 0;
  try { size = statSync(file).size; } catch { return false; }
  if (size === 0 || size + Math.max(0, Number(incomingBytes) || 0) <= maxBytes) return false;

  mkdirSync(path.dirname(file), { recursive: true });
  const oldest = `${file}.${maxFiles}`;
  try { if (existsSync(oldest)) unlinkSync(oldest); } catch { /* best effort */ }
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    try { if (existsSync(from)) renameSync(from, to); } catch { /* best effort */ }
  }
  try {
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}
