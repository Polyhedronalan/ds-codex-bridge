import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateBeforeAppend } from '../log-rotation.mjs';
import { createLogger } from '../logger.mjs';

test('rotation shifts archives and enforces retention', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-rotation-'));
  try {
    const file = path.join(dir, 'bridge.log');
    writeFileSync(file, 'current'.repeat(200));
    writeFileSync(`${file}.1`, 'one');
    writeFileSync(`${file}.2`, 'two');
    assert.equal(rotateBeforeAppend(file, 10, { maxBytes: 1024, maxFiles: 2 }), true);
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'current'.repeat(200));
    assert.equal(readFileSync(`${file}.2`, 'utf8'), 'one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlist logger rotates before appending the next complete JSON line', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-logger-'));
  try {
    const file = path.join(dir, 'bridge.jsonl');
    writeFileSync(file, 'x'.repeat(1020));
    const logger = createLogger({ path: file, rotation: { maxBytes: 1024, maxFiles: 3 } });
    logger.log({ event: 'test', message: 'complete-line' });
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(1020));
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(line.message, 'complete-line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
