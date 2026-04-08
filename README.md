# xAgent

基于 [`rfc/met_rfc.md`](./rfc/met_rfc.md) 搭建的 Meteora DLMM Agent 核心骨架，当前聚焦以下能力：

- Skill 生命周期与调度
- LLM Provider 抽象与降级
- 数据源抽象、缓存与熔断
- RPC 主备与系统模式判断
- 主循环 / 高频循环的自研编排器
- 风控、组合管理、执行层的可扩展实现
- 文件审计日志与控制台通知

当前版本默认会优先尝试真实 HTTP 数据源与 Meteora 池子发现接口；如果外部服务不可用，再自动回退到 `config/sample-pools.json` 和 mock provider，方便在没有真实 RPC、钱包和外部 API Key 的情况下先验证流程。

从这次改动开始，仓库额外提供了 `config/agent.canary.yaml` 和 `config/agent.prod.yaml`。它们会打开 production guardrails：禁用运行时 mock 数据源 / mock LLM、要求 live 启动前完成 signer + RPC 预检、要求状态主存储为 PostgreSQL，并默认启用单实例锁与持久化失败自动降级。
当前 preflight 会额外检查主数据源、池子发现源、Jupiter / Jito / gateway 可达性，以及本地活跃仓位的 wallet / positionPubkey 与 signer、链上账户是否一致。
如果配置了 `guardrails.active_position_reconcile=repair`，`live_sdk` 启动时会先回放最近审计里的 `stateOperations`、恢复 pending 交易，再把链上已不存在的本地 active 安全收敛为 closed；`live_gateway` 则会按远端镜像主动修复本地 active positions。

从这一版开始，执行层已经拆成可切换 backend：

- `execution.mode: dry_run`：沿用本地模拟执行，适合开发和回归。
- `execution.mode: live_sdk`：仓内直连钱包 signer、Meteora DLMM SDK、Jupiter Metis 与 Jito/RPC 发送链，执行真实开仓 / 提费 / 重平衡 / 撤出。
- `execution.mode: live_gateway`：通过外部 execution gateway 调用独立执行器，并把执行结果回写到本地状态。

同时内置了一个零构建链的 Dashboard 页面，直接打开 `/dashboard` 即可操作。
如果配置了 `XAGENT_API_TOKEN`，Dashboard 首次请求受保护接口时会弹出 token 输入框。

## 运行方式

```bash
npm install
npm run build
npm run start:once
```

如果要做 `live_sdk` 实链联调：

```bash
cp .env.live-sdk.example .env.live-sdk
# 填入真实 RPC / wallet / Jupiter / Jito 凭据
set -a
source ./.env.live-sdk
set +a
npm run start -- --config config/agent.live-sdk.yaml
```

如果要按“正式交易”方式启动，建议先做小额 Canary：

```bash
cp .env.prod.example .env.prod
# 填入真实 RPC / wallet / Jupiter / 数据源 / PostgreSQL / OpenAI 凭据
set -a
source ./.env.prod
set +a
npm run start -- --config config/agent.canary.yaml
```

Canary 稳定后，再切到正式配置：

```bash
npm run start -- --config config/agent.prod.yaml
```

这份 prod 配置默认会 fail fast：如果 signer 与 `wallet.active_address` 不一致、没有可写 RPC、主数据源或池子发现源不可用、Jupiter / gateway 预检失败、活跃仓位与 signer / 链上账户不一致、仍在使用 mock LLM，或者状态主存储不是 PostgreSQL，进程会直接启动失败。

更完整的上线约束、Canary、监控和回滚演练清单见 [`docs/production-readiness.md`](./docs/production-readiness.md)。

如需常驻运行：

```bash
npm run start
```

如果只想运行编排器、不启动 HTTP API：

```bash
npm run start:no-api
```

如果要生成或轮换加密钱包密钥文件：

```bash
npm run build
WALLET_PRIVATE_KEY='[...]' XAGENT_WALLET_KEY='your-passphrase' \
  npm run wallet:secret -- encrypt \
  --secret-env WALLET_PRIVATE_KEY \
  --key-env XAGENT_WALLET_KEY \
  --out ./config/wallet.enc.json \
  --key-version v1
```

## API Gateway

服务模式下默认启动 Hono API，监听 `127.0.0.1:8787`。可通过 `config/agent.yaml` 里的 `api.host`、`api.port`，或环境变量 `API_HOST`、`PORT` 覆盖。

已实现的核心接口：

