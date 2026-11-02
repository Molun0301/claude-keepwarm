const fs = require('node:fs')
const path = require('node:path')

// 沿用本机已有的服务器映射，凭据仅在执行时通过SSH读取，不写入日程或日志。
function createVm2apiWake(configDir, execute) {
  const file = path.join(configDir, 'local-statusline-quota-config.json')
  if (!fs.existsSync(file)) return null
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  const credentials = JSON.parse(fs.readFileSync(config.credentials_file, 'utf8'))
  const origin = new URL(config.base_url)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || new URL(credentials['管理页面']).origin !== origin.origin) throw Error('唤醒站点与现有登录配置不一致。')
  const host = credentials['服务器别名'], root = credentials['远端安装目录']
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) || typeof root !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(root)) throw Error('多账户唤醒缺少有效的SSH服务器映射。')
  const query = script => {
    try {
      return JSON.parse(execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'python3', '-'], {
        input: `import json,pathlib,sqlite3\nroot=pathlib.Path(${JSON.stringify(root)})\nc=sqlite3.connect('file:'+str(root/'data/kin.db')+'?mode=ro',uri=True)\nc.row_factory=sqlite3.Row\n` + script,
        encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'],
      }))
    } catch { throw Error('SSH读取唤醒账户或路由失败。') }
  }
  return {
    baseUrl: origin.origin,
    discover() {
      const data = query(`values={}\nfor line in (root/'.env').read_text().splitlines():\n if line.strip() and not line.lstrip().startswith('#') and '=' in line:\n  k,_,v=line.partition('='); values[k.strip()]=v.strip().strip('\\"').strip("'")\nrows=c.execute("select v.id as vmId,v.name as name,v.account_uuid as accountId from vms v join accounts a on a.id=v.account_uuid and a.vm_id=v.id where v.status='running' and v.schedulable=1 and a.platform='claude' and a.status='active' and a.schedulable=1 and a.deleted_at is null order by v.id").fetchall()\nprint(json.dumps({'apiKey':values.get('VM2API_API_KEY',''),'targets':[dict(r) for r in rows]}))\n`)
      if (typeof data.apiKey !== 'string' || !data.apiKey || !Array.isArray(data.targets)) throw Error('未取得有效的固定路由凭据或账户列表。')
      const seen = new Set()
      data.targets = data.targets.filter(target => {
        if (!target || typeof target.vmId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(target.vmId) || typeof target.accountId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(target.accountId)) throw Error('服务器返回的唤醒目标无效。')
        if (seen.has(target.accountId)) return false
        seen.add(target.accountId)
        return true
      })
      if (!data.targets.length) throw Error('没有可唤醒的有效Claude账户。')
      return data
    },
    verify(target, sessionId) {
      const rows = query(`print(json.dumps([dict(r) for r in c.execute('select vm_id,account_id from usage_logs where session_id=? and status>=200 and status<300',(${JSON.stringify(sessionId)},))]))\n`)
      if (!Array.isArray(rows) || !rows.length || !rows.every(row => row.vm_id === target.vmId && row.account_id === target.accountId)) throw Error('服务器实际路由未确认或账户不匹配。')
      return rows.length
    },
  }
}

module.exports = { createVm2apiWake }
