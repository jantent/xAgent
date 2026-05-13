# AGENT.md

本文件面向在本仓库内工作的代码代理。目标是让改动贴合当前实现，而不是复用通用 Node/TypeScript 模板。

## Repo Skill

- 本仓库内置 repo skill：`.codex/skills/xagent-dev-flow/SKILL.md`。
- 在本仓库内工作的代码代理，优先使用该 skill；skill 负责执行顺序、任务分类和验证入口。
- 本文件负责提供仓库事实、代码地图、改动约束和验证矩阵；skill 在执行时应先读取本文件，再按其中约束落地。
- 若用户明确给出不同流程或验证范围，以用户要求为准；否则遵循 skill + `AGENT.md` 的组合约束。

## 仓库定位

- 这是一个 Meteora DLMM Agent 的 TypeScript 实现，包含编排、风控、数据源、执行层、持久化、审计和控制面。
- 当前仓库同时支持三条执行路径：
  - `dry_run`：本地模拟执行，默认开发模式。
  - `live_sdk`：仓内直连钱包 signer、Meteora SDK、Jupiter Metis、Jito/RPC。
  - `live_gateway`：把动作发给外部 execution gateway，再按返回的 `stateOperations` 回写本地状态。
- `dry_run` 下默认启用 `paper_trading`：主循环会用真实 Meteora 池子的 active bin、价格和 fee/TVL 近似更新虚拟仓位 PnL、出界状态和虚拟手续费；mock 池子数据只写 stale 快照，不伪造收益。
- GMGN 主数据源默认通过官方 `gmgn-cli` 读取结构化 OpenAPI 数据，不再抓取 `https://gmgn.ai` 网页接口；本地需要安装 `gmgn-cli` 并配置 `GMGN_API_KEY` 或 `~/.config/gmgn/.env`。
- 真实 HTTP 数据源与真实池子发现都不是强依赖。外部依赖失败时，runtime 会退回 mock provider 或 `config/sample-pools.json`。
- 额外提供 `config/agent.canary.yaml` 与 `config/agent.prod.yaml` 作为真钱运行配置：禁用运行时 mock、要求 live preflight、使用 SQLite 主存储，并默认启用单实例锁。
- 当前 live preflight 不只检查 signer / RPC，也会检查主数据源、池子发现源、Jupiter / Jito / gateway 可达性，以及本地活跃仓位与 signer / 链上账户的一致性。
- `guardrails.active_position_reconcile=repair` 时，`live_sdk` 启动前会先回放最近审计里的 `stateOperations`、恢复 pending 交易，再把链上仓位账户已不存在的本地 active 记录收敛为 closed。
- `live_gateway` 若配置了 `execution.live.gateway.positions_path`，启动前会先按远端 active positions 镜像修复本地状态，然后再做一致性校验；如果本地已有 active 仓位但没有配置这个 path，preflight 会拒绝启动。
- 控制面当前采用 `Hono + 内置 dashboard`，dashboard 优先消费实时状态流，轮询只作为兜底。

## 技术栈与项目事实

- 运行时：Node.js + TypeScript。
- 模块系统：`"type": "module"`，`tsconfig.json` 使用 `NodeNext`。
- 仓库内 TypeScript 导入路径统一写 `.js` 后缀，新增代码保持一致。
- 当前没有 Jest / Vitest / ESLint / Prettier；自动化测试使用 Node.js 内建 test runner（`node:test`）+ TypeScript 编译。
- 代码注释、日志、README 均以中文为主，新增说明优先使用中文。
- 编译输出在 `dist/`，该目录已忽略；运行时状态默认落在 `runtime/`。
- 自动化测试源码位于 `tests/`，测试编译输出位于 `dist-test/`。

## 常用命令

在仓库根目录执行：

```bash
npm install
npm run check
npm run build
npm run test
npm run verify
npm run start:once
npm run start
npm run start:no-api
npm run wallet:secret -- encrypt --secret-env WALLET_PRIVATE_KEY --key-env XAGENT_WALLET_KEY --out ./config/wallet.enc.json --key-version v1
```

说明：

