'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lastCacheTtl } = require('../plugins/keepwarm/hooks/cache-ttl.cjs');
const helper = path.resolve(__dirname, '../plugins/keepwarm/hooks/cache-ttl.cjs');

// 转录行只保留判断所需字段；真实转录还含正文，辅助脚本不输出它们。
const row = (m5, h1) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '正文' }], usage: { cache_read_input_tokens: 9, cache_creation_input_tokens: m5 + h1, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 } } } })
const withFile = (lines, fn) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '缓存有效期验证-'))
  const file = path.join(dir, 's1.jsonl')
  try { fs.writeFileSync(file, lines.join('\n') + '\n'); return fn(file) } finally { fs.rmSync(dir, { recursive: true }) }
}

test('按最近一次实际写入缓存的请求判断有效期，跳过只读缓存的请求', () => {
  withFile([row(0, 500), row(800, 0)], file => assert.equal(lastCacheTtl(file), '5m'))
  withFile([row(800, 0), row(0, 500)], file => assert.equal(lastCacheTtl(file), '1h'))
  withFile([row(0, 500), row(0, 0), '{"type":"user"}'], file => assert.equal(lastCacheTtl(file), '1h'))
})

test('同一请求同时写两种有效期时按5分钟处理', () => {
  withFile([row(10, 500)], file => assert.equal(lastCacheTtl(file), '5m'))
})

test('损坏行和缺少分项的转录返回空结果', () => {
  withFile(['{"message":{"usage":{"cache_creation":', '{"message":{"usage":{"cache_creation_input_tokens":5}}}'], file => assert.equal(lastCacheTtl(file), ''))
})

test('只读取文件末尾，超出范围的旧记录不参与判断', () => {
  withFile([row(0, 500), 'x'.repeat(4096)], file => {
    assert.equal(lastCacheTtl(file, 1024), '')
    assert.equal(lastCacheTtl(file), '1h')
  })
})

test('命令行只输出有效期，文件不存在时以非零状态退出', () => {
  withFile([row(800, 0)], file => {
    const result = spawnSync(process.execPath, [helper, file], { encoding: 'utf8' })
    assert.equal(result.status, 0); assert.equal(result.stdout, '5m')
  })
  assert.notEqual(spawnSync(process.execPath, [helper, '/不存在/转录.jsonl']).status, 0)
})
