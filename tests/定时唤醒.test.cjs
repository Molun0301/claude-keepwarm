const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createScheduler } = require('../plugins/keepwarm/hooks/daily-wake.cjs')

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwarm-wake-test-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), '')
  const calls = []
  let response = { result: '.', usage: { output_tokens: 1 } }
  let failure
  const execute = (file, args, options) => {
    calls.push({ file, args, options })
    if (file === 'systemctl') return args.includes('show') ? 'NextElapseUSecRealtime=Thu 2026-10-29 07:00:00 CST\nActiveState=active\n' : ''
    if (failure) throw failure
    return JSON.stringify(response)
  }
  const scheduler = createScheduler({ home, env: { PATH: bin, CLAUDECODE: '旧会话', ANTHROPIC_AUTH_TOKEN: '旧认证' }, execute })
  const dir = path.join(home, '.claude/keepwarm/wake')
  const units = path.join(home, '.config/systemd/user')
  const result = () => JSON.parse(fs.readFileSync(path.join(dir, 'last-run.json')))
  const settings = value => fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(value))
  return { home, dir, units, calls, scheduler, result, settings, fail: value => { failure = value }, respond: value => { response = value } }
}

test('默认关闭；严格校验用户时间，错误输入不写入日程', t => {
  const h = setup(t)
  assert.match(h.scheduler.status(), /未开启/)
  for (const time of ['7:00', '24:00', '07:60', '07:00\n', '07:00;date']) assert.throws(() => h.scheduler.set(time), /时间格式/)
  assert.equal(h.calls.length, 0)
  assert.equal(fs.existsSync(h.dir), false)
})

test('设置日程使用本机日历时间与固定路径，修改覆盖同一份定时器', t => {
  const h = setup(t)
  assert.match(h.scheduler.set('07:00'), /运行中/)
  const timer = fs.readFileSync(path.join(h.units, 'claude-keepwarm-wake.timer'), 'utf8')
  const service = fs.readFileSync(path.join(h.units, 'claude-keepwarm-wake.service'), 'utf8')
  assert.match(timer, /OnCalendar=\*-\*-\* 07:00:00\n/)
  assert.match(timer, /AccuracySec=1s/)
  assert.match(timer, /Persistent=false/)
  assert.match(service, /keepwarm\/wake\/daily-wake.cjs" run/)
  assert(!service.includes('TOKEN'))
  assert.deepEqual(h.calls.slice(0, 3).map(c => c.args), [['--user', 'daemon-reload'], ['--user', 'enable', 'claude-keepwarm-wake.timer'], ['--user', 'restart', 'claude-keepwarm-wake.timer']])
  h.scheduler.set('08:30')
  assert.match(fs.readFileSync(path.join(h.units, 'claude-keepwarm-wake.timer'), 'utf8'), /08:30:00/)
  assert.equal(fs.readdirSync(h.units).length, 2)
})

test('每日执行创建不同会话，只发送句点，使用轻量模型和短输出，并读取最新配置', t => {
  const h = setup(t)
  h.scheduler.set('07:00')
  h.settings({ model: '当前模型', env: { ANTHROPIC_AUTH_TOKEN: '新认证', ANTHROPIC_BASE_URL: 'http://localhost:12345' } })
  h.scheduler.run()
  const first = h.result()
  h.settings({ model: '更新后的模型', env: { ANTHROPIC_AUTH_TOKEN: '最新认证' } })
  h.scheduler.run()
  const second = h.result()
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(second.reply, '.')
  const call = h.calls.at(-1)
  assert.equal(call.args[call.args.indexOf('--print') + 1], '.')
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'Reply only with .')
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '')
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'haiku')
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'low')
  assert(call.args.includes('--safe-mode'))
  assert(!call.args.includes('--resume'))
  assert(!call.args.includes('--continue'))
  assert.equal(call.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '512')
  assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, '最新认证')
  assert.equal(call.options.env.CLAUDECODE, undefined)
  assert.equal(fs.statSync(path.join(h.dir, 'last-run.json')).mode & 0o777, 0o600)
})

test('沿用自定义 Claude 配置目录与系统配置目录', t => {
  const h = setup(t)
  const configDir = path.join(h.home, '自定义配置')
  fs.mkdirSync(configDir)
  const scheduler = createScheduler({ home: h.home, env: { PATH: path.join(h.home, 'bin'), CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: path.join(h.home, '系统配置') }, execute: (file, args, options) => {
    h.calls.push({ file, args, options })
    return file === 'systemctl' ? 'ActiveState=active\n' : JSON.stringify({ result: '.' })
  } })
  scheduler.set('00:00')
  scheduler.run()
  assert(fs.existsSync(path.join(h.home, '系统配置/systemd/user/claude-keepwarm-wake.timer')))
  assert.equal(h.calls.at(-1).options.env.CLAUDE_CONFIG_DIR, configDir)
})

test('全局关闭标记或禁用插件会跳过请求', t => {
  const h = setup(t)
  h.scheduler.set('07:00')
  const marker = path.join(h.home, '.claude/keepwarm-off')
  fs.writeFileSync(marker, '')
  h.scheduler.run()
  assert.equal(h.result().status, 'skipped')
  fs.rmSync(marker)
  h.settings({ enabledPlugins: { 'keepwarm@keepwarm': false } })
  h.scheduler.run()
  assert.equal(h.result().status, 'skipped')
  assert(h.calls.every(c => c.file === 'systemctl'))
})