- `npm run check`：TypeScript 类型检查。
- `npm run build`：编译到 `dist/`。
- `npm run test`：编译 `src/` + `tests/` 到 `dist-test/`，再执行自动化测试。
- `npm run verify`：完整验证入口，顺序执行 `check -> build -> test`。
- `npm run start:once`：跑一次主循环和高频 tick，适合无状态冒烟。
- `npm run start`：启动常驻 orchestrator 和 API。
- `npm run start:no-api`：只启动编排器。
- `npm run wallet:secret`：钱包密钥的 `encrypt / decrypt / rotate` CLI。

CI 约定：

- GitHub Actions 会在 `push` / `pull_request` 上执行 `npm run verify`。
- 本地改动先过 `npm run verify`，再考虑提交或联调。

### `live_sdk` 联调

只有在任务明确要求真实执行链时再使用：

```bash
cp .env.live-sdk.example .env.live-sdk
set -a
source ./.env.live-sdk
set +a
npm run start -- --config config/agent.live-sdk.yaml
```

注意：

- `config/agent.live-sdk.yaml` 会把 `execution.mode` 切到 `live_sdk`。
- 这条路径需要真实 RPC、可用钱包 secret，以及可访问的 Jupiter endpoint。
- 默认仍建议从小额度 Canary 验证开始，不要把“能启动”误当成“适合直接真金白银运行”。

## 关键入口与代码地图

- `src/index.ts`
  CLI 入口，解析 `--once`、`--no-api`、`--config`、`--skills`。
- `tests/`
  自动化测试入口，按模块拆分为 `execution/`、`managers/`、`modules/`、`orchestration/`、`persistence/` 等目录。
- `src/app/runtime.ts`
  运行时装配中心。执行 backend、provider、持久化、通知器都在这里接线。
- `src/core/shared-state.ts`
  运行时共享状态中心。仓位、最近 cycle、去重 action id、Skill 运行态快照都从这里收敛并持久化。
- `src/config/types.ts`
  配置类型定义；新增配置字段时先改这里。
- `src/config/loader.ts`
  YAML 配置与 skill 文件加载。
- `src/managers/`
  运行时协调层，包含 data provider、RPC、system mode、skill lifecycle 等 manager。
- `src/orchestration/`
  主循环和高频 tick 编排。
- `src/modules/`
  交易决策核心模块，包含选池、策略、风控、组合管理。
- `src/execution/`
  执行层主体。
  - `backends/dry-run-execution-backend.ts`
  - `backends/live-sdk-execution-backend.ts`
  - `backends/live-gateway-execution-backend.ts`
  - `clients/jupiter-metis-client.ts`
  - `clients/jito-block-engine-client.ts`
  - `clients/execution-gateway-client.ts`
  - `solana/signer-utils.ts`
- `src/persistence/`
  状态存储和缓存后端，支持 file / SQLite，数据源缓存当前使用 memory backend。
- `src/audit/`
  审计日志读写。
- `src/api/server.ts`
  Hono API 入口，包含控制面 REST 接口和 `/events/status` 状态流。
- `src/dashboard/page.ts`
  内置 dashboard 页面，优先使用 SSE 订阅状态，失败时回退轮询 `/status`。
- `src/services/`
  控制面与统计服务，如 skill stats、paper trading 和 control service。
- `src/wallet/`
  钱包 secret 读取与解密。
- `config/agent.yaml`
  默认安全配置，执行模式为 `dry_run`。
- `config/agent.live-sdk.yaml`
  真实 `live_sdk` 联调配置。
- `config/agent.prod.yaml`
  正式交易 guardrails 配置；默认禁用运行时 mock，并要求 live 预检与 SQLite 主存储，同时启用启动时 active position 安全收敛。
- `config/skills/*.yaml`
  Skill 定义。
- `config/sample-pools.json`
  池子发现 fallback 数据。
- `.env.live-sdk.example`
  实链联调环境变量模板。
- `.env.prod.example`
  正式交易环境变量模板。
- `runtime/state.json`
  默认 file backend 的状态快照，除仓位/模式外还会保存 Skill 运行态与控制面相关快照；不要把它当源码配置修改。

## 改动约束

