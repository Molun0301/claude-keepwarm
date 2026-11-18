import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// 所有模型与会话调用都由内存替身接管；测试不启动客户端，不读取凭据或访问网络。
let version = 0
const rich = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 3, model: '模拟模型' }
const empty = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
async function harness(options = {}) {
  const { register } = await import(`../plugins/keepwarm/hooks/keepwarm.ts?test=${++version}`)
  const handlers = [], files = new Map(Object.entries(options.files ?? {})), env = new Map(Object.entries({ HOME: '/mock', KEEPWARM_INTERVAL_MIN: '50', KEEPWARM_MAX_BUMPS: '12', KEEPWARM_POLL_SEC: '60', KEEPWARM_MIN_CONTEXT_TOKENS: '1', ...options.env }))
  let now = options.now ?? 1_000
  let turns = 0, sessionId = options.sessionId ?? 's1'
  const timers = [], deliveries = [], aborts = [], forks = [], logs = [], continuations = [], refreshes = [], output = [], logCalls = [], wakeCalls = [], registeredTools = []
  const quota = { used: 0, resetAt: null, accountId: 'account-1', available: true, age: 0, sourceValid: true, stale: false, ...options.quota }
  if (quota.used >= 90 && !quota.resetAt) quota.resetAt = now + 5 * 3600000
  const agents = [], transcripts = new Map(Object.entries(options.transcripts ?? {}))
  let forkResult = { isAnswered: true, text: '.', usage: rich }
  let proxy = options.proxy
  const proxyCalls = []
  let deliveryResult = { isDelivered: true }
  const $ = {
    plugin: { name: 'keepwarm', root: '/mock/plugin' },
    env: { get: async key => env.get(key), set: async (key, value) => value === undefined ? env.delete(key) : env.set(key, value) },
    session: { id: async () => sessionId, send: async value => { deliveries.push(value); return deliveryResult } },
    agent: { list: async () => agents },
    clock: { now: async () => now, every: (ms, callback) => { const timer = { ms, callback, cancelled: false, cancel() { this.cancelled = true } }; timers.push(timer); return timer } },
    fs: { read: async path => {
      if (files.has(path)) return files.get(path)
      if (path.endsWith('/local-statusline-quota-config.json')) return JSON.stringify({base_url:'https://quota.example', vm_id:'fixture-vm-a'})
      if (path.endsWith('/cache/local-statusline-quota.json')) {
        if (!quota.available) throw Error('模拟额度数据不可用')
        return JSON.stringify({_source:quota.sourceValid ? 'vm2api:https://quota.example:fixture-vm-a' : '错误来源', _ts:now-quota.age, data:{vm_id:'fixture-vm-a',account_id:quota.accountId,five_hour:{used_percent:quota.used,reset_at:quota.resetAt === '' ? null : new Date(quota.resetAt ?? now+5*3600000).toISOString(),reset_elapsed:quota.resetElapsed === true,stale:quota.stale}}})
      }
      throw Error('文件不存在')
    }, write: async (path, text) => {
      if (options.onStateWrite && path.includes('/keepwarm/sessions/')) await options.onStateWrite(path, text)
      files.set(path, text)
    }, exists: async path => path.endsWith('/local-statusline.js') || files.has(path) },
    process: { run: async (argv, init) => {
      if (argv[1]?.endsWith('/daily-wake.cjs')) {
        wakeCalls.push({argv,init})
        return {exitCode:options.wakeError ? 1 : 0,stdout:'每日唤醒：未开启。',stderr:options.wakeError ?? ''}
      }
      if (argv[1]?.endsWith('/vm2api-session.cjs')) {
        const call = { action: argv[2], sessionId: argv[3], body: JSON.parse(argv[4] || '{}') }
        proxyCalls.push(call)
        // 默认模拟不支持智能路由的代理，现有用例保持原行为。
        const reply = proxy ? await proxy(call) : { ok: false, status: 404, code: 'http_404' }
        return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' }
      }
      if (argv[1]?.endsWith('/cache-ttl.cjs')) return {exitCode:transcripts.has(argv[2]) ? 0 : 1,stdout:transcripts.get(argv[2]) ?? '',stderr:''}
      if (argv[1]?.endsWith('/append-log.cjs')) {
        logCalls.push({argv,init})
        if(options.failLogWrite) return {exitCode:1,stdout:'',stderr:'模拟写入失败'}
        files.set(argv[2], (files.get(argv[2])??'')+init.stdin+'\n')
        return {exitCode:0,stdout:'',stderr:''}
      }
      refreshes.push({argv,init});if(options.onQuotaRefresh)await options.onQuotaRefresh(quota)
      return {exitCode:0,stdout:'',stderr:''}
    } },
    prompt: { submit: async value => { continuations.push(value); return {text:value.text} } },
    command: { register: async () => {} },
    tool: { register: async value => { registeredTools.push(value); return {tool:'mcp__keepwarm__'+value.name} } },
    ui: { log: async text => logs.push(text) },
    model: { fork: async request => { forks.push(request); return forkResult } },
    turn: { abort: async value => { aborts.push(value) } },
  }
  register((name, match, fn) => { const entry={ name, match: fn ? match : null, fn: fn ?? match }; handlers.push(entry); return {catch: fn => {entry.catch=fn}} })
  const handler = (name, e) => handlers.find(h => h.name === name && (!h.match || Object.entries(h.match).every(([k, v]) => e[k] === v)))?.fn
  const emit = async (name, e, result = {}) => {
    const fn = handler(name, e)
    return fn ? fn($, e, async () => result) : result
  }
  const step = async (id, turnId, usage = rich, origin = {plugin:'engine',tier:'core'}) => {
    const fn = handler('turn.step', {})
    const result = { turnId, index: 0, usage, answer: '.', toolUses: [], stopReason: 'end_turn' }
    let bottomCalled = false
    const next = () => {
      bottomCalled = true
      const stream = (async function* () { yield { kind: 'stop', usage }; return result })()
      stream.result = Promise.resolve(result)
      return stream
    }
    next.origin = origin
    const stream = fn($, { agentId: id === 'main' ? undefined : id, turnId, index: 0, model: '模拟模型', messageCount: 3 }, next)
    for await (const chunk of stream) { output.push(chunk) }
    return bottomCalled
  }
  const turn = async (id = 'main', usage = rich) => {
    const turnId = `${id}-real-${now}-${++turns}`
    await emit('turn.start', { agentId: id === 'main' ? undefined : id, turnId, text: '真实工作' })
    await step(id, turnId, usage)
    await emit('turn.complete', { agentId: id === 'main' ? undefined : id, turnId, answer: '正常任务结果', reason: 'answer', usage })
  }
  const spawn = async (id, type = 'general-purpose') => {
    const name=options.names?.[id]
    agents.push({ id, type, description: id, status: 'running' })
    await emit('agent.spawn', { subagentType: type, description: id, name }, { agentId: id, model: '模拟模型', ...(name?{teammateId:name+'@test'}:{}) })
  }
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }
  const tick = async minutes => { now += minutes * 60_000; if (!timers.at(-1).cancelled) timers.at(-1).callback(); await flush() }
  const state = () => JSON.parse(files.get(`/mock/.claude/keepwarm/sessions/${sessionId}.json`))
  const answer = async (id, usage = rich, reason = 'answer') => {
    const message = deliveries.findLast(d => d.to.agentId === id)?.text
    assert(message, '子代理必须先收到对应投递')
    const marker = /\[keepwarm:([^\]]+)\]/.exec(message)[1]
    const turnId = `${id}-ping-${now}`
    await emit('turn.start', { agentId: id, turnId, text: `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.` })
    await step(id, turnId, usage)
    await emit('turn.complete', { agentId: id, turnId, answer: marker, usage, reason, isAborted: reason === 'aborted' })
    return { marker, turnId }
  }
  await emit('session.start', {})
  const journal = () => (files.get(`/mock/.claude/keepwarm/logs/${sessionId}.jsonl`)??'').trim().split('\n').filter(Boolean).map(JSON.parse)
  const control = async (action, agent_id, agentId) => {
    const reply=await emit('tool.call', { tool:'mcp__keepwarm__keepwarm_control', action, ...(agent_id === undefined ? {} : {agent_id}), ...(agentId ? {agentId} : {}) })
    assert.equal(typeof reply.result,'string','注册工具必须按宿主契约返回JSON文本')
    return {...reply,result:JSON.parse(reply.result)}
  }
  return { proxyCalls, setProxy: value => { proxy = value }, $, env, files, transcripts, timers, deliveries, aborts, forks, logs, agents, emit, step, turn, spawn, tick, flush, state, answer, continuations, refreshes, output, quota, journal, logCalls, wakeCalls, registeredTools, control, setSession: value => { sessionId = value }, setQuota: value => { Object.assign(quota,value); if(quota.used>=90&&!quota.resetAt) quota.resetAt=now+5*3600000 }, setFork: value => forkResult = value, setDelivery: value => deliveryResult = value, setNow: value => { now = value }, get now() { return now } }
}
const notice = (id, answer) => `<system-reminder><task-notification><task-id>${id}</task-id><status>completed</status><result>${answer}</result></task-notification></system-reminder>`

test('按对话开关：注册可供主代理直接调用的查询与控制工具', async () => {
  const h = await harness()
  assert.equal(h.registeredTools[0].name, 'keepwarm_control')
  assert.equal(h.registeredTools[0].isDeferred, false)
  const answer = await h.control('status')
  assert.equal(answer.result.ok, true)
  assert.deepEqual(answer.result.targets.map(t => t.agent_id), ['main'])
  assert.equal(h.forks.length+h.deliveries.length, 0)
})

test('按对话开关：关闭单个子代理，其他子代理继续，普通续做不重开', async () => {
  const h = await harness({ env:{KEEPWARM_INTERVAL_MIN:'55'} })
  for (const id of ['A','B']) { await h.spawn(id); await h.turn(id) }
  assert.equal((await h.control('off','A')).result.targets[0].keepwarm_enabled, false)
  await h.turn('A'); await h.tick(55)
  assert.equal(h.state().targets.find(r=>r.id==='A').manualOff, true)
  assert.deepEqual(h.deliveries.map(d=>d.to.agentId), ['B'])
  assert.equal(h.state().state, 'active')
})

test('按对话开关：主对话可独立关闭，子代理仍保活，55分钟和12次保留', async () => {
  const h = await harness({ env:{KEEPWARM_INTERVAL_MIN:'55'} })
  await h.turn(); await h.spawn('A'); await h.turn('A')
  await h.emit('command.run',{command:'keepwarm',args:'off main'})
  await h.tick(55)
  assert.equal(h.forks.length,0); assert.equal(h.deliveries.length,1)
  assert.equal(h.state().targets.find(t=>t.id==='main').manualOff,true)
  const result=await h.control('status')
  assert.equal(result.result.interval_minutes,55); assert.equal(result.result.max_bumps,12)
})