test('失败与超时记录最近结果，不重试，也不冒充成功', t => {
  const h = setup(t)
  h.scheduler.set('07:00')
  h.respond({ is_error: true, result: '额度已用完' })
  assert.throws(() => h.scheduler.run(), /额度已用完/)
  assert.equal(h.result().status, 'error')
  h.fail(Object.assign(Error('模拟超时'), { code: 'ETIMEDOUT' }))
  assert.throws(() => h.scheduler.run(), /超时/)
  assert.equal(h.result().reason, 'Claude 请求超时。')
  assert.equal(h.calls.filter(c => c.file !== 'systemctl').length, 2)
})

test('关闭会停用日程、停止执行服务并移除配置，再运行不发请求', t => {
  const h = setup(t)
  assert.match(h.scheduler.off(), /已关闭/)
  h.scheduler.set('07:00')
  h.calls.length = 0
  h.scheduler.off()
  assert.deepEqual(h.calls.map(c => c.args), [['--user', 'disable', '--now', 'claude-keepwarm-wake.timer'], ['--user', 'stop', 'claude-keepwarm-wake.service'], ['--user', 'daemon-reload']])
  assert.equal(fs.existsSync(path.join(h.dir, 'config.json')), false)
  assert.equal(fs.readdirSync(h.units).length, 0)
  h.scheduler.run()
  assert(h.calls.every(c => c.file === 'systemctl'))
  assert.match(h.scheduler.status(), /未开启/)
})

function setupFleet(t, { targets, failVm, routeMismatch, discoverFails } = {}) {
  const h = setup(t)
  h.scheduler.set('07:00')
  const credentialsFile = path.join(h.home, '服务器信息.json')
  fs.writeFileSync(credentialsFile, JSON.stringify({ 管理页面: 'https://gateway.example/panel', 服务器别名: 'fixture-gateway', 远端安装目录: '/opt/fixture-gateway' }))
  fs.writeFileSync(path.join(h.home, '.claude/local-statusline-quota-config.json'), JSON.stringify({ base_url: 'https://gateway.example', credentials_file: credentialsFile }))
  h.settings({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: '普通密钥', ANTHROPIC_CUSTOM_HEADERS: 'x-kin-vm: 旧目标\nx-test: 保留' } })
  const fleet = targets || [{ vmId: 'fixture-vm-a', accountId: 'account-1', name: '01' }, { vmId: 'fixture-vm-b', accountId: 'account-2', name: '02' }]
  let lastVm
  const execute = (file, args, options) => {
    h.calls.push({ file, args, options })
    if (file === 'systemctl') return 'ActiveState=active\n'
    if (file === 'ssh') {
      if (options.input.includes('VM2API_API_KEY')) {
        if (discoverFails) throw Error('SSH失败')
        return JSON.stringify({ apiKey: '模拟主密钥', targets: fleet })
      }
      const target = fleet.find(row => row.vmId === lastVm)
      return JSON.stringify([{ vm_id: routeMismatch ? '错误虚拟机' : lastVm, account_id: target.accountId }])
    }
    lastVm = /x-kin-vm: ([^\n]+)/.exec(options.env.ANTHROPIC_CUSTOM_HEADERS)[1]
    if (lastVm === failVm) throw Object.assign(Error('客户端失败'), { status: 1 })
    return JSON.stringify({ result: '.', usage: { input_tokens: 200, output_tokens: 3 } })
  }
  const scheduler = createScheduler({ home: h.home, env: { PATH: path.join(h.home, 'bin') }, execute })
  return { ...h, scheduler }
}

test('多账户分别固定目标，使用独立会话，密钥不写入配置或结果', t => {
  const h = setupFleet(t)
  h.scheduler.run()
  const calls = h.calls.filter(row => row.file !== 'ssh' && row.file !== 'systemctl')
  assert.equal(calls.length, 2)
  assert(calls[0].options.env.ANTHROPIC_CUSTOM_HEADERS.includes('x-kin-vm: fixture-vm-a'))
  assert(calls[1].options.env.ANTHROPIC_CUSTOM_HEADERS.includes('x-kin-vm: fixture-vm-b'))
  assert(calls.every(row => row.options.env.ANTHROPIC_AUTH_TOKEN === '模拟主密钥' && row.options.env.ANTHROPIC_CUSTOM_HEADERS.includes('x-test: 保留')))
  assert.notEqual(h.result().targets[0].sessionId, h.result().targets[1].sessionId)
  assert(h.result().targets.every(row => row.routeVerified && row.requests === 1))
  for (const name of ['config.json', 'last-run.json']) assert(!fs.readFileSync(path.join(h.dir, name), 'utf8').includes('模拟主密钥'))
  assert.match(h.scheduler.status(), /2\/2 个账户成功/)
})

test('同一账户多个虚拟机只唤醒一次，失败不阻止其他账户', t => {
  const targets = [{ vmId: 'fixture-vm-a', accountId: 'a' }, { vmId: 'alias-01', accountId: 'a' }, { vmId: 'fixture-vm-b', accountId: 'b' }]
  const h = setupFleet(t, { targets, failVm: 'fixture-vm-a' })
  assert.throws(() => h.scheduler.run(), /1\/2/)
  assert.equal(h.result().targets.length, 2)
  assert.deepEqual(h.result().targets.map(row => row.status), ['error', 'ok'])
  assert.equal(h.result().status, 'error')
})

test('路由无法确认不能记成功，发现账户失败不退回公共路由', t => {
  const h = setupFleet(t, { routeMismatch: true })
  assert.throws(() => h.scheduler.run(), /2\/2/)
  assert(h.result().targets.every(row => row.status === 'error' && /路由/.test(row.reason)))
  const broken = setupFleet(t, { discoverFails: true })
  assert.throws(() => broken.scheduler.run(), /SSH/)
  assert(broken.calls.every(row => row.file === 'ssh' || row.file === 'systemctl'))
})
