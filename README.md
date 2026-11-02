# keepwarm 保活派生版

基于 [Delitefully/claude-keepwarm](https://github.com/Delitefully/claude-keepwarm) 的个人维护版本。保留主会话缓存保活，并加入子代理独立保活、会话切换恢复、计数与日志、可选额度保护和每日定时唤醒。

当前版本 `0.9.3`。插件需要支持功能钩子的 Claude Code；本次清单验证使用 2.1.316，历史功能验证基于 2.1.312。辅助脚本需要 Node.js 18+，离线测试需要 Node.js 24+，配置助手需要 Python 3.10+。每日定时唤醒仅支持具备 systemd（系统服务管理器）用户服务的 Linux。

保活会发送真实模型请求并消耗用量。实际缓存效果取决于模型、服务端缓存策略和间隔设置；不保证降低费用或订阅用量。

## 安装

```bash
git clone https://github.com/Molun0301/claude-keepwarm.git
cd claude-keepwarm
claude plugin marketplace add Molun0301/claude-keepwarm
claude plugin install keepwarm@keepwarm
python3 scripts/configure.py enable
```

配置助手只合并 `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`，支持 `--config-dir` 或 `CLAUDE_CONFIG_DIR`。重新打开 Claude 或执行 `/reload-plugins`。

如果已有同名 `keepwarm` 市场，先查看 `claude plugin marketplace list`。上游版和本派生版使用相同插件标识，不能同时注册为两个不同版本。迁移时先 `/keepwarm wake off` 关闭已配置的定时任务，再执行：

```bash
claude plugin uninstall keepwarm@keepwarm
claude plugin marketplace remove keepwarm
claude plugin marketplace add Molun0301/claude-keepwarm
claude plugin install keepwarm@keepwarm
```

手工维护的 `~/.claude/keepwarm` 状态保留。旧会话重载插件。恢复原有每日唤醒时间需重新执行 `/keepwarm wake HH:MM`。

## 使用与配置

- `/keepwarm`：查看总数、本轮次数、每路状态和日志位置。
- `/keepwarm pause` / `/keepwarm resume`：暂停或恢复当前会话的插件行为。
- `touch ~/.claude/keepwarm-off`：全局关闭；删除此文件后恢复。
- `/keepwarm wake 07:00`：每天本机时间新建最简会话唤醒。
- `/keepwarm wake` / `/keepwarm wake off`：查看或关闭日程。

配置放在 Claude `settings.json` 的 `env` 中，或由启动环境传入：

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `KEEPWARM_INTERVAL_MIN` | 45 | 空闲多少分钟后保活 |
| `KEEPWARM_TTL_MIN` | 60 | 缓存有效期假设，须与服务端实际策略相符 |
| `KEEPWARM_MAX_BUMPS` | 8 | 每路每轮最多成功保活次数 |
| `KEEPWARM_POLL_SEC` | 60 | 状态检查间隔 |
| `KEEPWARM_MIN_CONTEXT_TOKENS` | 20000 | 小于此上下文词元数时跳过 |
| `KEEPWARM_QUOTA_STOP_PERCENT` | 90 | 可选额度保护阈值 |
| `KEEPWARM_QUOTA_DIR` | 当前 Claude 配置目录 | 额度配置与兼容缓存位置 |

以源码 `DEFAULTS` 为准。主会话正常恢复会重置本轮合计；子代理恢复只重置自己的轮次。旧回合迟到结果不会占用新轮额度。独立日志在 `~/.claude/keepwarm/logs`，文件权限 `0600`、轮转限制 1 MiB，不记录对话正文或凭据。

## 可选配套依赖

基础保活不要求状态栏。额度保护读取 [claude-statusline](https://github.com/Molun0301/claude-statusline) 写入的 vm2api 单槽缓存；它按配置的 `vm_id` 保护，不是对所有账户分别实时决策。查询失败不会新增暂停条件，已触发的保护等待有效数据确认恢复。

每日唤醒默认关闭。没有网关映射时使用当前 Claude 连接；发现状态栏网关配置时使用多账户模式，需要私密凭据文件中的 SSH（安全远程连接）服务器别名和远端目录、远端 Python 及匹配的 vm2api 数据库结构。按账户去重、固定虚拟机路由并核对服务端记录。配置无效时报告失败，不自动降级为公共路由。接口及数据库耦合见 `plugins/keepwarm/hooks/vm2api-wake.cjs`。

定时唤醒只发送正常请求，无法强制重置正在使用的额度窗口。电脑必须开机且用户定时器可运行。

## 更新与卸载

```bash
claude plugin marketplace update keepwarm
claude plugin update keepwarm@keepwarm
git pull --ff-only
python3 scripts/configure.py enable
```

在 Claude 执行 `/reload-plugins`。若配置了每日唤醒，再执行原来的 `/keepwarm wake HH:MM`，将新版本脚本更新到固定运行目录。需要固定版本时，从对应 Git 标签检出后通过本地市场安装。

卸载先在 Claude 执行 `/keepwarm wake off`，再执行：

```bash
claude plugin uninstall keepwarm@keepwarm
python3 scripts/configure.py restore
```

恢复助手只恢复自己管理且仍保持安装值的功能钩子字段。运行状态和日志保留，确认不再需要后可自行清理 `~/.claude/keepwarm`。

## 验证与许可

```bash
python3 scripts/check.py
```

测试覆盖会话切换、独立子代理、额度暂停、迟到消息、日志和定时调度；模型与服务端调用由模拟实现接管。这不等同于生产环境 50 分钟缓存效果或真实额度窗口验收。

上游未声明开源许可证，本仓库新增自有部分采用 MIT；**不对上游代码重新授权，也不将整个仓库声明为 MIT**。[来源与许可范围](docs/公开文档/来源与许可.md) · [维护与发布](docs/公开文档/维护与发布.md)。