test('按对话开关：重载持久保留关闭，旧状态默认开启', async () => {
  const h=await harness(); await h.spawn('A'); await h.turn('A'); await h.control('off','A')
  const again=await harness({files:Object.fromEntries(h.files),now:h.now})
  await again.turn('A'); await again.tick(50)
  assert.equal(again.deliveries.length,0)
  assert.equal((await again.control('status','A')).result.targets[0].manual_off,true)
  const old={version:4,state:'active',roundBumps:0,targets:[{id:'main',label:'主对话',requestAt:1000,contextTokens:100000,bumps:0,roundBumps:0}]}
  const migrated=await harness({files:{'/mock/.claude/keepwarm/sessions/s1.json':JSON.stringify(old)}})
  await migrated.tick(50); assert.equal(migrated.forks.length,1)
})

test('按对话开关：开启保留原缓存年龄，过期不重建，上限不重置', async () => {
  const h=await harness(); await h.turn(); await h.control('off','main')
  await h.tick(61); await h.control('on','main'); await h.tick(1)
  assert.equal(h.forks.length,0)
  assert.equal(h.state().targets[0].requestAt,1000)
  await h.turn(); await h.tick(50)
  for(let i=1;i<12;i++) await h.tick(50)
  await h.control('off','main'); await h.control('on','main'); await h.tick(1)
  assert.equal(h.forks.length,12); assert.equal(h.state().targets[0].roundBumps,12)
})

test('按对话开关：关闭期间额度保护和重置继续仍有效', async () => {
  const h=await harness({quota:{used:95,resetAt:1000+3600000}})
  await h.control('off','main')
  await h.turn()
  assert.equal(h.state().workPaused,true); assert.deepEqual(h.state().deferredWork,['main'])
  h.setQuota({used:0,resetAt:1000+6*3600000}); await h.tick(1)
  assert.equal(h.continuations.length,1)
  assert.equal(h.state().targets[0].manualOff,true)
})

test('按对话开关：查询给出宿主状态与保活开关两个维度', async () => {
  const h=await harness();await h.spawn('A');await h.turn('A')
  h.agents[0].status='completed'
  const answer=(await h.control('status','A')).result.targets[0]
  assert.equal(answer.host_status,'completed');assert.equal(answer.keepwarm_enabled,true)
  assert.equal(answer.model,'模拟模型');assert.equal(answer.agent_type,'general-purpose')
  await h.control('off','A')
  const result=await h.emit('command.run',{command:'keepwarm',args:'status A'})
  assert.match(result.text,/手动关闭/)
})

test('按对话开关：主代理控制只接受本会话目标，子代理不能更改或查询', async () => {
  const h=await harness();await h.spawn('A')
  for(const action of ['off','on','status']){
    const reply=await h.control(action,'main','A')
    assert.equal(reply.isError,true);assert.equal(reply.result.error,'main_only')
  }
  const bad=await h.control('off','foreign')
  assert.equal(bad.isError,true);assert.equal(bad.result.error,'unknown_target')
  const invalid=await h.control('delete','main')
  assert.equal(invalid.isError,true)
  assert.equal(h.forks.length+h.deliveries.length,0)
})

test('按对话开关：已经投递的保活迟到仍计量和过滤，不能重开', async () => {
  const h=await harness();await h.spawn('A');await h.turn('A');await h.tick(50)
  await h.control('off','A')
  const {marker}=await h.answer('A')
  assert.equal(h.state().agentBumps,1);assert.equal(h.state().targets.find(t=>t.id==='A').manualOff,true)
  const result=await h.emit('prompt.submit',{origin:{kind:'task-notification'},text:notice('A',marker)},{text:'保留'})
  assert(result.drop)
  await h.tick(50);assert.equal(h.deliveries.length,1)
})

test('按对话开关：发送前等待日志期间关闭，主对话和子代理都不发请求', async () => {
  for(const id of ['main','A']){
    const h=await harness();if(id==='A')await h.spawn('A');await h.turn(id)
    const original=h.$.process.run
    let release, reached
    const ready=new Promise(resolve=>{reached=resolve})
    h.$.process.run=async(argv,init)=>{
      if(init?.stdin&&JSON.parse(init.stdin).event==='ping_scheduled'){
        reached();await new Promise(resolve=>{release=resolve})
      }
      return original(argv,init)
    }
    await h.tick(50);await ready
    const closing=h.control('off',id)
    await h.flush();release();await closing;await h.flush()
    assert.equal(h.deliveries.length+h.forks.length,0)
  }
})

test('按对话开关：持久化失败明确返回，当前进程仍阻止后续保活', async () => {
  let fail=false
  const h=await harness({onStateWrite:async()=>{if(fail)throw Error('模拟磁盘失败')}})
  await h.turn();fail=true
  const reply=await h.control('off','main')
  assert.equal(reply.isError,true);assert.equal(reply.result.error,'state_write_failed')
  await h.tick(50);assert.equal(h.forks.length,0)
})

test('按对话开关：并发旧状态写入完成后不会覆盖新关闭状态', async () => {
  let hold=false,release,reached
  const ready=new Promise(resolve=>{reached=resolve})
  const h=await harness({onStateWrite:async()=>{
    if(hold){hold=false;reached();await new Promise(resolve=>{release=resolve})}
  }})
  await h.turn();hold=true
  const work=h.turn();await ready
  const closing=h.control('off','main');await h.flush();release()
  await Promise.all([work,closing])
  assert.equal(h.state().targets[0].manualOff,true)
})

test('按对话开关：清空会话不把旧关闭选项串到新会话', async () => {
  const h=await harness();await h.turn();await h.control('off','main')
  await h.emit('session.end',{reason:'clear',sessionId:'s1'});h.setSession('fresh');await h.turn()
  assert.equal((await h.control('status','main')).result.targets[0].keepwarm_enabled,true)
  assert.equal(JSON.parse(h.files.get('/mock/.claude/keepwarm/sessions/s1.json')).targets[0].manualOff,true)
})

test('按对话开关：有效缓存重新开启后沿用原请求时间续期', async () => {
  const h=await harness();await h.spawn('A');await h.turn('A');await h.control('off','A')
  await h.tick(30);await h.control('on','A');await h.tick(19)
  assert.equal(h.deliveries.length,0)
  await h.tick(1);assert.equal(h.deliveries[0].to.agentId,'A')
})

test('按对话开关：主对话在途结果迟到不会清掉手动关闭', async () => {
  const h=await harness();await h.turn()
  let finish;h.setFork(new Promise(resolve=>{finish=resolve}))
  await h.tick(50);await h.control('off','main')
  finish({isAnswered:true,text:'.',usage:rich});await h.flush()
  assert.equal(h.state().mainBumps,1);assert.equal(h.state().targets[0].manualOff,true)
  await h.tick(50);assert.equal(h.forks.length,1)
})

test('按对话开关：目标开启不解除当前会话关闭，查询仍可使用', async () => {
  const h=await harness();await h.turn()
  await h.emit('command.run',{command:'keepwarm',args:'off'})
  await h.control('off','main');const reply=await h.control('on','main')
  assert.equal(reply.result.plugin_enabled,false)
  assert.equal(reply.result.targets[0].effective_state,'session_off')
  await h.tick(50);assert.equal(h.forks.length,0)
})

test('按对话开关：宿主列表暂不可读仍返回已保存开关并标明未知', async () => {
  const h=await harness();await h.spawn('A');await h.turn('A');await h.control('off','A')
  h.$.agent.list=async()=>{throw Error('模拟宿主接口不可用')}
  const result=(await h.control('status','A')).result
  assert.equal(result.ok,true);assert.equal(result.targets[0].manual_off,true)
  assert.equal(result.targets[0].host_status,'unknown');assert(result.host_status_error)
})

test('恢复历史会话不重新触发初始化事件时仍重绑状态并继续保活', async () => {
  const target = { version: 4, state: 'active', roundBumps: 2, targets: [{ id: 'main', label: '主对话', bumps: 7, roundBumps: 2, requestAt: 1000, contextTokens: 100000 }] }
  const h = await harness({ files: { '/mock/.claude/keepwarm/sessions/history.json': JSON.stringify(target) } })
  await h.emit('session.end', { reason: 'resume', sessionId: 's1' })
  h.setSession('history')
  await h.tick(50)
  assert.equal(h.state().state, 'active')
  assert.equal(h.state().mainBumps, 8)
  assert.equal(h.state().roundBumps, 3)
  assert(h.journal().every(row => row.session_id === 'history'))
  assert.equal(JSON.parse(h.files.get('/mock/.claude/keepwarm/sessions/s1.json')).state, 'stopped')
})

test('清空会话后首次普通请求独立计数并重新启动定时器', async () => {
  const h = await harness(); await h.turn(); await h.tick(50)
  await h.emit('session.end', { reason: 'clear', sessionId: 's1' })
  h.setSession('fresh')
  await h.turn()
  assert.equal(h.state().mainBumps, 0)
  assert.equal(h.state().state, 'active')
  await h.tick(50)
  assert.equal(h.state().mainBumps, 1)
  assert.equal(h.forks.length, 2)
})

test('真正退出后取消定时器且迟到事件不重启保活', async () => {
  const h = await harness(); await h.turn()
  await h.emit('session.end', { reason: 'prompt_input_exit', sessionId: 's1' })
  await h.emit('command.run', { command: 'keepwarm', args: 'status' })
  await h.tick(50)
  assert(h.timers.every(t => t.cancelled))
  assert.equal(h.forks.length, 0)
  assert.equal(h.state().state, 'stopped')
})

test('切换时旧主对话保活迟到不串写新会话且仅保留一个定时器', async () => {
  const h = await harness(); await h.turn()
  let finish
  h.setFork(new Promise(resolve => { finish = resolve }))
  await h.tick(50)
  await h.emit('session.end', { reason: 'resume', sessionId: 's1' })
  h.setSession('new-session')
  await h.turn()
  finish({ isAnswered: true, text: '.', usage: rich })
  await h.flush()
  assert.equal(h.state().mainBumps, 0)
  assert.equal(h.state().state, 'active')
  assert.equal(h.timers.filter(t => !t.cancelled).length, 1)
  assert(!h.journal().some(row => row.event === 'ping_succeeded'))
})

test('恢复操作最终留在原会话时状态命令可恢复身份检查', async () => {
  const h = await harness(); await h.turn()
  await h.emit('session.end', { reason: 'resume', sessionId: 's1' })
  await h.emit('command.run', { command: 'keepwarm', args: 'status' })
  await h.tick(50)
  assert.equal(h.state().mainBumps, 1)
})

test('子代理超时不调用仅支持主对话的取消接口且只处理一次', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); h.setNow(61000); await h.turn()
  await h.tick(50)
  await h.emit('turn.start', { agentId: 'A', turnId: 'slow-agent-ping', text: h.deliveries[0].text })
  h.$.turn.abort = async () => { throw Error('turnId is not the running main turn') }
  await h.tick(2); await h.tick(1)
  assert.equal(h.state().targets.find(t => t.id === 'A').state, 'stopped')
  assert.equal(h.journal().filter(row => row.event === 'ping_timeout').length, 1)
  assert.equal(h.forks.length, 1, '一路超时不能永久阻塞其他会话')
  assert.equal(h.aborts.length, 0)
  assert.equal(await h.step('A', 'slow-agent-ping'), false)
})

