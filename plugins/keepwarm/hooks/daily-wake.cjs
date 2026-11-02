const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createVm2apiWake } = require('./vm2api-wake.cjs')

const UNIT = 'claude-keepwarm-wake'
const readJSON = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
const quote = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$') + '"'

function createScheduler({ home = os.homedir(), env = process.env, execute = execFileSync } = {}) {
  const dir = path.join(home, '.claude/keepwarm/wake')
  const units = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user')
  const configFile = path.join(dir, 'config.json')
  const resultFile = path.join(dir, 'last-run.json')
  const runner = path.join(dir, 'daily-wake.cjs')
  const timerFile = path.join(units, `${UNIT}.timer`)
  const serviceFile = path.join(units, `${UNIT}.service`)
  const control = (...args) => execute('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

  function status() {
    const config = readJSON(configFile, null)
    const lines = [config ? `每日唤醒：每天 ${config.time}（本机时间）。` : '每日唤醒：未开启。设置：/keepwarm wake 07:00']
    if (config) {
      if (config.mode === 'vm2api-all') lines.push('唤醒范围：全部有效Claude账户；每次执行重新读取并逐一核对路由。')
      const info = control('show', `${UNIT}.timer`, '--property=ActiveState', '--property=NextElapseUSecRealtime')
      const fields = Object.fromEntries(info.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
      lines.push(`定时器：${fields.ActiveState === 'active' ? '运行中' : '未运行'}；下次：${fields.NextElapseUSecRealtime || '未安排'}。`)
    }
    const last = readJSON(resultFile, null)
    if (last) {
      const legacy = config?.mode === 'vm2api-all' && !last.targets && last.status === 'ok'
      lines.push(`最近执行${legacy ? '（旧版单路由记录）' : ''}：${new Date(last.at).toLocaleString()}，${last.targets ? `${last.targets.filter(t => t.status === 'ok').length}/${last.targets.length} 个账户成功` : last.status === 'ok' ? `成功，回复 ${last.reply}` : last.reason}${last.sessionId ? `；会话 ${last.sessionId}` : ''}`)
      if (last.targets) for (const target of last.targets) lines.push(`${target.name || target.vmId || '当前路由'}：${target.status === 'ok' ? `成功${target.routeVerified ? '，路由已核对' : ''}` : target.reason}；会话 ${target.sessionId}`)
    }
    return lines.join('\n')
  }

  function set(time) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('时间格式：HH:MM，例如 07:00。')
    const claude = (env.PATH || '').split(path.delimiter).map(p => path.join(p, 'claude')).find(p => fs.existsSync(p))
    if (!claude) throw Error('当前环境找不到 claude 命令。')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(units, { recursive: true })
    const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
    const mode = createVm2apiWake(configDir, execute) ? 'vm2api-all' : 'current-route'
    save(configFile, { time, claude, configDir, mode })
    // 使用固定运行路径，插件版本缓存更新后日程仍可执行；凭据在执行时读取。
    fs.copyFileSync(__filename, runner)
    fs.copyFileSync(path.join(__dirname, 'vm2api-wake.cjs'), path.join(dir, 'vm2api-wake.cjs'))
    fs.writeFileSync(serviceFile, `[Unit]\nDescription=Claude Keepwarm daily wake\n\n[Service]\nType=oneshot\nExecStart=${quote(process.execPath)} ${quote(runner)} run\nTimeoutStartSec=600\n`)
    fs.writeFileSync(timerFile, `[Unit]\nDescription=Claude Keepwarm daily wake timer\n\n[Timer]\nOnCalendar=*-*-* ${time}:00\nAccuracySec=1s\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n`)
    control('daemon-reload')
    control('enable', `${UNIT}.timer`)
    control('restart', `${UNIT}.timer`)
    return status()
  }

  function off() {
    if (fs.existsSync(timerFile)) {
      control('disable', '--now', `${UNIT}.timer`)
      control('stop', `${UNIT}.service`)
      fs.rmSync(timerFile)
      fs.rmSync(serviceFile)
      control('daemon-reload')
    }
    fs.rmSync(configFile, { force: true })
    return '每日唤醒已关闭。'
  }

  function run() {
    const config = readJSON(configFile, null)
    if (!config) return
    const settings = readJSON(path.join(config.configDir, 'settings.json'), {})
    const at = new Date().toISOString()
    if (fs.existsSync(path.join(home, '.claude/keepwarm-off')) || settings.enabledPlugins?.['keepwarm@keepwarm'] === false) {
      save(resultFile, { at, status: 'skipped', reason: '插件已全局关闭，跳过唤醒。' })
      return
    }
    let backend, discovery
    try {
      backend = createVm2apiWake(config.configDir, execute)
      if (config.mode === 'vm2api-all' && !backend) throw Error('多账户唤醒配置缺失，未退回单账户请求。')
      discovery = backend?.discover()
      if (backend && new URL(settings.env?.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL).origin !== backend.baseUrl) throw Error('Claude连接与多账户唤醒站点不一致。')
    } catch (error) {
      save(resultFile, { at, status: 'error', reason: error.message })
      throw error
    }
    const targets = discovery?.targets || [{}]
    const results = []
    for (const target of targets) {
      const sessionId = randomUUID()
      const args = ['--print', '.', '--session-id', sessionId, '--name', `keepwarm 定时唤醒${target.vmId ? ' '+target.vmId : ''}`,
      '--safe-mode', '--system-prompt', 'Reply only with .', '--tools', '', '--effort', 'low',
      '--model', 'haiku',
      '--max-turns', '1', '--output-format', 'json']
      const childEnv = { ...env, ...settings.env, CLAUDE_CONFIG_DIR: config.configDir,
        // 8词元会让当前自适应思考模型截断并重复请求；留够短回复及内部思考的空间。
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      delete childEnv.CLAUDECODE
      if (backend) {
        childEnv.ANTHROPIC_BASE_URL = backend.baseUrl
        childEnv.ANTHROPIC_AUTH_TOKEN = discovery.apiKey
        childEnv.ANTHROPIC_API_KEY = discovery.apiKey
        childEnv.ANTHROPIC_CUSTOM_HEADERS = [...String(childEnv.ANTHROPIC_CUSTOM_HEADERS || '').split('\n').filter(line => line.trim() && !/^\s*(x-kin-vm|authorization|x-api-key|x-session-id)\s*:/i.test(line)), `x-kin-vm: ${target.vmId}`].join('\n')
      }
      let row
      try {
        const result = JSON.parse(execute(config.claude, args, { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }))
        if (result.is_error) throw Error(result.result || 'Claude请求失败。')
        if (result.result?.trim() !== '.') throw Error('Claude未成功返回约定的句点。')
        const requests = backend?.verify(target, sessionId)
        row = { ...target, status: 'ok', sessionId, reply: result.result, usage: result.usage, ...(backend ? { routeVerified: true, requests } : {}) }
      } catch (error) {
        const reason = error.code === 'ETIMEDOUT' ? 'Claude 请求超时。' : error.status ? `Claude 退出码 ${error.status}。` : error.message
        row = { ...target, status: 'error', sessionId, reason }
      }
      results.push(row)
      // 逐项落盘，单个账户失败也继续处理剩余目标。
      save(resultFile, { at, status: 'running', targets: results })
    }
    const failed = results.filter(row => row.status !== 'ok')
    const reason = failed.length ? results.length === 1 ? failed[0].reason : `${failed.length}/${results.length} 个账户唤醒失败。` : ''
    save(resultFile, { at, status: failed.length ? 'error' : 'ok', reason, targets: results, ...(results.length === 1 ? results[0] : {}) })
    if (failed.length) throw Error(reason)
  }

  return { set, off, status, run }
}

module.exports = { createScheduler }
if (require.main === module) {
  try {
    const scheduler = createScheduler()
    const [action = 'status', time] = process.argv.slice(2)
    let result
    if (action === 'set') result = scheduler.set(time || '')
    else if (action === 'off') result = scheduler.off()
    else if (action === 'status') result = scheduler.status()
    else if (action === 'run') result = scheduler.run()
    else throw Error('用法：daily-wake.cjs [set HH:MM|off|status|run]')
    if (result) console.log(result)
  } catch (error) {
    console.error(error.stderr?.toString().trim() || error.message)
    process.exitCode = 1
  }
}
