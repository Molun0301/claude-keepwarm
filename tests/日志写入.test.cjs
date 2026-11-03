'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { appendLog } = require('../plugins/keepwarm/hooks/append-log.cjs');
const helper = path.resolve(__dirname, '../plugins/keepwarm/hooks/append-log.cjs');
const work = require('node:os').tmpdir();
const temporary = () => fs.mkdtempSync(path.join(work, '日志写入验证-'));
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

test('日志真正追加且仅本用户可读，不保存正文、工具输入和凭据字段', () => {
  const dir = temporary(), file = path.join(dir, 'logs/s1.jsonl');
  try {
    appendLog(file, { session_id: 's1', event: 'first', enabled: false, persisted: true, prompt: '私密正文', credentials: '私密凭据', input: { command: '工具内容' } });
    appendLog(file, { session_id: 's1', event: 'second', cache_read_input_tokens: 12345 });
    assert.equal(rows(file).length, 2);
    assert.deepEqual(rows(file).map(x => x.event), ['first', 'second']);
    assert.equal(rows(file)[0].enabled, false);
    assert.equal(rows(file)[0].persisted, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert(!fs.readFileSync(file, 'utf8').includes('私密'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('日志达到上限轮转，最多保留当前和上一份完整JSONL', () => {
  const dir = temporary(), file = path.join(dir, 's1.jsonl');
  try {
    for (const event of ['first', 'second', 'third']) appendLog(file, { session_id: 's1', event, reason: 'x'.repeat(120) }, { maxBytes: 220 });
    assert.equal(rows(file)[0].event, 'third');
    assert.equal(rows(path.join(dir, 's1.1.jsonl'))[0].event, 'second');
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('多个日志写入进程并发追加不丢行、不留下锁文件', async () => {
  const dir = temporary(), file = path.join(dir, 's1.jsonl');
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, file], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error('日志子进程失败')));
      child.stdin.end(JSON.stringify({ session_id: 's1', event: 'event-' + i }));
    })));
    assert.equal(rows(file).length, 8);
    assert.equal(new Set(rows(file).map(x => x.event)).size, 8);
    assert(!fs.existsSync(file + '.lock'));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('拒绝写入其他会话路径，并能恢复过期日志锁', () => {
  const dir = temporary(), file = path.join(dir, 's1.jsonl');
  try {
    assert.throws(() => appendLog(file, { session_id: 'other', event: 'bad' }), /invalid_log_target/);
    fs.writeFileSync(file + '.lock', '旧锁');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file + '.lock', old, old);
    appendLog(file, { session_id: 's1', event: 'recovered' });
    assert.equal(rows(file)[0].event, 'recovered');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