- `GET /`：重定向到 `/dashboard`
- `GET /dashboard`：内置控制台页面
- `GET /health`：进程存活与当前状态摘要
- `GET /status`：系统模式、最近循环结果、RPC 与数据源状态
- `GET /status`：额外包含 `storage` 与 `wallet` 运行时状态
- `GET /skills`：所有 Skill 配置、当前生命周期状态与运行统计
- `GET /skills/stats`：按 Skill 版本聚合的运行统计
- `GET /positions?active=true`：仓位列表，可只看活跃仓位
- `GET /audit/events?limit=20`：最近审计事件
- `POST /control/pause`：全局暂停
- `POST /control/resume`：恢复运行
- `POST /control/run-main-cycle`：手动触发一次主循环
- `POST /control/emergency-exit-all`：强制全撤
- `POST /positions/:id/force-exit`：强制单仓撤出
- `POST /skills/:id/disable`：停用某个 Skill
- `POST /skills/:id/enable`：启用某个 Skill，可传 `canaryPercent`
- `PUT /skills/:id/params`：热更新策略参数
- `POST /skills/:id/rollback`：回滚到指定版本
- `GET /metrics`：Prometheus 文本格式指标

`GET /status` 和 `GET /health` 现在会额外返回 execution backend 状态与当前 pool source 名称，便于确认当前是 `dry_run`、`live_sdk` 还是 `live_gateway`，以及候选池来自真实源还是 fallback。
Skill 的启停、Canary 比例、参数热更新和 rollback 结果现在会写回运行时状态快照，进程重启后仍会保留最近一次控制面变更。

Dashboard 当前覆盖：

- 系统总览卡片：mode、execution、可用资金、运行时长
- 系统总览卡片：额外展示当前 pool source
- 系统总览卡片：额外展示 storage backend 与 wallet secret 状态
- Cycle / Execution 面板：最近一次循环摘要、执行 backend 健康
- RPC / Data Provider 健康面板
- Storage / Wallet 面板：展示 state/audit/cache backend、wallet source、key version、secret forwarding 开关
- 最近审计事件面板
- 仓位矩阵：支持单仓强退
- Skill 控制台：支持启用、停用、Canary 切换，并展示按版本聚合的仓位 / 胜率 / 费用 / 估算盈亏
- 主循环会按 `risk.fee_claim_interval_hours` 自动触发手续费检查/提取；当 `lincoln_exit_threshold` 命中时，会自动转为平仓动作

示例：

```bash
curl -s http://127.0.0.1:8787/status
curl -s -X POST http://127.0.0.1:8787/control/pause \
  -H 'Content-Type: application/json' \
  -d '{"reason":"manual_test"}'
curl -s http://127.0.0.1:8787/metrics
```

## Execution Gateway Contract

当 `execution.mode=live_gateway` 时，xAgent 会向 gateway 的 `execute_path` 发送动作请求。请求体包含：

- `action`：原始 `PlannedAction`
- `context`：当前可用资金、目标仓位快照
- `execution`：钱包限制、RPC/Jito/Jupiter/Meteora 配置与当前 submission strategy

最小响应示例：

```json
{
  "status": "success",
  "message": "position opened",
  "txSignatures": ["5Qx...abc"],
  "stateOperations": [
    { "kind": "adjust_capital", "deltaSol": -1.2 },
    {
      "kind": "upsert_position",
      "position": {
        "id": "position-123",
        "positionPubkey": "9abc...",
        "poolAddress": "DLMM...",
        "tokenMint": "Mint...",
        "tokenSymbol": "BONK",
        "walletAddress": "Wallet...",
        "skillId": "bread_n_butter",
        "skillVersion": "1.0.0",
        "direction": "both",
        "fromBinId": -20,
        "toBinId": 20,
        "depositedSol": 1.2,
        "currentValueUsd": 180,
        "pnlPercent": 0,
        "isInRange": true,
        "totalFeesClaimedSol": 0,
        "rebalanceCount": 0,
        "status": "active",
        "entryLincolnScore": 8.8,
        "openedAt": "2026-03-28T08:00:00.000Z",
        "maxAliveUntil": "2026-04-04T08:00:00.000Z"
      }
    }
  ]
}
```

如果 gateway 提供 `positions_path`，xAgent 在 `require_live_preflight=true` 时还会请求这个只读接口，对账远端和本地的活跃仓位集合。`guardrails.active_position_reconcile=repair` 时，启动阶段会优先把本地状态修到与远端镜像一致，再进入严格 preflight。最小响应可以是数组，也可以是对象包一层 `positions`：