- 保持分层。不要把 provider、manager、execution、api 逻辑混进同一个文件。
- 变更配置结构时，至少联动检查：
  `src/config/types.ts`、`src/config/loader.ts`、`config/agent.yaml`、`config/agent.live-sdk.yaml`、`config/agent.prod.yaml`、`src/app/runtime.ts`、`src/app/runtime-guardrails.ts`、`src/app/startup-reconciliation.ts`。
- 变更执行模式或执行契约时，至少联动检查：
  `src/domain/models.ts`、`src/domain/contracts.ts`、`src/execution/`、`src/services/`、`src/api/server.ts`、`src/dashboard/page.ts`。
- 变更 Skill 生命周期、参数热更新、Canary/rollback 或控制面状态持久化时，至少联动检查：
  `src/core/shared-state.ts`、`src/managers/skill-manager.ts`、`src/services/control-service.ts`、`src/api/server.ts`、`src/dashboard/page.ts`、`src/persistence/state-serialization.ts`。
- 变更 `live_sdk` 路径时，不要只改 backend 本身；通常还要一起核对：
  `src/execution/clients/`、`src/execution/solana/`、`src/wallet/`、相关 YAML 配置和 `.env.live-sdk.example`。
- 变更 data provider 降级、自动全撤或 system mode 切换策略时，至少联动检查：
  `src/managers/data-provider-manager.ts`、`src/managers/system-mode-manager.ts`、`src/orchestration/orchestrator.ts`、`src/modules/risk-sentinel.ts`、配置类型/加载器与默认 YAML。
- 变更外部数据源时，优先保留现有 fallback 语义。真实源故障后，系统仍应能退回 mock 或 sample 数据完成最小流程。
- 不要把密钥、token、连接串、钱包 secret 硬编码进代码。该仓库已经通过 `*_env` 配置字段和 `.env.live-sdk.example` 约束这件事。
- 除非任务明确要求，不要通过编辑 `runtime/state.json`、`runtime/audit/` 或临时产物来“修复”业务逻辑。
- 若工作区里存在未提交改动，不要回滚它们；在现有基础上继续。

## 真实执行相关风险

- 默认开发和回归应优先走 `dry_run`。
- `live_sdk` 会真实消耗链上资金、支付 rent / fee / priority fee，并触发 Jupiter swap 与 Meteora 仓位操作。
- `live_gateway` 是否能让本地状态收敛，依赖 gateway 是否正确返回 `stateOperations`。
- 修改执行链时，要明确区分：
  - “控制面可启动”
  - “backend 状态 healthy”
  - “真实交易成功”
  这三件事不是同一层面的正确性。

## 配置与运行时事实

