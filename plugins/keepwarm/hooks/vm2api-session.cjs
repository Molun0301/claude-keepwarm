const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 向 vm2api 查询或操作本会话在代理侧的状态：智能路由是否开启、会话是否在等额度恢复、
// 手动迁移、加急、保活开关、声明结束。地址和密钥沿用 Claude 的连接配置，不写入输出。
const ACTIONS = new Set(['get', 'keepalive', 'migrate', 'rush', 'end'])
const TIMEOUT_MS = 8000

function connection(env = process.env, home = os.homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).env || {} } catch { /* 没有保存的连接配置时只用环境变量。 */ }
  const base = String(env.ANTHROPIC_BASE_URL || saved.ANTHROPIC_BASE_URL || '')
  const key = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || saved.ANTHROPIC_AUTH_TOKEN || saved.ANTHROPIC_API_KEY || '')
  let origin
  try { origin = new URL(base) } catch { return null }
  // 官方接口没有这些路径；带账号密码的地址不使用。
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || /(^|\.)anthropic\.com$/i.test(origin.hostname) || !key) return null
  return { origin: origin.origin, key }
}

async function call({ action, sessionId, body = {}, env = process.env, home, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!ACTIONS.has(action) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(sessionId || ''))) return { ok: false, status: 0, code: 'invalid_request' }
  const target = connection(env, home)
  if (!target) return { ok: false, status: 0, code: 'no_proxy' }
  const agent = typeof body.agent_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.agent_id) ? body.agent_id : ''
  const read = action === 'get'
  const url = `${target.origin}/v1/kin/sessions/${sessionId}${read ? agent ? `?agent_id=${agent}` : '' : `/${action}`}`
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: read ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${target.key}`, 'x-api-key': target.key, ...(read ? {} : { 'content-type': 'application/json' }) },
      ...(read ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
    })
    let payload = null
    try { payload = await response.json() } catch { /* 不是本代理的响应时按不支持处理。 */ }
    if (response.ok && payload?.ok === true) return { ok: true, status: response.status, data: payload.data }
    return { ok: false, status: response.status, code: String(payload?.error?.code || `http_${response.status}`), message: String(payload?.error?.message || ''), meta: payload?.error?.meta || null }
  } catch (error) {
    return { ok: false, status: 0, code: abort.signal.aborted ? 'timeout' : 'network_error' }
  } finally { clearTimeout(timer) }
}

// 主对话和子代理的状态一次查完：结果沿用主对话的格式，子代理的结果按代理标识放在 agents 里。
async function getMany({ sessionId, agentIds = [], ...options }) {
  const ids = agentIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
  const [main, ...list] = await Promise.all([
    call({ ...options, action: 'get', sessionId }),
    ...ids.map(id => call({ ...options, action: 'get', sessionId, body: { agent_id: id } })),
  ])
  return { ...main, agents: Object.fromEntries(ids.map((id, index) => [id, list[index]])) }
}

module.exports = { call, connection, getMany }
if (require.main === module) {
  const [action, sessionId, raw = '{}'] = process.argv.slice(2)
  let body = {}
  try { body = JSON.parse(raw) } catch { /* 请求体无效时按空对象发送。 */ }
  const run = action === 'get' && Array.isArray(body.agent_ids) ? getMany({ sessionId, agentIds: body.agent_ids }) : call({ action, sessionId, body })
  run.then(result => console.log(JSON.stringify(result)))
}