```json
{
  "positions": [
    {
      "id": "position-123",
      "positionPubkey": "9abc...",
      "walletAddress": "Wallet...",
      "status": "active",
      "poolAddress": "DLMM...",
      "tokenMint": "Mint...",
      "tokenSymbol": "BONK",
      "skillId": "bread_n_butter",
      "skillVersion": "1.0.0",
      "direction": "both",
      "fromBinId": -20,
      "toBinId": 20,
      "depositedSol": 1.2,
      "currentValueUsd": 180,
      "pnlPercent": 0,
      "isInRange": true,
      "totalFeesClaimedSol": 0,
      "rebalanceCount": 0,
      "entryLincolnScore": 8.8,
      "openedAt": "2026-03-28T08:00:00.000Z",
      "maxAliveUntil": "2026-04-04T08:00:00.000Z"
    }
  ]
}
```

## Direct SDK Execution

当 `execution.mode=live_sdk` 时，xAgent 会在仓内完成以下链路：

- 解析本地钱包 secret，生成 Solana signer
- 用 Meteora DLMM SDK 打开 / 查询 / 移除 / 领取 position
- 用 Jupiter Metis `quote -> swap` 把 SOL 和池子 token 做进出转换
- 按 `submission_strategy` 通过 Jito 或 RPC 发送交易
- 在 close / claim / rebalance 后，把新增的非 SOL token 尽量回收成 SOL，再回写本地资金状态

当前 `submission_strategy` 支持：

- `rpc`
- `jito`
- `jito_then_rpc`

最小运行条件：

```bash
export PRIMARY_RPC_URL='https://...'
export HELIUS_RPC_URL='https://...'
export WALLET_PRIVATE_KEY='[...]'
export JUPITER_API_KEY='...'
```

如果你使用 Jito 鉴权，还可以额外提供：

```bash
export JITO_AUTH_KEY='...'
```

说明：

- Jupiter 默认按 `quote_base_url` / `swap_base_url` 请求 Metis API，配置里已经切到 `/swap/v1` 风格端点。
- `live_sdk` 的真实执行默认仍建议从小资金 Canary 开始，因为真实成交、滑点、优先费和链上 rent 会直接反映到 `availableCapitalSol`。
- 如果缺少真实 RPC 或钱包 secret，`live_sdk` backend 会标记为 unhealthy，但进程仍能正常启动，便于先看控制面和观测面。

## Real Data Source Wiring

当前 runtime 会按以下顺序装配：

- `meteora_http -> mock_meteora`：真实池子发现失败时回退本地样例数据
- `gmgn -> provider_a -> provider_b -> mock_gmgn`：按优先级尝试真实数据源，失败后回退 mock
- `postgres -> file`：当 `storage.backend=postgres` 且 `mirror_to_file=true` 时，状态和审计会同时落 PostgreSQL 与本地文件
- `redis -> memory`：当配置了 `REDIS_URL` 时，数据源缓存会切到 Redis；否则回退进程内缓存

这些 provider 都走统一的 HTTP 规范化层。配置里可以为每个 provider 指定：

- `base_url` 或 `base_url_env`
- `api_key_env` 与 `api_key_header`
- `health_path`
- `token_safety_path`
- `smart_money_path`
- `trending_path`
- `ohlcv_path`
- `urgent_signals_path`

如果你的真实服务不是直接对接 GMGN / Meteora 官方接口，而是自建 proxy / gateway，只要把响应映射到当前字段集合，也可以直接复用这套装配逻辑。

当所有 data provider 都不可用时，runtime 会根据已有配置自动切换保护级别：

- 不可用时间未超过 `full_degradation_ms`：保持降级模式，禁止新开仓
- 不可用时间超过 `full_degradation_ms`：进入 `close_only`
- 不可用时间超过 `auto_exit_ms`：主循环会自动对全部活跃仓位触发 `emergency_exit`

## Persistence Backends

`storage.backend=file` 时：

- 状态快照写入 `runtime/state.json`
- 审计写入 `runtime/audit/*.jsonl`
- 运行时单实例锁默认写入 `runtime/runtime.lock`
- 数据源缓存保留在内存中，除非显式提供 `REDIS_URL`

`storage.backend=postgres` 时：

- 状态快照写入 PostgreSQL `runtime_state_snapshots`
- 审计写入 PostgreSQL `audit_events`
- 单实例保护默认升级为 PostgreSQL advisory lock
- `mirror_to_file=true` 时继续镜像写到本地文件，便于 grep / 备份 / 离线分析

无论 file / postgres backend，`guardrails.persist_failure_strategy=close_only_then_pause` 都会在状态持久化连续失败时先切 `close_only`，再升级到 `emergency_paused`。

