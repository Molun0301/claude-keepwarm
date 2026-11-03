'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = new Set(['time', 'event', 'plugin_version', 'session_id', 'agent_id', 'marker', 'turn_id', 'format', 'reason', 'phase', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'input_tokens', 'output_tokens', 'total_bumps', 'round_bumps', 'quota_percent', 'errors', 'cache_age_seconds', 'log_path', 'enabled', 'persisted']);

function appendLog(file, entry, { maxBytes = 1024 * 1024 } = {}) {
  const name = path.basename(file);
  if (!path.isAbsolute(file) || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(name) || entry.session_id !== name.slice(0, -6)) throw Error('invalid_log_target');
  const row = {};
  for (const [key, value] of Object.entries(entry)) {
    if (FIELDS.has(key) && (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string')) row[key] = typeof value === 'string' ? value.slice(0, 300) : value;
  }
  const line = JSON.stringify(row) + '\n';
  const dir = path.dirname(file), lock = file + '.lock';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  const deadline = Date.now() + 1500;
  // 锁只保护日志追加和轮转，不参与对话或额度准入。
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch (_) {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) {}
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

if (require.main === module) {
  try { appendLog(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8'))); }
  catch (_) { process.stderr.write('keepwarm_log_write_failed\n'); process.exitCode = 1; }
}
module.exports = { appendLog };