- 默认配置文件是 `config/agent.yaml`，默认 skill 目录是 `config/skills`。
- API 默认监听 `127.0.0.1:8787`。
- `XAGENT_API_TOKEN` 存在时，除 `/health` 和静态 dashboard 资源外，其余接口都需要 Bearer Token；如果 API 绑定到非 loopback 地址，则必须配置该 token。
- `GET /events/status` 用于 dashboard 实时状态推送；开启 Bearer Token 时，该 SSE 路由允许 query token 访问，便于浏览器直接订阅。
- 状态持久化支持 file / SQLite；数据源缓存当前使用 memory backend。
- 钱包 secret 支持明文环境变量和加密文件两种来源；默认不向 gateway 透传 secret。
- `SOL_PRICE_USD` 或 `valuation.sol_price_usd` 用于填充 `currentValueUsd`；未配置时系统会返回 `0`，不会再使用硬编码估值。
- `data_providers.gmgn.kind=gmgn_cli` 时，runtime 会执行 `gmgn-cli ... --raw` 并解析 JSON。若 GMGN 返回 `401` / `403` 且密钥正确，优先检查出口是否走 IPv6；GMGN CLI 当前要求 IPv4 出口。
- `paper_trading` 只在 `execution.mode=dry_run` 下生效；当前是基于池子发现数据的近似 mark-to-market，不等同于链上精确 DLMM position quote 或历史回测。`max_fee_tvl_ratio_24h` 是虚拟手续费入账上限，Meteora `discovery_min_tvl` 用于过滤低 TVL 极端池子。
- `skill_optimizer` 第一版只在 `execution.mode=dry_run` 且 `paper_trading.enabled=true` 时生成只读参数建议；不会自动修改 Skill 参数、Canary、晋级或 rollback。
- `execution.mode=live_gateway` 依赖 `EXECUTION_GATEWAY_URL`。
- `execution.mode=live_sdk` 依赖至少一条可用 RPC、可加载的钱包 secret，以及 Jupiter 配置。
- `storage.backend=file` 时，`runtime/state.json` 不只保存仓位和模式，也会保存 Skill 运行态快照与 pending actions；通过 API 做的 enable / disable / canary / params / rollback 变更在重启后仍会保留。
- 运行时默认启用单实例锁：file / SQLite backend 都使用 `runtime/runtime.lock`。
- `guardrails.persist_failure_strategy=close_only_then_pause` 时，状态持久化失败会先把运行态切到 `close_only`，连续失败再升级到 `emergency_paused`。
- `risk.fee_claim_interval_hours` 与 `risk.lincoln_exit_threshold` 已接入运行逻辑：前者驱动手续费检查/提取周期，后者驱动低 Lincoln Score 持仓退出。
- `claim` 动作会回写 `lastFeeCheckAt` / `lastClaimedAt`；即使本次没有可领取手续费，也应至少更新时间戳，避免主循环重复触发同一仓位的 claim。
- `dry_run` 的 `claim` 在 paper 仓位上会领取 `paper.unclaimedFeesSol` 并清零；旧的非 paper 仓位仍保留固定模拟手续费语义。
- 当所有 data provider 都不可用时，系统会按 `full_degradation_ms -> close_only -> auto_exit_ms` 逐级升级保护，并在超时后自动对全部活跃仓位执行 `emergency_exit`。

## 推荐验证方式

- 文档改动：如未改代码，可不跑自动化测试；若顺手改了示例命令或配置说明，至少核对相关命令仍存在。
- 纯配置改动：至少跑 `npm run check`；如果配置会影响 runtime 装配、执行模式或 provider fallback，补 `npm run verify`。
- TypeScript 代码改动：必须跑 `npm run verify`。这是当前仓库内代码代理的默认要求，不要只跑 `check`。
- 入口、runtime 装配、配置类型、执行 backend 改动：先跑 `npm run verify`，再用默认配置执行一次 `npm run start:once` 做冒烟。
- `live_sdk` 相关改动：除静态检查外，优先验证“缺配置时能否优雅降级 / 标记 unhealthy”，只有在任务明确要求时才做真实链路联调。
- 新增复杂逻辑时，优先补对应的 `node:test` 自动化测试，不接受只在说明里写“建议人工验证”。

## 测试策略

- 当前已落地的自动化测试重点覆盖：
  `RiskSentinel`、`PortfolioManager`、`StrategySelector`、`SkillManager`、`SystemModeManager`、`DataProviderManager`、`RpcManager`、`SharedState`、`ExecutionLayer`、`ExecutionGatewayClient`、`Orchestrator`、配置加载、signer utils、状态序列化、LLM provider。
- 新增交易核心逻辑时，优先考虑以下测试层次：
  1. 纯逻辑单测：风控、选池、组合管理、模式切换。
  2. 契约测试：gateway payload、状态回写、钱包密钥读写、序列化。
  3. 场景测试：`Orchestrator` 主循环、fallback、降级、紧急退出。
- 一个重要约束：任何 mutating action 只要执行结果是 `success`，就必须带 `stateOperations`；否则视为失败，避免“链上成功 / 本地不记账”的静默漂移。

## 文档边界

- `README.md` 负责产品能力、接口、运行说明。
- `docs/production-readiness.md` 负责真钱上线、Canary、监控、回滚演练清单。
- `.codex/skills/xagent-dev-flow/SKILL.md` 负责 repo 内编码工作流、任务分类和验证入口。
- `AGENT.md` 只保留对代码代理有帮助的仓库协作约束、模块入口、仓库事实和验证策略。
- 如果新增能力已经影响用户运行方式或配置方法，除了更新这里，也应同步更新 `README.md`。