test('普通子代理恢复跳过开始事件时，精确完成回复仍核对真实用量并计数', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const marker = /\[keepwarm:([^\]]+)\]/.exec(h.deliveries[0].text)[1]
  await h.emit('turn.complete', { agentId: 'A', turnId: 'resumed-agent', answer: marker, reason: 'answer', usage: rich })
  assert.equal(h.state().agentBumps, 1)
  assert(h.journal().some(row => row.event === 'ping_received' && row.format === 'completion'))
  await h.tick(1)
  assert(!h.journal().some(row => row.event === 'ping_timeout'))
  const result = await h.emit('prompt.submit', { origin: { kind: 'task-notification' }, text: notice('A', marker) }, { text: '保留' })
  assert(result.drop)
})

test('普通完成回复不能替代尚未识别的保活回合', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const marker = /\[keepwarm:([^\]]+)\]/.exec(h.deliveries[0].text)[1]
  await h.emit('turn.complete', { agentId: 'A', turnId: 'unrelated', answer: marker+' 继续任务', reason: 'answer', usage: rich })
  assert.equal(h.state().agentBumps, 0)
})

test('普通子代理完成通知先到时按待处理精确标记过滤，避免额外父会话请求', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const marker = /\[keepwarm:([^\]]+)\]/.exec(h.deliveries[0].text)[1]
  const result = await h.emit('prompt.submit', { origin: { kind: 'task-notification' }, text: notice('A', marker) }, { text: '保留' })
  assert(result.drop)
  assert.equal(h.state().agentBumps, 0, '过滤通知不能冒充已核对成功用量')
})

test('新会话没有真实缓存请求时不补写缓存', async () => {
  const h = await harness(); await h.tick(50)
  assert.equal(h.forks.length + h.deliveries.length, 0)
  assert.equal(h.state().bumps, 0)
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), '1h')
})

test('主会话五十分钟到期才重放并计数', async () => {
  const h = await harness(); await h.turn(); await h.tick(49)
  assert.equal(h.forks.length, 0)
  await h.tick(1)
  assert.equal(h.forks.length, 1); assert.equal(h.state().mainBumps, 1)
  assert.equal(h.state().agentBumps, 0)
})

test('三个子代理分别投递、独立计数且不并发发送', async () => {
  const h = await harness()
  for (const id of ['A', 'B', 'C']) { await h.spawn(id); await h.turn(id) }
  await h.tick(50); assert.equal(h.deliveries.length, 1)
  await h.tick(0.5); assert.equal(h.deliveries.length, 1)
  for (const [index, id] of ['A', 'B', 'C'].entries()) {
    assert.equal(h.deliveries[index].to.agentId, id)
    await h.answer(id)
    if (id !== 'C') await h.tick(1)
  }
  assert.equal(h.state().bumps, 3); assert.equal(h.state().mainBumps, 0)
  assert.deepEqual(h.state().targets.filter(t => t.id !== 'main').map(t => t.bumps), [1, 1, 1])
  assert.equal(h.forks.length, 0)
})

test('主对话忙碌时，已经空闲的子代理仍可独立保活', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A')
  await h.emit('turn.start', { turnId: 'main-working', text: '工作' })
  await h.tick(50)
  assert.equal(h.deliveries[0].to.agentId, 'A'); assert.equal(h.forks.length, 0)
})

test('忙碌的子代理不插入保活消息', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A')
  await h.emit('turn.start', { agentId: 'A', turnId: 'A-working', text: '长任务' })
  await h.tick(50); assert.equal(h.deliveries.length, 0)
})

test('达到十二次后只停止该路，其他路继续', async () => {
  const h = await harness()
  await h.spawn('A'); await h.spawn('B'); await h.turn('A'); await h.turn('B')
  for (let i = 0; i < 11; i++) {
    await h.tick(i ? 49 : 50); await h.answer('A'); await h.tick(1); await h.answer('B')
  }
  await h.tick(49); await h.answer('A')
  const a = h.state().targets.find(t => t.id === 'A')
  assert.equal(a.bumps, 12); assert.equal(a.state, 'stopped')
  await h.tick(1); assert.equal(h.deliveries.at(-1).to.agentId, 'B')
  await h.answer('B'); await h.tick(50)
  assert.equal(h.deliveries.length, 24)
})

test('缓存过期后不发重建请求', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(61)
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.state().targets.find(t => t.id === 'A').cold, true)
})

test('小上下文不消耗保活请求', async () => {
  const h = await harness({ env: { KEEPWARM_MIN_CONTEXT_TOKENS: '20000' } })
  await h.spawn('A'); await h.turn('A', { ...rich, cache_read_input_tokens: 1000 }); await h.tick(50)
  assert.equal(h.deliveries.length, 0)
})

test('投递成功不等于保活成功，必须等实际缓存读取', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  assert.equal(h.state().agentBumps, 0)
  await h.answer('A'); assert.equal(h.state().agentBumps, 1)
})

test('缓存写入超过读取时停用该路', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  await h.answer('A', { ...rich, cache_read_input_tokens: 0, cache_creation_input_tokens: 100000 })
  assert.equal(h.state().agentBumps, 0)
  assert.equal(h.state().targets.find(t => t.id === 'A').state, 'stopped')
  await h.tick(50); assert.equal(h.deliveries.length, 1)
})

test('无缓存读取或请求错误不增加成功次数', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A')
  for (let i = 0; i < 3; i++) { await h.tick(i ? 1 : 50); await h.answer('A', empty, 'error') }
  assert.equal(h.state().agentBumps, 0)
  assert.equal(h.state().targets.find(t => t.id === 'A').state, 'stopped')
})

test('保活回合超时只封存自己的回合', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const text = h.deliveries[0].text
  await h.emit('turn.start', { agentId: 'A', turnId: 'own-ping', text })
  await h.tick(2)
  assert.deepEqual(h.aborts, [])
  assert.equal(h.state().targets.find(t => t.id === 'A').state, 'stopped')
})

test('保活工具被拒绝，正常工作工具仍放行', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  await h.emit('turn.start', { agentId: 'A', turnId: 'own', text: h.deliveries[0].text })
  const denied = await h.emit('tool.check', { agentId: 'A', tool: 'Bash', input: { command: '不应执行' } }, { decision: 'allow' })
  assert.equal(denied.decision, 'deny'); assert.equal(h.aborts.length, 0)
  await h.emit('turn.start', { agentId: 'A', turnId: 'user', text: '用户正常工作' })
  const allowed = await h.emit('tool.check', { agentId: 'A', tool: 'Read', input: {} }, { decision: 'allow' })
  assert.equal(allowed.decision, 'allow')
})

test('只有完整匹配的保活回合会被工具保护接管', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  await h.emit('turn.start', { agentId: 'A', turnId: 'user', text: `请检查这段引用：${h.deliveries[0].text}，并完成用户任务。` })
  const result = await h.emit('tool.check', { agentId: 'A', tool: 'Read', input: {} }, { decision: 'allow' })
  assert.equal(result.decision, 'allow')
})

test('仅过滤自己的完成通知，正常、混合和用户输入均保留', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const { marker } = await h.answer('A')
  const own = notice('A', marker)
  assert((await h.emit('prompt.submit', { text: own, origin: { kind: 'task-notification' } })).drop)
  assert.equal((await h.emit('prompt.submit', { text: notice('A', '正常结果'), origin: { kind: 'task-notification' } }, { text: '保留' })).text, '保留')
  assert.equal((await h.emit('prompt.submit', { text: own + notice('B', '其他结果'), origin: { kind: 'task-notification' } }, { text: '保留' })).text, '保留')
  assert.equal((await h.emit('prompt.submit', { text: own, origin: { kind: 'composer' } }, { text: '用户' })).text, '用户')
  assert.equal((await h.emit('prompt.submit', { text: own, origin: { kind: 'task-notification' }, attachments: [{}] }, { text: '附件' })).text, '附件')
})

test('一次性 Explore 和 Plan 不纳入自动继续', async () => {
  const h = await harness()
  for (const [id, type] of [['E', 'Explore'], ['P', 'Plan']]) { await h.spawn(id, type); await h.turn(id) }
  await h.tick(50)
  assert.equal(h.state().agentCount, 0); assert.equal(h.deliveries.length, 0)
})

test('用户取消后不自动唤醒', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A')
  await h.emit('turn.complete', { agentId: 'A', turnId: 'A-cancel', answer: '', reason: 'aborted', isAborted: true })
  await h.tick(50); assert.equal(h.deliveries.length, 0)
})

test('会话关闭覆盖所有路，重新开启不重置次数', async () => {
  const h = await harness(); await h.turn()
  await h.emit('command.run', { command: 'keepwarm', args: 'off' }); await h.tick(50)
  assert.equal(h.forks.length, 0); assert.equal(h.state().state, 'paused')
  await h.emit('command.run', { command: 'keepwarm', args: 'on' }); await h.tick(1)
  assert.equal(h.forks.length, 1); assert.equal(h.state().bumps, 1)
})

test('缓存年龄从请求开始计算，长回复完成不会延长有效期', async () => {
  const h = await harness(); await h.emit('turn.start', { turnId: 'long', text: '长回复' })
  await h.step('main', 'long'); h.setNow(h.now + 61 * 60000)
  await h.emit('turn.complete', { turnId: 'long', answer: '完成', reason: 'answer', usage: rich })
  await h.tick(0); assert.equal(h.forks.length, 0); assert.equal(h.state().cold, true)
})

test('结束会话会清理定时器并恢复子代理缓存设置', async () => {
  const h = await harness({ env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' } })
  await h.emit('session.end', {})
  assert.equal(h.timers[0].cancelled, true)
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), '5m')
  await h.tick(50); assert.equal(h.forks.length, 0)
})

test('主对话快照为空时等待真实请求，不误计成功', async () => {
  const h = await harness(); await h.turn(); h.setFork({ isAnswered: false, reason: 'nothing-to-fork' }); await h.tick(50)
  assert.equal(h.state().bumps, 0); assert.equal(h.state().targets[0].cold, true)
})

test('已从运行列表移除的已知子代理仍按原标识投递', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); h.agents.splice(0)
  await h.tick(50); assert.equal(h.deliveries[0].to.agentId, 'A')
})

test('投递遭拒绝时停止目标，不发给其他会话', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); h.setDelivery({ isDelivered: false, reason: '用户已取消此代理' })
  await h.tick(50)
  assert.equal(h.state().targets.find(t => t.id === 'A').state, 'stopped')
  assert.equal(h.state().bumps, 0)
})

test('状态只恢复本会话，过期状态不触发请求', async () => {
  const saved = { version: 2, state: 'active', targets: [{ id: 'main', label: '主对话', requestAt: 1000, contextTokens: 100000, bumps: 2 }, { id: 'A', label: 'A', requestAt: 1000, contextTokens: 100000, bumps: 3 }] }
  const path = '/mock/.claude/keepwarm/sessions/s1.json'
  const h = await harness({ now: 61 * 60000, files: { [path]: JSON.stringify(saved) } }); await h.tick(0)
  assert.equal(h.state().bumps, 5); assert.equal(h.deliveries.length + h.forks.length, 0)
  const other = await harness({ sessionId: 'other', files: { [path]: JSON.stringify(saved) } })
  assert.equal(other.state().bumps, 0); assert.equal(other.state().agentCount, 0)
})

