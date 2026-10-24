// Local GPT admission only. No scheduler, credential reader or model rerouting.
import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
const execute = promisify(execFile);
const STATE_MAX_AGE_SECONDS = 900;
const RETRY_DELAY_MS = 400;

function fileInfo(candidate) {
  if (!candidate || path.extname(candidate).toLowerCase() !== '.exe') return null;
  try {
    const stat = statSync(candidate);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

// Resolve the installed CLI at read time. A long-running Bridge can outlive a
// Codex update and keep an old PATH containing an empty version directory.
export function resolveCodexBin(env = process.env, options = {}) {
  const localAppData = options.localAppData || env.LOCALAPPDATA;
  const home = options.home || os.homedir();
  const candidates = [];
  if (env.ALAN_CODEX_BIN) candidates.push(env.ALAN_CODEX_BIN);

  const roots = [];
  if (localAppData) roots.push(path.join(localAppData, 'OpenAI', 'Codex', 'bin'));
  if (home) roots.push(path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'));
  for (const root of roots) {
    try {
      const found = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, 'codex.exe');
        const info = fileInfo(file);
        if (info) found.push({ file, mtime: info.mtimeMs });
      }
      found.sort((a, b) => b.mtime - a.mtime);
      for (const item of found) candidates.push(item.file);
    } catch {
      // The install root may not exist on a non-standard installation.
    }
  }

  const searchPath = env.PATH || env.Path || '';
  for (const dir of String(searchPath).split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'codex.exe'));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fileInfo(resolved)) return resolved;
  }
  return null;
}

export function evaluate(snapshot, reserve = 3, now = Date.now() / 1000, maxAgeSeconds = 30) {
  const unknown = { allowed: false, code: 'BRIDGE_GPT_QUOTA_UNKNOWN', reason: 'official quota unavailable or stale' };
  if (snapshot?.status !== 'measured' || !Number.isFinite(snapshot.measured_at) ||
      now - snapshot.measured_at < -5 || now - snapshot.measured_at > maxAgeSeconds) return unknown;
  const windows = {};
  for (const key of ['primary', 'secondary']) {
    const window = snapshot[key];
    const used = window?.usedPercent;
    if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(window?.resetsAt)) return unknown;
    windows[key] = { remaining_percent: 100 - used, resets_at: window.resetsAt };
  }
  const blocking = Object.entries(windows).filter(([, value]) => value.remaining_percent <= reserve);
  return { allowed: blocking.length === 0,
    code: blocking.length ? 'BRIDGE_GPT_QUOTA_RESERVE' : 'allow', reserve_percent: reserve,
    measured_at: snapshot.measured_at, windows,
    resume_after: blocking.length ? Math.max(...blocking.map(([, value]) => value.resets_at)) : null,
    reason: blocking.length ? 'local GPT reserve protection; DeepSeek remains available' : 'official quota above reserve' };
}

export class GptQuotaGate {
  constructor(directory, readQuota = null) {
    this.file = path.join(directory, 'gpt-quota-gate.json');
    this.stateFile = path.join(directory, 'gpt-quota-gate-state.json');
    this.readQuota = readQuota || (() => this.nativeQuota());
    this.pending = null;
    this.last = null;
    this.lastCodexBin = null;
    this.retryDelayMs = RETRY_DELAY_MS;
    this.lastGood = this.loadState();
  }
  policy() {
    try {
      const policy = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof policy.enabled !== 'boolean' || policy.reserve_percent !== 3) throw Error('invalid');
      return policy;
    } catch (error) {
      if (error.code === 'ENOENT') return { enabled: false, reserve_percent: 3 };
      return { enabled: true, reserve_percent: 3, invalid: true };
    }
  }
  loadState() {
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
      if (state && state.snapshot && Number.isFinite(state.saved_at)) return state;
    } catch {
      // Missing or incomplete state is normal on first start.
    }
    return null;
  }
  saveState(snapshot) {
    const payload = JSON.stringify({ saved_at: Date.now() / 1000, snapshot });
    const temp = `${this.stateFile}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, payload, 'utf8');
      renameSync(temp, this.stateFile);
    } catch {
      try { unlinkSync(temp); } catch {}
    }
  }
  async nativeQuota() {
    const policy = this.policy();
    const router = path.join(os.homedir(), '.codex', 'skills', 'alan-model-router', 'scripts', 'model_router.py');
    const codex = resolveCodexBin(process.env);
    if (!codex) {
      const error = new Error('codex executable not found');
      error.code = 'CODEX_BIN_NOT_FOUND';
      throw error;
    }
    this.lastCodexBin = codex;
    const { stdout } = await execute(policy.python, [router, 'quota'], {
      windowsHide: true, timeout: 25000, maxBuffer: 524288, encoding: 'utf8',
      env: { ...process.env, ALAN_CODEX_BIN: codex },
    });
    return JSON.parse(stdout);
  }
  async readWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.readQuota();
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError;
  }
  fallbackResult(error, reserve) {
    const errorCode = String(error?.code || error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
    const state = this.lastGood;
    if (state && Number.isFinite(state.saved_at) && Date.now() / 1000 - state.saved_at <= STATE_MAX_AGE_SECONDS) {
      const cached = evaluate(state.snapshot, reserve, Date.now() / 1000, STATE_MAX_AGE_SECONDS);
      if (cached.code === 'allow') {
        return { ...cached, code: 'BRIDGE_GPT_QUOTA_CACHED',
          reason: `official quota read failed (${errorCode}); recent official snapshot above reserve`,
          error_code: errorCode, cached: true };
      }
      if (cached.code === 'BRIDGE_GPT_QUOTA_RESERVE') {
        return { ...cached, reason: `official quota read failed (${errorCode}); recent official snapshot at or below reserve`,
          error_code: errorCode, cached: true };
      }
    }
    return { allowed: false, code: 'BRIDGE_GPT_QUOTA_UNKNOWN',
      reason: `official quota unavailable (${errorCode}); GPT held, DeepSeek unaffected`,
      error_code: errorCode };
  }
  async check(model) {
    if (typeof model !== 'string' || !model.startsWith('gpt-')) return { allowed: true, reason: 'non-GPT branch' };
    const policy = this.policy();
    if (!policy.enabled) return { allowed: true, reason: 'gate disabled' };
    let result;
    try {
      if (policy.invalid) {
        const error = new Error('invalid policy');
        error.code = 'GATE_POLICY_INVALID';
        throw error;
      }
      // Share only an in-flight read. Completed reads are never reused unless
      // the official source fails and the bounded fallback is still fresh.
      if (!this.pending) this.pending = this.readWithRetry();
      const read = this.pending;
      let snapshot;
      try {
        snapshot = await read;
        result = evaluate(snapshot, policy.reserve_percent);
      } finally {
        if (this.pending === read) this.pending = null;
      }
      if (result.code !== 'BRIDGE_GPT_QUOTA_UNKNOWN') {
        this.lastGood = { saved_at: Date.now() / 1000, snapshot };
        this.saveState(snapshot);
      }
    } catch (error) {
      result = this.fallbackResult(error, policy.reserve_percent);
    }
    this.last = result;
    return result;
  }
  status() {
    return { enabled: this.policy().enabled, reserve_percent: 3,
      codex_bin: this.lastCodexBin || resolveCodexBin(process.env), last: this.last };
  }
}