最小环境变量：

```bash
export POSTGRES_URL='postgres://user:pass@127.0.0.1:5432/xagent'
export REDIS_URL='redis://127.0.0.1:6379'
```

表结构会在运行时自动创建，不需要手工执行 migration。

## Wallet Secret Flow

运行时支持两种 secret 来源：

- `wallet.secret.plaintext_env`：直接从环境变量读取
- `wallet.secret.encrypted_file_path`：从 AES-256-GCM 加密文件读取，并使用 `wallet.secret.encryption_key_env` 提供口令解密

加密文件支持 `encrypt / decrypt / rotate` 三个 CLI 流程：

```bash
npm run wallet:secret -- decrypt --file ./config/wallet.enc.json --key-env XAGENT_WALLET_KEY
npm run wallet:secret -- rotate --file ./config/wallet.enc.json --from-key-env OLD_KEY --to-key-env NEW_KEY --out ./config/wallet.v2.enc.json --key-version v2
```

默认不会把 secret 透传给 execution gateway。只有 `wallet.secret.allow_secret_forwarding=true` 时，`live_gateway` payload 才会附带解密后的 wallet secret。

## 目录结构

```text
config/                默认配置、Skill 配置、样例数据
rfc/                   需求与设计 RFC
src/audit/             审计日志实现
src/config/            配置定义与加载器
src/core/              熔断器、共享状态等基础设施
src/domain/            领域模型与接口
src/execution/         执行层骨架
src/managers/          各类管理器
src/modules/           Pool Scout / Strategy / Risk / Portfolio
src/orchestration/     主编排器
src/providers/         数据源、LLM、池子发现 provider
src/utils/             通用工具
```

## 注意事项

- 默认配置仍然是 `dry_run`，不会真正发起链上交易。
- 运行时状态现在会落到 `runtime/state.json`，默认重启后会恢复仓位与最近一次循环快照。
- Skill 运行统计当前是从持久化仓位快照实时聚合出来的，不依赖数据库；后续接 PostgreSQL 时可以把这层平移到底层存储。
- PostgreSQL / Redis 现在已经接入为可选 backend；未配置相关环境变量时会自动回退到 file / memory。
- API 控制面在 loopback 地址上支持可选 Bearer Token 认证；如果监听到非 loopback 地址，则必须配置 `XAGENT_API_TOKEN`。设置后，除 `/health` 与静态 dashboard 资源外，其余接口都会要求 `Authorization: Bearer <token>`。
- Telegram / Discord 通知器已经接好，但只有相关环境变量存在时才会启用。
- 如果切到 `execution.mode=live_sdk`，需要至少提供真实 RPC、可用钱包 secret，以及可访问的 Jupiter endpoint；建议先用小额度仓位验证。
- 如果切到 `config/agent.prod.yaml`，会额外启用 guardrails：禁止运行时 mock 数据源 / mock LLM、要求 live preflight 成功、要求 PostgreSQL 作为状态主存储，并在 `live_sdk` 下对“链上已不存在”的本地 active 仓位做启动时安全收敛。
- `live_sdk` 在 `submission_strategy` 包含 Jito 时，启动前会额外调用 block engine 的 `getTipAccounts` 做可达性检查；`live_gateway` 在配置了 `positions_path` 后，会校验 gateway 端活跃仓位和本地状态是否完全一致。
- 如果要让 `currentValueUsd` 有意义，需要提供 `SOL_PRICE_USD`（或在配置里写死 `valuation.sol_price_usd`）；未配置时会回退为 `0`，避免使用硬编码占位价。
- 如果切到 `execution.mode=live_gateway`，需要提供 `EXECUTION_GATEWAY_URL`，并让外部 gateway 实现 `/health` 与 `/v1/actions/execute`。
- gateway 响应支持回传 `stateOperations`，用于把真实执行结果同步回本地内存状态；如果不回传，链上执行虽可成功，但本地仓位/资金视图不会自动收敛。
- `/health` 现在会在 execution backend 不健康、RPC 不可写或状态持久化失败时返回 `503`。
- 钱包密钥状态只会暴露“是否已加载 / 来源 / key version / 是否允许转发”，不会在 API 或 Dashboard 里暴露 secret 本身。
- `live_sdk` 已经内嵌 Meteora SDK signer 执行；`live_gateway` 仍保留给独立执行服务或外部风控网关使用。
- 代码注释统一使用中文，并尽量把关键决策和边界条件解释清楚，便于后续维护。