test('全局关闭标记覆盖所有会话', async () => {
  const h = await harness(); await h.turn(); h.files.set('/mock/.claude/keepwarm-off', '')
  await h.tick(50); assert.equal(h.state().state, 'stopped'); assert.equal(h.forks.length, 0)
})


test('取消接口故障时仍拒绝保活工具', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  await h.emit('turn.start', { agentId: 'A', turnId: 'own', text: h.deliveries[0].text })
  h.$.turn.abort = async () => { throw Error('模拟取消故障') }
  const result = await h.emit('tool.check', { agentId: 'A', tool: 'Bash', input: {} }, { decision: 'allow' })
  assert.equal(result.decision, 'deny')
})

test('恢复的忙碌子代理不被误认为空闲', async () => {
  const saved = { version: 2, targets: [{ id: 'main', requestAt: 0 }, { id: 'A', label: 'A', requestAt: 1000, contextTokens: 100000, busy: true }] }
  const h = await harness({ files: { '/mock/.claude/keepwarm/sessions/s1.json': JSON.stringify(saved) } })
  await h.tick(50); assert.equal(h.deliveries.length, 0)
  assert.equal(h.state().targets.find(t => t.id === 'A').busy, true)
})


test('超时后才开始的队列保活在模型请求前被本地阻断', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  const text = h.deliveries[0].text
  await h.tick(2)
  await h.emit('turn.start', { agentId: 'A', turnId: 'late-ping', text })
  const bottomCalled = await h.step('A', 'late-ping')
  assert.equal(bottomCalled, false, '迟到保活不应触达模型调用底层')
  assert.equal(h.state().agentBumps, 0)
  const denied = await h.emit('tool.check', { agentId: 'A', tool: 'Bash' }, { decision: 'allow' })
  assert.equal(denied.decision, 'deny')
  assert.equal(h.aborts.length, 0, '子代理回合由本地步骤和工具拦截，不调用主对话取消接口')
})

test('每路保存真实读取和创建计数，汇总仍兼容状态栏', async () => {
  const h = await harness(); await h.spawn('A'); await h.turn('A'); await h.tick(50)
  await h.answer('A', { ...rich, cache_creation_input_tokens: 7 })
  const saved = h.state(), agent = saved.targets.find(t => t.id === 'A')
  assert.equal(agent.lastRead, 100000); assert.equal(agent.lastCreated, 7)
  assert.equal(saved.bumps, saved.mainBumps + saved.agentBumps)
})

test('从旧版状态迁移保留已完成保活次数，但不猜测缓存时间', async () => {
  const old = { state: 'active', bumps: 3, lastBumpAt: 100 }
  const h = await harness({ files: { '/mock/.claude/keepwarm/sessions/s1.json': JSON.stringify(old) } })
  await h.tick(50)
  assert.equal(h.state().mainBumps, 3); assert.equal(h.forks.length, 0)
})


// 合成双账户缓存：固定槽为甲，会话实际路由到乙，复现两份读数错配。
const accountQuotaFiles = (used = 100, { now = 1_000, sessionId = 's1', dir = '/mock/.claude' } = {}) => {
  const metadata = { _source: 'vm2api-accounts-v1:https://quota.example', _ts: now }
  const resetAt = new Date(now + 5 * 3600_000).toISOString()
  return {
    [`${dir}/statusline-accounts.js`]: '',
    [`${dir}/cache/statusline-accounts/fleet.json`]: JSON.stringify({ ...metadata, data: [
      { vm_id: 'fixture-vm-a', account_id: 'account-a', five_hour: { used_percent: 14, reset_at: resetAt, stale: false } },
      { vm_id: 'fixture-vm-b', account_id: 'account-b', five_hour: { used_percent: used, reset_at: resetAt, stale: false } },
    ] }),
    [`${dir}/cache/statusline-accounts/route-${sessionId}.json`]: JSON.stringify({ ...metadata, data: { vm_id: 'fixture-vm-b', account_id: 'account-b' } }),
  }
}

test('会话额度：实际账户100%而固定槽14%时，阻断主对话与子代理', async () => {
  const h = await harness({ files: accountQuotaFiles(), quota: { used: 14 } })
  await h.spawn('A')
  for (const id of ['main', 'A']) {
    await h.emit('turn.start', { ...(id === 'main' ? {} : { agentId: id }), turnId: id, text: '继续原任务' })
    assert.equal(await h.step(id, id), false, '不得触达普通模型请求')
  }
  assert.equal(h.state().workPaused, true)
  assert.equal(h.state().quota.usedPercent, 100)
  assert.equal(h.state().quota.accountId, 'account-b')
  assert.deepEqual(h.state().deferredWork.sort(), ['A', 'main'])
  assert.equal(h.journal().filter(r => r.event === 'quota_paused').length, 1)
})

test('会话额度：当前账户14%不会被固定槽100%误拦', async () => {
  const h = await harness({ files: accountQuotaFiles(14), quota: { used: 100 } })
  assert.equal(await h.step('main', 'work'), true)
  assert.equal(h.state().workPaused, false)
  assert.equal(h.state().quota.usedPercent, 14)
  assert.equal(h.state().quota.accountId, 'account-b')
})

test('会话额度：缺失路由不回落固定槽，刷新入口携带当前会话和配置目录', async () => {
  const dir = '/quota-config'
  const files = accountQuotaFiles(100, { dir, sessionId: 'current-session' })
  delete files[`${dir}/cache/statusline-accounts/route-current-session.json`]
  const h = await harness({ sessionId: 'current-session', env: { KEEPWARM_QUOTA_DIR: dir }, files, quota: { used: 100 } })
  assert.equal(h.state().quota.usedPercent, null)
  assert.equal(h.state().workPaused, false)
  assert(h.state().quota.error)
  assert.equal(h.refreshes.length, 1)
  assert.deepEqual(h.refreshes[0].argv, ['node', `${dir}/statusline-accounts.js`, '--refresh', 'current-session', '--force'])
  assert.deepEqual(h.refreshes[0].init.env, { CLAUDE_CONFIG_DIR: dir })
  await h.step('main', 'work')
  assert.equal(h.refreshes.length, 1, '同一30秒内不重复刷新')
})

for (const kind of ['账户不匹配', '虚拟机不匹配', '路由来源不符', '额度来源不符', '路由过期', '额度过期', '未来时间', '账户不可用', '窗口过期']) {
  test(`会话额度：${kind}不采用其他账户`, async () => {
    const now = 100_000, files = accountQuotaFiles(100, { now })
    const routeKey = '/mock/.claude/cache/statusline-accounts/route-s1.json'
    const fleetKey = '/mock/.claude/cache/statusline-accounts/fleet.json'
    const route = JSON.parse(files[routeKey]), fleet = JSON.parse(files[fleetKey])
    if (kind === '账户不匹配') route.data.account_id = 'other-account'
    if (kind === '虚拟机不匹配') route.data.vm_id = 'fixture-vm-a'
    if (kind === '路由来源不符') route._source = 'other-source'
    if (kind === '额度来源不符') fleet._source = 'other-source'
    if (kind === '路由过期') route._ts = now - 30_000
    if (kind === '额度过期') fleet._ts = now - 30_000
    if (kind === '未来时间') route._ts = now + 5_001
    if (kind === '账户不可用') fleet.data[1].unavailable = true
    if (kind === '窗口过期') fleet.data[1].five_hour.reset_at = new Date(now - 1).toISOString()
    files[routeKey] = JSON.stringify(route); files[fleetKey] = JSON.stringify(fleet)
    const h = await harness({ now, files, quota: { used: 100 } })
    assert.equal(h.state().quota.usedPercent, null)
    assert.equal(h.state().workPaused, false)
    assert.equal(h.refreshes[0].argv[1], '/mock/.claude/statusline-accounts.js')
  })
}

test('会话额度：当前账户重置后恢复原队列，失效路由不能提前解除保护', async () => {
  const h = await harness({ files: accountQuotaFiles(), quota: { used: 14 } })
  await h.emit('turn.start', { turnId: 'blocked-work', text: '原任务' })
  assert.equal(await h.step('main', 'blocked-work'), false)
  const routeKey = '/mock/.claude/cache/statusline-accounts/route-s1.json'
  h.files.delete(routeKey)
  await h.tick(0)
  assert.equal(h.state().workPaused, true)
  assert.equal(h.continuations.length, 0)
  const files = accountQuotaFiles(0, { now: h.now })
  const fleetKey = '/mock/.claude/cache/statusline-accounts/fleet.json'
  const fleet = JSON.parse(files[fleetKey])
  fleet.data[1].five_hour.reset_at = null
  files[fleetKey] = JSON.stringify(fleet)
  for (const [key, value] of Object.entries(files)) h.files.set(key, value)
  await h.tick(0)
  assert.equal(h.state().workPaused, false)
  assert.equal(h.continuations.length, 1)
  assert.equal(h.state().quota.accountId, 'account-b')
})

test('会话额度：切换会话只读取新会话路由，不复用旧会话账户', async () => {
  const files = { ...accountQuotaFiles(100), ...accountQuotaFiles(100, { sessionId: 'next-session' }) }
  const key = '/mock/.claude/cache/statusline-accounts/route-next-session.json'
  const route = JSON.parse(files[key]); route.data = { vm_id: 'fixture-vm-a', account_id: 'account-a' }; files[key] = JSON.stringify(route)
  const h = await harness({ files, quota: { used: 100 } })
  assert.equal(h.state().workPaused, true)
  await h.emit('session.end', { reason: 'resume' }); h.setSession('next-session')
  await h.emit('turn.start', { turnId: 'new-work', text: '新会话任务' })
  assert.equal(await h.step('main', 'new-work'), true)
  assert.equal(h.state().quota.usedPercent, 14)
  assert.equal(h.state().quota.accountId, 'account-a')
})

test('89.9%不阻止普通主对话，90%直接阻止且不触达模型', async () => {
  const h = await harness(); h.setQuota({used:89.9})
  assert.equal(await h.step('main','below'),true)
  h.setQuota({used:90})
  assert.equal(await h.step('main','at-limit'),false)
  assert.equal(h.state().workPaused,true)
  assert.deepEqual(h.state().deferredWork,['main'])
  assert(h.output.some(c=>c.kind==='text'&&c.text.includes('普通工作暂停')))
})

test('三个子代理同时到90%均暂停，保留各自继续标识', async () => {
  const h = await harness()
  for(const id of ['A','B','C']) {await h.spawn(id);await h.turn(id)}
  h.setQuota({used:90})
  const calls=await Promise.all(['A','B','C'].map(id=>h.step(id,id+'-paused')))
  assert.deepEqual(calls,[false,false,false])
  assert.deepEqual(h.state().deferredWork.sort(),['A','B','C'])
})

test('普通工作暂停时子代理保活仍通过，只豁免对应保活回合', async () => {
  const h = await harness();await h.spawn('A');await h.turn('A')
  h.setQuota({used:95});await h.step('A','A-paused');await h.tick(50)
  assert.equal(h.deliveries[0].to.agentId,'A')
  await h.answer('A')
  assert.equal(h.state().agentBumps,1)
  assert(h.state().deferredWork.includes('A'))
  assert.equal(await h.step('A','ordinary-next'),false)
})

