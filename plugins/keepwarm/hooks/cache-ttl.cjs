'use strict';
const fs = require('node:fs');

// 宿主交给函数钩子的用量不含缓存有效期分项，转录保留服务端原始分项。
// 只读取文件末尾，按最近一次实际写入缓存的请求判断有效期；只输出 5m、1h 或空。
function lastCacheTtl(file, maxBytes = 2 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cache_creation"')) continue;
      let creation;
      try { creation = JSON.parse(lines[i]).message?.usage?.cache_creation; } catch { continue; }
      // 同一请求两种都有时按5分钟处理：误判为1小时会浪费一次整段重写。
      if (creation?.ephemeral_5m_input_tokens > 0) return '5m';
      if (creation?.ephemeral_1h_input_tokens > 0) return '1h';
    }
    return '';
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  try { process.stdout.write(lastCacheTtl(process.argv[2])); }
  catch (_) { process.exitCode = 1; }
}
module.exports = { lastCacheTtl };
