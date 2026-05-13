# Production Readiness

这份清单面向“真钱主网正式交易”。
代码层现在已经补上单实例锁、启动恢复、gateway 镜像修复，以及持久化失败自动降级；真正上线前还需要按下面的运行标准走完一遍。

完整逐步上线手册见 [`docs/mainnet-live-runbook.md`](./mainnet-live-runbook.md)。本文件只保留上线门禁清单。

## 推荐启动顺序

1. 先准备 `.env.prod`，但第一次真钱启动用 `config/agent.canary.yaml`。
2. Canary 至少连续跑完一轮开仓 / claim 或 close / 状态回写 / 审计闭环。
3. 确认 SQLite 持久化、告警通道、API Token 都已接入。
4. 再切到 `config/agent.prod.yaml`。

## 部署约束

- 同一把真钱 wallet 同一时刻只允许一个 xAgent writer 实例持锁运行。
- 正式环境必须使用 `storage.backend=sqlite`，并保留 `mirror_to_file=true` 作为本地取证镜像。
- `guardrails.active_position_reconcile` 必须保持 `repair`，不要回退到 `fail` 或 `close_missing`。
- `guardrails.persist_failure_strategy` 必须保持 `close_only_then_pause`。
- API 若不绑定 loopback，必须配置 `XAGENT_API_TOKEN`。
- 所有真钱配置都应通过环境变量注入，不要把 secret 写进 YAML。

## 监控与告警

- `/health` 必须接 1 分钟级别探活；任意一次返回 `503` 直接告警。
- `/status` 或 `/events/status` 至少采集这些字段：
  `mode`、`manualPause`、`pendingActions`、`statePersistenceError`、`runtimeLock`、`execution.healthy`、`rpc.canWrite`、`dataProviders.hasPrimaryProvider`。
- 需要单独告警的场景：
  `runtimeLock` 获取失败、`statePersistenceError` 非空、`mode=close_only`、`manualPause=true`、`pendingActions>0` 持续超过 2 个主循环。
- 审计目录或 SQLite `audit_events` 要保留最近动作、阶段、错误日志，便于回放启动恢复。

## Mainnet Canary

- 启动前：
  确认钱包只放 Canary 预算；确认 `config/agent.canary.yaml` 的 `per_transaction_max_sol` 和 `daily_cumulative_max_sol` 符合预算。
- 启动命令：
  `npm run start -- --config config/agent.canary.yaml`
- 观察窗口：
  至少覆盖一次启动 preflight、一次主循环、一次状态持久化、一次 dashboard/status 观测。
- 成功标准：
  没有 `statePersistenceError`，没有 lingering `pendingActions`，锁状态正常，审计里能看到动作闭环，重启后 active positions 不漂移。
- 失败即回滚：
  任意出现 `close_only` / `manualPause` / gateway mirror repair 持续抖动 / 重启后状态不一致，立刻停止并切回只读排障。

## 回滚演练

- 演练 1：
  启动 Canary 后手动中断进程，再重启，确认 pending action 能自动恢复或安全清理。
- 演练 2：
  模拟 SQLite 不可写，确认系统先切 `close_only`，连续失败后进入 `emergency_paused`。
- 演练 3：
  用 `live_gateway` 模式制造本地/远端 active positions 漂移，确认启动时会自动修复镜像而不是直接 fail fast。
- 演练 4：
  验证单实例锁。第二个实例必须在启动阶段直接失败，不能进入主循环。

## 升级到 Prod

- Canary 连续通过且无未解释告警。
- 最近一次重启后的启动恢复无差异。
- 监控、告警、回滚演练都有记录。
- 然后再运行：
  `npm run start -- --config config/agent.prod.yaml`