test('主对话保活期间其他普通请求不能借用豁免', async () => {
  const h = await harness();await h.turn();await h.spawn('A');await h.turn('A')
  h.setQuota({used:95});await h.step('main','paused')
  let ownAllowed,ordinaryAllowed
  h.$.model.fork=async()=>{
    ownAllowed=await h.step('native-fork','own-keepalive',rich,{plugin:'keepwarm',tier:'user'})
    ordinaryAllowed=await h.step('A','ordinary-concurrent')
    return {isAnswered:true,text:'.',usage:rich}
  }
  await h.tick(50)
  assert.equal(ownAllowed,true);assert.equal(ordinaryAllowed,false)
  assert.equal(h.state().mainBumps,1)
})

test('不取消已经发出的请求，也不做预计消耗判断', async () => {
  const h=await harness();h.setQuota({used:89})
  assert.equal(await h.step('main','large-request'),true)
  h.setQuota({used:97})
  assert.equal(h.aborts.length,0)
  assert.equal(await h.step('main','next-request'),false)
  assert.equal(h.aborts.length,0)
})

test('没有额度数据时不新增暂停门槛', async()=>{
  const h=await harness({quota:{available:false}})
  assert.equal(await h.step('main','no-data'),true)
  assert.equal(h.state().workPaused,false)
})

test('已经触发90%后，读取失败不会误判为已重置',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setQuota({available:false});await h.tick(1)
  assert.equal(h.state().workPaused,true);assert.equal(h.continuations.length,0)
})

test('相同窗口读数回落不提前恢复，必须确认重置',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setQuota({used:89});await h.tick(1)
  assert.equal(h.state().workPaused,true);assert.equal(h.continuations.length,0)
})

test('确认新窗口后自动继续主对话，且只触发一次',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.tick(1)
  assert.equal(h.state().workPaused,false);assert.equal(h.continuations.length,1)
  assert(h.continuations[0].text.includes('继续之前'))
  assert.equal(h.continuations[0].asUser,undefined)
  await h.tick(1);assert.equal(h.continuations.length,1)
})

test('重置后先恢复原子代理，再通知主对话协调，避免重复派发',async()=>{
  const h=await harness();for(const id of ['A','B','C']){await h.spawn(id);await h.turn(id)}
  h.setQuota({used:95});for(const id of ['A','B','C','main'])await h.step(id,'pause-'+id)
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.tick(1)
  assert.deepEqual(h.deliveries.map(x=>x.to.agentId),['A','B','C'])
  assert(h.deliveries.every(x=>x.text.includes('keepwarm-auto-resume')))
  assert.equal(h.continuations.length,1)
  assert(h.continuations[0].text.includes('A (A)'))
  assert.deepEqual(h.state().deferredWork,[])
})

test('用户取消的已暂停子代理不会自动恢复',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A')
  h.setQuota({used:95});await h.step('A','pause')
  await h.emit('turn.complete',{agentId:'A',turnId:'cancel',answer:'',reason:'aborted',isAborted:true})
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.tick(1)
  assert.equal(h.deliveries.length,0)
})

test('手动继续已经恢复的任务后，不再额外自动重复继续',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.turn('main');await h.tick(1)
  assert.equal(h.continuations.length,0)
})

test('其他来源的额度缓存不能触发90%保护',async()=>{
  const h=await harness({quota:{used:99,sourceValid:false}})
  assert.equal(await h.step('main','normal'),true)
})

test('过期数据会调用现有只读刷新入口，刷新后按新读数判断',async()=>{
  const h=await harness({quota:{used:95,age:60000},onQuotaRefresh:async q=>{q.age=0}})
  assert.equal(h.refreshes.length,1)
  assert(h.refreshes[0].argv.at(-1)==='--refresh')
  assert.equal(await h.step('main','paused'),false)
})

test('重启保留90%保护与自动继续队列',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  const saved=h.state()
  const restarted=await harness({files:{'/mock/.claude/keepwarm/sessions/s1.json':JSON.stringify(saved)},quota:{used:0,resetAt:h.now+10*3600000}})
  await restarted.tick(1)
  assert.equal(restarted.continuations.length,1)
  assert.equal(restarted.state().workPaused,false)
})

test('正常完成的任务不在重置后被无故重启',async()=>{
  const h=await harness();await h.turn();h.setQuota({used:95});await h.tick(1)
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.tick(1)
  assert.equal(h.continuations.length,0);assert.equal(h.deliveries.length,0)
})

test('到期窗口已归零但服务端仍保留旧重置时刻时自动继续',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A')
  h.setQuota({used:95});await h.step('A','pause-child');await h.step('main','pause-main')
  const oldReset=h.quota.resetAt
  h.setNow(oldReset+1);h.setQuota({used:0,resetAt:oldReset,resetElapsed:true})
  await h.tick(0)
  assert.equal(h.state().quota.usedPercent,0);assert.equal(h.state().workPaused,false)
  assert.equal(h.deliveries[0].to.agentId,'A');assert.equal(h.continuations.length,1)
  await h.tick(1);assert.equal(h.continuations.length,1)
})

test('接口明确为零但新窗口未开始计时也能自动继续',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setQuota({used:0,resetAt:''});await h.tick(1)
  assert.equal(h.state().workPaused,false);assert.equal(h.continuations.length,1)
  assert.equal(h.state().quota.resetAt,'')
})

test('旧窗口未归零的过期读数不能被当作新窗口',async()=>{
  const h=await harness();h.setQuota({used:95});await h.step('main','pause')
  h.setNow(h.quota.resetAt+1);await h.tick(0)
  assert.equal(h.state().workPaused,true);assert.equal(h.continuations.length,0)
})

test('无参数关闭：91%时off停用整个会话，主对话与子代理均可继续', async () => {
  const h = await harness({ env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' } })
  await h.turn(); await h.spawn('A'); await h.turn('A')
  h.setQuota({ used: 91 })
  assert.equal(await h.step('main', 'blocked-main'), false)
  assert.equal(await h.step('A', 'blocked-child'), false)
  const reply = await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  assert.equal(h.state().state, 'paused')
  assert.equal(h.state().workPaused, false)
  assert.equal(h.state().targets.find(r => r.id === 'main').manualOff, false)
  assert(reply.text.includes('保活、额度拦截、自动继续均停用'))
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), '5m')
  h.setQuota({ age: 60_000 }); const refreshes = h.refreshes.length
  assert.equal(await h.step('main', 'continue-main'), true)
  assert.equal(await h.step('A', 'continue-child'), true)
  await h.tick(50)
  assert.equal(h.refreshes.length, refreshes)
  assert.equal(h.forks.length + h.deliveries.length, 0)
  h.setQuota({ used: 0, age: 0, resetAt: h.now + 10 * 3600_000 }); await h.tick(1)
  assert.equal(h.continuations.length, 0)
  assert(h.journal().some(r => r.event === 'session_off'))
})

test('无参数关闭：重载保留off，额度仍91%也能手动继续', async () => {
  const h = await harness({ quota: { used: 91 } })
  await h.step('main', 'blocked')
  await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  const again = await harness({ files: Object.fromEntries(h.files), quota: { used: 91, available: false }, env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' } })
  assert.equal(again.state().state, 'paused')
  assert.equal(again.refreshes.length, 0)
  assert.equal(await again.step('main', 'continue-after-reload'), true)
  assert.equal(again.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), '5m')
})

test('无参数关闭：on恢复完整保护并保留指定目标的手动开关', async () => {
  const h = await harness({ quota: { used: 91 } })
  await h.spawn('A')
  await h.emit('command.run', { command: 'keepwarm', args: 'off A' })
  await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  assert.equal(h.state().state, 'paused')
  assert.equal(await h.step('main', 'manually-continue'), true)
  await h.emit('command.run', { command: 'keepwarm', args: 'on' })
  assert.equal(h.state().state, 'active')
  assert.equal(h.state().targets.find(r => r.id === 'A').manualOff, true)
  assert.equal(h.state().targets.find(r => r.id === 'main').manualOff, false)
  assert.equal(await h.step('main', 'protected-again'), false)
  assert(h.journal().some(r => r.event === 'session_on'))
})

test('无参数关闭：off只停用当前会话，不影响另一会话的91%保护', async () => {
  const first = await harness({ sessionId: 'first', quota: { used: 91 } })
  const second = await harness({ sessionId: 'second', quota: { used: 91 } })
  await first.emit('command.run', { command: 'keepwarm', args: 'off' })
  assert.equal(await first.step('main', 'continue-first'), true)
  assert.equal(await second.step('main', 'continue-second'), false)
})

test('无参数关闭：额度读取期间off，返回91%也不再拦截', async () => {
  let h
  h = await harness({ onQuotaRefresh: async q => {
    q.age = 0
    await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  } })
  h.setQuota({ used: 91, age: 60_000 })
  assert.equal(await h.step('main', 'concurrent-off'), true)
  assert.equal(h.state().state, 'paused')
  assert.equal(h.state().workPaused, false)
})

test('无参数关闭：带目标命令与主代理工具保持目标范围，错误参数不改变状态', async () => {
  const h = await harness({ quota: { used: 91 } })
  const missing = await h.control('off')
  assert.equal(missing.result.error, 'missing_target'); assert.equal(missing.isError, true)
  assert.equal(h.state().state, 'active'); assert.equal(h.state().targets.find(r => r.id === 'main').manualOff, false)
  assert.equal(await h.step('main', 'target-only'), false)
  await h.emit('command.run', { command: 'keepwarm', args: 'off main extra' })
  assert.equal(h.state().state, 'active')
  await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  assert.equal(h.state().state, 'paused')
  await h.emit('command.run', { command: 'keepwarm', args: 'on main extra' })
  assert.equal(h.state().state, 'paused')
  await h.emit('command.run', { command: 'keepwarm', args: 'on main' })
  assert.equal(h.state().state, 'paused')
  assert.equal(h.state().targets.find(r => r.id === 'main').manualOff, false)
})

test('会话关闭时额度重置也不自动继续，重新开启后才处理原队列',async()=>{
  const h=await harness();h.setQuota({used:91});await h.step('main','pause-main')
  await h.emit('command.run',{command:'keepwarm',args:'off'})
  h.setQuota({used:0,resetAt:h.now+10*3600000});await h.tick(1)
  assert.equal(h.continuations.length,0)
  await h.emit('command.run',{command:'keepwarm',args:'on'});await h.tick(1)
  assert.equal(h.continuations.length,1)
})

test('重新开启会话插件后恢复91%保护，并恢复子代理缓存参数',async()=>{
  const h=await harness({env:{CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL:'5m'}})
  h.setQuota({used:91});await h.emit('command.run',{command:'keepwarm',args:'off'})
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),'5m')
  assert.equal(await h.step('main','manual'),true)
  await h.emit('command.run',{command:'keepwarm',args:'on'})
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),'1h')
  assert.equal(await h.step('main','protected'),false)
})

test('全局关闭标记同时停用额度拦截、保活、自动继续和缓存参数修改',async()=>{
  const h=await harness({env:{CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL:'5m'}})
  h.setQuota({used:91});await h.step('main','pause-main')
  h.files.set('/mock/.claude/keepwarm-off','');h.setQuota({age:60000})
  const before=h.refreshes.length
  assert.equal(await h.step('main','manual-main'),true)
  assert.equal(await h.step('untracked-agent','manual-child'),true)
  await h.tick(1)
  assert.equal(h.refreshes.length,before);assert.equal(h.continuations.length,0)
  assert.equal(h.forks.length+h.deliveries.length,0)
  assert.equal(h.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),'5m')
  assert.equal(h.state().state,'stopped');assert.equal(h.state().workPaused,false)
  h.files.delete('/mock/.claude/keepwarm-off');h.setQuota({age:0})
  assert.equal(await h.step('main','protected-again'),false)
})

test('会话插件关闭后不再干预保活工具或过滤通知',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A');await h.tick(50)
  const ping=h.deliveries[0].text
  await h.emit('turn.start',{agentId:'A',turnId:'pending',text:ping})
  await h.emit('command.run',{command:'keepwarm',args:'off'})
  const result=await h.emit('tool.check',{agentId:'A',toolName:'Read',input:{}},{decision:'allow'})
  assert.equal(result.decision,'allow');assert.equal(h.aborts.length,0)
  const marker=/\[keepwarm:([^\]]+)\]/.exec(ping)[1]
  await h.emit('turn.complete',{agentId:'A',turnId:'pending',answer:marker,usage:rich,reason:'answer'})
  const next={text:'正常投递'}
  assert.deepEqual(await h.emit('prompt.submit',{text:notice('A',marker),origin:{kind:'task-notification'}},next),next)
})

test('全局关闭后重启再移除标记，不把正常会话永久记成停止保活',async()=>{
  const h=await harness();await h.turn();h.files.set('/mock/.claude/keepwarm-off','');await h.tick(1)
  const saved=h.state()
  const again=await harness({files:{'/mock/.claude/keepwarm/sessions/s1.json':JSON.stringify(saved),'/mock/.claude/keepwarm-off':''},quota:{available:false},env:{CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL:'5m'}})
  assert.equal(again.refreshes.length,0);assert.equal(again.state().state,'stopped')
  again.files.delete('/mock/.claude/keepwarm-off');again.setQuota({available:true})
  await again.tick(50)
  assert.equal(again.forks.length,1);assert.equal(again.state().state,'active')
})

test('保活次数到上限时插件仍有额度功能，状态不冒充整个插件关闭',async()=>{
  const h=await harness({env:{KEEPWARM_MAX_BUMPS:'1'}});await h.turn();await h.tick(50)
  assert.equal(h.state().targets[0].state,'stopped')
  assert.equal(h.state().state,'active')
  h.setQuota({used:91});assert.equal(await h.step('main','normal'),false)
})

test('主对话加三个子代理的上限各自计算，总数超过上限仍完成各路保活',async()=>{
  const h=await harness({env:{KEEPWARM_MAX_BUMPS:'2'}});await h.turn()
  for(const id of ['A','B','C']){await h.spawn(id);await h.turn(id)}
  for(let round=0;round<2;round++){
    await h.tick(round?47:50)
    for(const id of ['A','B','C']){await h.tick(1);await h.answer(id)}
  }
  assert.equal(h.state().bumps,8);assert.equal(h.state().roundBumps,8)
  assert(h.state().targets.every(r=>r.roundBumps===2&&r.state==='stopped'))
})

test('主对话正常恢复后本轮归零，累计保留，次数上限重新按本轮计算',async()=>{
  const h=await harness({env:{KEEPWARM_MAX_BUMPS:'1'}});await h.turn();await h.tick(50)
  assert.equal(h.state().roundBumps,1)
  await h.turn()
  let r=h.state().targets[0]
  assert.equal(h.state().bumps,1);assert.equal(h.state().roundBumps,0)
  assert.equal(r.roundBumps,0);assert.equal(r.state,'active')
  await h.tick(50);r=h.state().targets[0]
  assert.equal(r.bumps,2);assert.equal(r.roundBumps,1);assert.equal(r.state,'stopped')
})

test('子代理恢复只重置自己的上限，不清空主对话或状态栏本轮累计',async()=>{
  const h=await harness({env:{KEEPWARM_MAX_BUMPS:'1'}});await h.turn();await h.spawn('A');await h.turn('A')
  await h.tick(50);await h.tick(1);await h.answer('A')
  await h.turn('A')
  assert.equal(h.state().bumps,2);assert.equal(h.state().roundBumps,2)
  const main=h.state().targets.find(r=>r.id==='main'),agent=h.state().targets.find(r=>r.id==='A')
  assert.equal(main.roundBumps,1);assert.equal(main.state,'stopped')
  assert.equal(agent.roundBumps,0);assert.equal(agent.state,'active')
  await h.tick(50);await h.answer('A')
  assert.equal(h.state().bumps,3);assert.equal(h.state().roundBumps,3)
})

test('主对话恢复会清空显示本轮合计，但不会替子代理清空独立上限',async()=>{
  const h=await harness();await h.turn();await h.spawn('A');await h.turn('A')
  await h.tick(50);await h.tick(1);await h.answer('A');await h.turn()
  assert.equal(h.state().bumps,2);assert.equal(h.state().roundBumps,0)
  assert.equal(h.state().mainRoundBumps,0)
  assert.equal(h.state().targets.find(r=>r.id==='A').roundBumps,1)
})

test('状态栏区分主代理与子代理，子代理保活唤醒不改变完成状态', async () => {
  const h = await harness()
  await h.emit('prompt.submit', { text: '模拟首轮', origin: { kind: 'composer' } })
  await h.turn()
  await h.spawn('A'); await h.turn('A')
  const before = h.state().agentViews[0]
  assert.equal(before.phase, 'completed')
  assert.equal(before.completedRound, 1)
  h.agents.length = 0
  await h.tick(50); await h.tick(1)
  const marker = /\[keepwarm:([^\]]+)\]/.exec(h.deliveries[0].text)[1]
  await h.emit('turn.start', { agentId: 'A', turnId: 'ping-A', text: h.deliveries[0].text })
  assert.deepEqual(h.state().agentViews[0], before)
  await h.emit('turn.complete', { agentId: 'A', turnId: 'ping-A', answer: marker, reason: 'answer', usage: rich })
  assert.equal(h.state().bumps, 2)
  assert.equal(h.state().roundBumps, 2)
  assert.equal(h.state().mainRoundBumps, 1)
  assert.equal(h.state().targets.find(r => r.id === 'A').roundBumps, 1)
  assert.deepEqual(h.state().agentViews[0], before)
  await h.emit('prompt.submit', { text: '后台通知', origin: { kind: 'task-notification' } })
  assert.equal(h.state().conversationRound, 1)
  await h.emit('prompt.submit', { text: '模拟第二轮', origin: { kind: 'composer' } })
  assert.equal(h.state().conversationRound, 2)
  assert.equal(h.state().agentViews[0].completedRound, 1)
})

test('保留不支持保活和已取消的代理，重载保持已知阶段，切换会话隔离', async () => {
  const h = await harness()
  await h.emit('prompt.submit', { text: '模拟任务', origin: { kind: 'sdk' } })
  await h.spawn('searcher', 'Explore')
  await h.spawn('worker')
  await h.turn('searcher')
  await h.emit('turn.start', { agentId: 'worker', turnId: 'first', text: '模拟工作' })
  assert.equal(h.state().agentViews.find(v => v.id === 'worker').phase, 'running')
  await h.emit('turn.complete', { agentId: 'worker', turnId: 'first', answer: '', reason: 'aborted', isAborted: true })
  const phases = state => Object.fromEntries(state.agentViews.map(v => [v.id, v.phase]))
  assert.deepEqual(phases(h.state()), { searcher: 'completed', worker: 'closed' })
  assert.deepEqual(h.state().targets.map(r => r.id), ['main', 'worker'])
  const again = await harness({ files: Object.fromEntries(h.files), now: h.now })
  assert.deepEqual(phases(again.state()), phases(h.state()))
  assert.equal(again.state().conversationRound, 1)
  await again.emit('session.end', { reason: 'clear', sessionId: 's1' })
  again.setSession('fresh'); await again.turn()
  assert.deepEqual(again.state().agentViews, [])
  assert.equal(again.state().conversationRound, 0)
})

test('状态命令、开关和被额度拦截的请求均不开始新保活轮次',async()=>{
  const h=await harness();await h.turn();await h.tick(50)
  for(const args of ['status','pause','resume'])await h.emit('command.run',{command:'keepwarm',args})
  h.setQuota({used:91});await h.turn()
  assert.equal(h.state().bumps,1);assert.equal(h.state().roundBumps,1)
  assert.equal(h.state().targets[0].roundBumps,1)
})

test('旧版累计不会冒充已知本轮，正常继续后才建立新的本轮记录',async()=>{
  const saved={version:3,state:'active',targets:[{id:'main',label:'主对话',bumps:12,state:'stopped',reason:'达到连续保活上限',requestAt:1000,contextTokens:100000}]}
  const h=await harness({files:{'/mock/.claude/keepwarm/sessions/s1.json':JSON.stringify(saved)}})
  assert.equal(h.state().bumps,12);assert.equal(h.state().roundBumps,null)
  assert.equal(h.state().mainRoundBumps,null)
  assert.equal(h.state().targets[0].roundBumps,12)
  await h.turn();await h.tick(50)
  assert.equal(h.state().bumps,13);assert.equal(h.state().roundBumps,1)
  assert.equal(h.state().targets[0].roundBumps,1)
})

test('新版状态在重载后保留累计与本轮计数，不凭重载归零',async()=>{
  const h=await harness();await h.turn();await h.tick(50)
  const saved=h.state()
  const again=await harness({now:h.now,files:{'/mock/.claude/keepwarm/sessions/s1.json':JSON.stringify(saved)}})
  assert.equal(again.state().bumps,1);assert.equal(again.state().roundBumps,1)
  assert.equal(again.state().targets[0].roundBumps,1)
  await again.tick(50)
  assert.equal(again.state().bumps,2);assert.equal(again.state().roundBumps,2)
})

test('旧轮主对话保活迟到只增加累计，不占新轮上限或回退请求时间',async()=>{
  const h=await harness({env:{KEEPWARM_MAX_BUMPS:'1'}});await h.turn()
  h.$.model.fork=async()=>{
    h.setNow(h.now+60000);await h.turn()
    return {isAnswered:true,text:'.',usage:rich}
  }
  await h.tick(50)
  const r=h.state().targets[0]
  assert.equal(h.state().bumps,1);assert.equal(h.state().roundBumps,0)
  assert.equal(h.state().mainRoundBumps,0)
  assert.equal(r.roundBumps,0);assert.equal(r.state,'active');assert.equal(r.requestAt,h.now)
})

test('同一个普通工作回合的后续模型步骤不反复清零本轮显示',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A')
  await h.emit('turn.start',{turnId:'ongoing',text:'正常工作'})
  await h.step('main','ongoing');await h.tick(50);await h.answer('A')
  assert.equal(h.state().roundBumps,1)
  await h.step('main','ongoing')
  assert.equal(h.state().roundBumps,1)
})

const realPings=JSON.parse(readFileSync(new URL('./fixtures/真实保活消息.json',import.meta.url),'utf8'))
const teammate=(body,sender='team-lead')=>`<teammate-message teammate_id="${sender}" summary="缓存保活">\n${body}\n</teammate-message>`

test('回放26条真实子代理包装，91%时保活获准且记录读取成功',async()=>{
  for(const sample of realPings){
    const h=await harness();await h.spawn(sample.agentId);await h.turn(sample.agentId)
    h.setQuota({used:91});await h.tick(50)
    const own=h.deliveries[0].text, marker=/\[keepwarm:([^\]]+)\]/.exec(own)[1]
    const text=sample.text.split(sample.marker).join(marker)
    await h.emit('turn.start',{agentId:sample.agentId,turnId:'real-wrapper',text})
    assert.equal(await h.step(sample.agentId,'real-wrapper'),true,sample.marker)
    await h.emit('turn.complete',{agentId:sample.agentId,turnId:'real-wrapper',answer:marker,usage:rich,reason:'answer'})
    assert.equal(h.state().agentBumps,1)
    const done=h.journal().find(x=>x.event==='ping_succeeded')
    assert.equal(done.cache_read_input_tokens,100000);assert.equal(done.cache_creation_input_tokens,0)
    assert.equal(done.agent_id,sample.agentId)
  }
})

test('混入普通任务、错误发送者和仅引用标记时不能借用保活豁免',async()=>{
  for(const wrap of [t=>teammate(t)+'\n继续完成普通任务',t=>teammate(t,'other-agent'),t=>'用户引用：'+teammate(t)]){
    const h=await harness();await h.spawn('A');await h.turn('A');h.setQuota({used:91});await h.tick(50)
    await h.emit('turn.start',{agentId:'A',turnId:'mixed',text:wrap(h.deliveries[0].text)})
    assert.equal(await h.step('A','mixed'),false)
    assert(h.journal().some(x=>x.event==='ping_unrecognized'))
  }
})

test('超时后到达的真实包装仍在本地拦截，日志标记迟到',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A');await h.tick(50)
  const text=teammate(h.deliveries[0].text);await h.tick(2)
  await h.emit('turn.start',{agentId:'A',turnId:'late-wrapped',text})
  assert.equal(await h.step('A','late-wrapped'),false)
  assert(h.journal().some(x=>x.event==='ping_timeout'))
  assert(h.journal().some(x=>x.event==='ping_late_rejected'))
})

test('真实包装失败保留回合归属，429最多连续三次且不误计成功',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A')
  for(let i=0;i<3;i++){
    await h.tick(i?1:50);const text=h.deliveries.at(-1).text
    await h.emit('turn.start',{agentId:'A',turnId:'err-'+i,text:teammate(text)})
    await h.emit('turn.complete',{agentId:'A',turnId:'err-'+i,answer:'API Error: Request rejected (429)',reason:'error',usage:empty,isAborted:false})
  }
  await h.tick(1)
  assert.equal(h.deliveries.length,3);assert.equal(h.state().agentBumps,0)
  assert.equal(h.journal().filter(x=>x.event==='ping_failed'&&x.reason==='upstream_429').length,3)
})

test('独立日志记录投递、识别、请求、成功，缺省不包含正文或工具输入',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A');await h.tick(50);await h.answer('A')
  const names=h.journal().map(x=>x.event)
  for(const name of ['session_started','ping_scheduled','ping_delivered','ping_received','ping_request','ping_succeeded'])assert(names.includes(name),name)
  assert(!JSON.stringify(h.journal()).includes(h.deliveries[0].text))
  assert(h.state().logPath.endsWith('/logs/s1.jsonl'))
})

test('日志写入失败不改变保活成功、次数或正常工作准入',async()=>{
  const h=await harness({failLogWrite:true});await h.spawn('A');await h.turn('A');await h.tick(50);await h.answer('A')
  assert.equal(h.state().agentBumps,1);assert.equal(await h.step('main','normal'),true)
  assert(h.state().logError)
})

test('因保活超时停止的子代理正常恢复并命中缓存后重新参与保活',async()=>{
  const h=await harness();await h.spawn('A');await h.turn('A');await h.tick(50);await h.tick(2)
  assert.equal(h.state().targets.find(r=>r.id==='A').state,'stopped')
  await h.turn('A');await h.tick(50)
  assert.equal(h.deliveries.length,2)
})

test('真实idle完成通知在入队前被消费，不再触发主对话额度拦截',async()=>{
  const sample=JSON.parse(readFileSync(new URL('./fixtures/真实保活完成通知.json',import.meta.url),'utf8'))
  const h=await harness({names:{A:sample.peerName}});await h.spawn('A');await h.turn('A');await h.tick(50)
  const {marker}=await h.answer('A')
  const text=sample.text.split(sample.marker).join(marker)
  const result=await h.emit('session.receive',{origin:{kind:'peer'},text})
  assert(result.consumed)
  assert(h.journal().some(x=>x.event==='ping_notice_filtered'))
  const preserved={text:'正常通知'}
  assert.deepEqual(await h.emit('session.receive',{origin:{kind:'peer'},text:text+'\n继续正常任务'},preserved),preserved)
  assert.deepEqual(await h.emit('prompt.submit',{origin:{kind:'composer'},text},preserved),preserved)
})

test('普通团队任务结果和错误发送者的idle通知不能被吞掉',async()=>{
  const h=await harness({names:{A:'worker'}});await h.spawn('A');await h.turn('A');await h.tick(50)
  const {marker}=await h.answer('A')
  for(const data of [{from:'worker',result:'正常任务结果'},{from:'other',result:marker},{from:'worker',result:marker,task:'继续工作'}]){
    const text=JSON.stringify({type:'idle_notification',idleReason:'available',...data})
    const result=await h.emit('session.receive',{origin:{kind:'peer'},text},{text})
    assert.equal(result.text,text)
  }
})

test('每日唤醒命令在本地设置、查看与关闭，不触发当前会话模型', async () => {
  const h = await harness()
  for (const [args, expected] of [['wake 07:00', ['set', '07:00']], ['wake', ['status']], ['wake status', ['status']], ['wake off', ['off']]]) {
    await h.emit('command.run', { command: 'keepwarm', args })
    assert.deepEqual(h.wakeCalls.at(-1).argv, ['node', '/mock/plugin/hooks/daily-wake.cjs', ...expected])
  }
  assert.equal(h.forks.length + h.deliveries.length + h.continuations.length, 0)
})

test('普通状态显示每日唤醒；关闭会话后仍能管理全机日程', async () => {
  const h = await harness()
  const result = await h.emit('command.run', { command: 'keepwarm', args: 'off' })
  assert.match(result.text, /每日唤醒：未开启/)
  await h.emit('command.run', { command: 'keepwarm', args: 'wake 07:00' })
  assert.deepEqual(h.wakeCalls.at(-1).argv.slice(-2), ['set', '07:00'])
  assert.equal(h.state().state, 'paused')
})

test('日程设置错误在本地显示，不提交模型解释错误', async () => {
  const h = await harness({ wakeError: '时间格式：HH:MM' })
  const result = await h.emit('command.run', { command: 'keepwarm', args: 'wake 25:00' })
  assert.match(result.text, /每日唤醒设置失败：时间格式/)
  assert.equal(h.continuations.length, 0)
})

const stop = (h, ttl, file = '/mock/transcripts/s1.jsonl') => { h.transcripts.set(file, ttl); return h.emit('classic.Stop', { session_id: 's1', transcript_path: file }, {}) }
const subagentStop = (h, id, ttl, file = `/mock/transcripts/agent-${id}.jsonl`) => { h.transcripts.set(file, ttl); return h.emit('classic.SubagentStop', { session_id: 's1', agent_id: id, agent_transcript_path: file }, {}) }

test('短缓存：主对话转录只写5分钟缓存时不保活，查询说明原因', async () => {
  const h = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  await h.turn(); await stop(h, '5m')
  assert.equal(h.state().targets[0].transcript, '/mock/transcripts/s1.jsonl')
  await h.tick(55)
  assert.equal(h.forks.length, 0); assert.equal(h.state().targets[0].cacheTtl, '5m')
  assert.equal(h.state().nextBumpAt, 0)
  const target = (await h.control('status', 'main')).result.targets[0]
  assert.equal(target.effective_state, 'short_ttl'); assert.equal(target.cache_ttl, '5m')
  await h.tick(55); assert.equal(h.forks.length, 0)
  assert(h.journal().some(r => r.event === 'cache_ttl_detected' && r.cache_ttl === '5m'))
  assert(h.journal().some(r => r.event === 'route_waiting' && r.reason === 'short_cache_ttl'))
})

test('短缓存：只跳过5分钟子代理，1小时子代理和主对话照常保活', async () => {
  const h = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  await h.turn(); await stop(h, '1h')
  for (const id of ['A', 'B']) { await h.spawn(id); await h.turn(id) }
  await subagentStop(h, 'A', '5m'); await subagentStop(h, 'B', '1h')
  for (let i = 0; i < 4; i++) { await h.tick(i ? 1 : 55); if (h.deliveries.length > h.journal().filter(r => r.event === 'ping_received').length) await h.answer(h.deliveries.at(-1).to.agentId) }
  assert.equal(h.forks.length, 1)
  assert.deepEqual(h.deliveries.map(d => d.to.agentId), ['B'])
  assert.deepEqual(h.state().targets.map(t => t.cacheTtl), ['1h', '5m', '1h'])
})

test('短缓存：读取时机在过期点和保活时间，切回1小时后恢复保活，有效期随重载保留', async () => {
  const h = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  await h.turn(); await stop(h, '5m'); await h.tick(54); assert.equal(h.state().targets[0].cacheTtl, '')
  await h.tick(1); assert.equal(h.forks.length, 0)
  const again = await harness({ files: Object.fromEntries(h.files), env: { KEEPWARM_INTERVAL_MIN: '55' } })
  assert.equal(again.state().targets[0].cacheTtl, '5m')
  await again.turn(); await stop(again, '1h')
  const reads = () => again.refreshes.length + again.journal().filter(r => r.event === 'cache_ttl_detected').length
  await again.tick(4); assert.equal(again.state().targets[0].cacheTtl, '5m')
  await again.tick(1); assert.equal(again.state().targets[0].cacheTtl, '1h')
  const detected = reads()
  for (let i = 0; i < 49; i++) await again.tick(1)
  assert.equal(reads(), detected); assert.equal(again.forks.length, 0)
  await again.tick(1); assert.equal(again.forks.length, 1)
})

test('短缓存：转录无法读取或没有有效期分项时沿用原有判断', async () => {
  const h = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  await h.turn(); await stop(h, '')
  await h.emit('classic.Stop', { session_id: 'other', transcript_path: '/mock/transcripts/other.jsonl' }, {})
  await h.tick(55); assert.equal(h.forks.length, 1)
  assert.equal(h.state().targets[0].cacheTtl, ''); assert.equal(h.state().targets[0].transcript, '/mock/transcripts/s1.jsonl')
  const missing = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  await missing.turn(); await missing.emit('classic.Stop', { session_id: 's1', transcript_path: '/mock/transcripts/missing.jsonl' }, {})
  await missing.tick(55); assert.equal(missing.forks.length, 1)
})

test('主对话保活长时间无返回时判为超时，不阻塞子代理保活，迟到结果照常计量', async () => {
  const h = await harness({ env: { KEEPWARM_INTERVAL_MIN: '55' } })
  let finish; h.setFork(new Promise(resolve => { finish = resolve }))
  await h.turn(); await h.spawn('A'); h.setNow(h.now + 60_000); await h.turn('A')
  await h.tick(55)
  assert.equal(h.forks.length, 1); assert.equal(h.deliveries.length, 0)
  await h.tick(1); assert.equal(h.deliveries.length, 0)
  await h.tick(1)
  assert.deepEqual(h.deliveries.map(d => d.to.agentId), ['A'])
  assert(h.journal().some(r => r.event === 'ping_timeout' && r.agent_id === 'main' && r.phase === 'fork'))
  assert.equal(h.state().targets.find(r => r.id === 'main').reason, '保活回合超时')
  finish({ isAnswered: true, text: '.', usage: rich }); await h.flush()
  assert.equal(h.state().mainBumps, 1)
  await h.answer('A'); await h.tick(50); assert.equal(h.forks.length, 1)
})

test('旧命令 pause/resume 已删除：返回用法，不改变会话状态', async () => {
  const h = await harness()
  for (const args of ['pause', 'resume']) {
    const result = await h.emit('command.run', { command: 'keepwarm', args })
    assert.match(result.text, /^用法：/); assert.equal(h.state().state, 'active')
  }
  const plain = await h.emit('command.run', { command: 'keepwarm', args: '' })
  const full = await h.emit('command.run', { command: 'keepwarm', args: 'status' })
  assert.equal(plain.text, full.text); assert.match(plain.text, /^插件已开启/); assert.match(plain.text, /主对话：/)
})

// ---------- 代理（vm2api）智能路由 ----------
const proxySession = extra => ({ smart_mode: 'active', server_keepalive: false, state: 'active', account_id: 'account-1', vm_id: 'vm-01', resume_at: null, rush_until: null, ...extra })
const proxyOk = extra => async call => call.action === 'get' ? { ok: true, status: 200, data: proxySession(extra) } : { ok: true, status: 200, data: {} }

test('代理不支持智能路由时保持原行为：到 90% 暂停普通工作，照常保活', async () => {
  const h = await harness({ quota: { used: 95 } })
  assert.equal(h.proxyCalls[0].action, 'get')
  assert.equal(h.state().proxy.supported, false)
  assert.equal(h.state().workPaused, true)
  const idle = await harness()
  await idle.turn(); await idle.tick(50)
  assert.equal(idle.forks.length, 1)
})

test('代理智能路由生效时不再本地暂停，请求照常发往代理', async () => {
  const h = await harness({ quota: { used: 95 }, proxy: proxyOk() })
  assert.deepEqual([h.state().proxy.supported, h.state().proxy.mode, h.state().workPaused], [true, 'active', false])
  const reached = await h.step('main', 't1')
  assert.equal(reached, true)
  assert.match((await h.emit('command.run', { command: 'keepwarm', args: '' })).text, /代理智能路由：生效/)
})

test('代理处于影子模式时仍按本地 90% 保护暂停', async () => {
  const h = await harness({ quota: { used: 95 }, proxy: proxyOk({ smart_mode: 'shadow' }) })
  assert.deepEqual([h.state().proxy.supported, h.state().proxy.mode, h.state().workPaused], [true, 'shadow', true])
})

test('会话还没在代理上发过请求时，从“会话不存在”的回复里读出运行方式', async () => {
  const h = await harness({ quota: { used: 95 }, proxy: async () => ({ ok: false, status: 404, code: 'session_not_found', meta: { smart_mode: 'active', server_keepalive: true } }) })
  assert.deepEqual([h.state().proxy.supported, h.state().proxy.serverKeepalive, h.state().workPaused], [true, true, false])
})

test('代理开启服务端保活后插件不再发保活，状态显示由代理保活', async () => {
  const h = await harness({ proxy: proxyOk({ server_keepalive: true }) })
  await h.spawn('A'); await h.turn(); await h.turn('A')
  await h.tick(50); await h.tick(50)
  assert.equal(h.forks.length + h.deliveries.length, 0)
  assert.deepEqual((await h.control('status')).result.targets.map(t => t.effective_state), ['server_keepalive', 'server_keepalive'])
})

test('服务端保活次数按对话写进快照供状态栏合并，子代理随主对话一次查询，失败时保留上次的次数', async () => {
  let down = false
  const server = (count, total) => ({ ok: true, status: 200, data: proxySession({ server_keepalive: true, keepalive_count: count, keepalive_total: total }) })
  const h = await harness({ proxy: async call => {
    if (down) return { ok: false, status: 0, code: 'helper_failed' }
    if (call.action !== 'get') return { ok: true, status: 200, data: {} }
    const agents = Object.fromEntries((call.body.agent_ids ?? []).map(id => [id, server(2, 4)]))
    return { ...server(1, 3), agents }
  } })
  await h.spawn('A'); await h.turn(); await h.turn('A')
  await h.tick(2)
  const ids = h.state().targets.map(t => t.id)
  const agentId = ids.find(id => id !== 'main')
  assert.deepEqual(h.proxyCalls.at(-1).body, { agent_ids: [agentId] })
  const counts = () => h.state().targets.map(t => [t.id, t.serverKeepaliveCount, t.serverKeepaliveTotal])
  assert.deepEqual(counts(), [['main', 1, 3], [agentId, 2, 4]])
  assert.equal(h.state().bumps, 0)
  assert.match((await h.emit('command.run', { command: 'keepwarm', args: '' })).text, /保活累计 7，本轮 1（[^）]*）；其中代理服务端保活累计 7/)
  down = true
  await h.tick(2)
  assert.deepEqual([h.state().proxy.supported, counts()], [false, [['main', 1, 3], [agentId, 2, 4]]])
})

test('代理辅助脚本一次查询主对话和子代理，子代理结果按标识归档', async () => {
  const { getMany } = require('../plugins/keepwarm/hooks/vm2api-session.cjs')
  const urls = []
  const fetchImpl = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, data: { keepalive_total: url.includes('agent_id=') ? 4 : 3 } }) } }
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'test-key' }
  const result = await getMany({ sessionId: 's1', agentIds: ['a1', 'bad id'], env, home: '/nonexistent', fetchImpl })
  assert.deepEqual(urls.sort(), ['http://127.0.0.1:9/v1/kin/sessions/s1', 'http://127.0.0.1:9/v1/kin/sessions/s1?agent_id=a1'])
  assert.deepEqual([result.ok, result.data.keepalive_total, Object.keys(result.agents), result.agents.a1.data.keepalive_total], [true, 3, ['a1'], 4])
})

test('额度用完：代理给出恢复时间，到点后自动继续主对话和子代理', async () => {
  let parked = false
  const resumeAt = 1_000 + 20 * 60_000
  const h = await harness({ proxy: async call => call.action === 'get' ? { ok: true, status: 200, data: proxySession(parked ? { state: 'parked', resume_at: resumeAt } : {}) } : { ok: true, status: 200, data: {} } })
  await h.spawn('A'); await h.turn(); await h.turn('A')
  parked = true
  for (const id of ['A', 'main']) {
    const agentId = id === 'main' ? undefined : id
    await h.emit('turn.start', { agentId, turnId: `${id}-fail`, text: '真实工作' })
    await h.emit('turn.complete', { agentId, turnId: `${id}-fail`, answer: 'API Error: 429 账号额度已用完', reason: 'error' })
  }
  await h.flush()
  assert.deepEqual(h.state().deferredWork.sort(), ['A', 'main'])
  assert.equal(h.state().proxyResumeAt, resumeAt)
  assert.deepEqual(h.proxyCalls.filter(c => c.body.agent_id).map(c => c.body.agent_id), ['A'])
  await h.tick(10)
  assert.equal(h.continuations.length + h.deliveries.length, 0, '恢复时间之前不继续')
  parked = false
  await h.tick(11)
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.continuations.length, 1)
  assert.match(h.continuations[0].text, /账号额度已恢复/)
  assert.match(h.continuations[0].text, /A \(A\)/)
  assert.deepEqual([h.state().deferredWork, h.state().proxyResumeAt], [[], 0])
})

test('请求出错但代理没有让会话等待时，不安排自动继续', async () => {
  const h = await harness({ proxy: proxyOk() })
  await h.turn()
  await h.emit('turn.start', { turnId: 'fail', text: '真实工作' })
  await h.emit('turn.complete', { turnId: 'fail', answer: 'API Error: 500', reason: 'error' })
  await h.flush(); await h.tick(1)
  assert.deepEqual([h.state().deferredWork, h.continuations.length], [[], 0])
})

test('迁移和加急命令调用代理接口并说明结果', async () => {
  const calls = []
  const h = await harness({ proxy: async call => {
    calls.push(call)
    if (call.action === 'get') return { ok: true, status: 200, data: proxySession() }
    if (call.action === 'migrate') return { ok: true, status: 200, data: { rebuild_usd: 12.46, expires_at: 1_000 + 600_000 } }
    if (call.action === 'rush') return { ok: true, status: 200, data: { rush_until: call.body.on ? 1_000 + 7_200_000 : 0 } }
    return { ok: false, status: 404, code: 'not_found' }
  } })
  const run = async args => (await h.emit('command.run', { command: 'keepwarm', args })).text
  assert.match(await run('migrate'), /已登记迁移：本对话的下一次请求换到余量最多的其他账号，预计重建成本 12\.46 美元/)
  assert.match(await run('migrate vm-02'), /换到账号 vm-02/)
  assert.deepEqual(calls.filter(c => c.action === 'migrate').map(c => c.body.target), ['', 'vm-02'])
  assert.match(await run('rush'), /已开启加急/)
  assert.ok(h.state().proxy.rushUntil > 1_000)
  assert.match(await run('rush off'), /已关闭加急/)
  assert.deepEqual(calls.filter(c => c.action === 'rush').map(c => c.body.on), [true, false])
  assert.match(await run('rush maybe'), /用法/)
  assert.match(await run('migrate a b'), /用法/)
})

test('代理不支持时迁移和加急命令给出说明，不发请求', async () => {
  const h = await harness()
  const text = (await h.emit('command.run', { command: 'keepwarm', args: 'migrate' })).text
  assert.match(text, /不支持智能路由/)
  assert.deepEqual([...new Set(h.proxyCalls.map(c => c.action))], ['get'])
})

test('按对话关闭保活时同步给代理，会话退出时声明结束', async () => {
  const h = await harness({ proxy: proxyOk() })
  await h.spawn('A'); await h.turn('A')
  await h.control('off', 'A'); await h.control('off', 'main'); await h.flush()
  assert.deepEqual(h.proxyCalls.filter(c => c.action === 'keepalive').map(c => c.body), [{ on: false, agent_id: 'A' }, { on: false }])
  await h.emit('session.end', { reason: 'clear', sessionId: 's1' })
  assert.equal(h.proxyCalls.some(c => c.action === 'end'), false, '清空会话属于切换，不声明结束')
})

test('会话真正退出时向代理声明整组结束', async () => {
  const h = await harness({ proxy: proxyOk() })
  await h.emit('session.end', { reason: 'exit', sessionId: 's1' })
  assert.deepEqual(h.proxyCalls.at(-1), { action: 'end', sessionId: 's1', body: { scope: 'family' } })
})
