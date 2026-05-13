# Mainnet Live Runbook

这份文档是 xAgent 真实主网上线手册。它默认使用 `live_sdk` 路径：

```text
xAgent -> 钱包 signer -> Jupiter Metis -> Meteora DLMM SDK -> Jito/RPC -> Solana mainnet
```

这条路径会真实消耗 SOL，包含开仓本金、rent、交易 fee、priority fee、Jito tip 和滑点损耗。第一次真钱运行必须使用 `config/agent.canary.yaml`，不要直接运行 `config/agent.prod.yaml`。

## 当前推荐路径

1. 本地先跑 `npm run verify`。
2. 准备一个只放 Canary 预算的钱包。
3. 复制并填写 `.env.prod`。
4. 修改 `config/agent.canary.yaml` 的真实钱包地址和额度。
5. 启动 `config/agent.canary.yaml`。
6. 观察至少一轮开仓、claim 或 close、状态回写、审计闭环。
7. 做一次重启恢复演练。
8. Canary 稳定后，再切 `config/agent.prod.yaml`。

`config/agent.live-sdk.yaml` 只适合非 prod 风格联调。它保留 mock fallback，且默认 preflight 更松，不建议作为第一次真钱启动配置。

## 真实运行前置条件

必须准备：

- Node.js 20+。
- 可用的 Solana mainnet RPC，至少一主一备。
- 一个只放运行预算的钱包，不要直接使用主资金库钱包。
- 钱包私钥，格式为 JSON 数组、base58 secret key 或 base64 secret key。
- Jupiter API Key。
- OpenAI API Key，生产 guardrails 禁用 mock LLM。
- 至少一个真实 market data provider。默认配置使用 GMGN，也可以配置自建 `provider_a` / `provider_b`。
- `SOL_PRICE_USD`，用于把 SOL 仓位估值成 USD。
- 一个较长的 `XAGENT_API_TOKEN`，用于保护控制面。

可选但推荐：

- Jito auth key。
- Telegram / Discord 通知通道。
- 独立日志采集。
- 外部监控定时检查 `/health`、`/status`、`/metrics`。

## 代码与依赖检查

在仓库根目录执行：

```bash
npm install
npm run verify
```

成功标准：

- TypeScript check 通过。
- build 通过。
- 所有 `node:test` 测试通过。

如果这里失败，不要继续上真钱。

## 钱包与额度准备

第一次运行建议新建一个独立 Canary 钱包，只转入可以承受损失的小额 SOL。

修改 `config/agent.canary.yaml`：

```yaml
wallet:
  active_address: "REPLACE_WITH_REAL_WALLET_ADDRESS"
  limits:
    per_transaction_max_sol: 0.2
    daily_cumulative_max_sol: 0.5
```

要求：

- `active_address` 必须等于私钥对应的公钥。
- `per_transaction_max_sol` 是单笔动作上限。
- `daily_cumulative_max_sol` 是每日累计执行上限。
- Canary 的 `system.max_concurrent_positions` 默认为 `1`，第一次不要放大。

生产配置 `config/agent.prod.yaml` 也要改同一个 `wallet.active_address`，但要等 Canary 通过后再运行。

## 环境变量配置

复制模板：

```bash
cp .env.prod.example .env.prod
```

填入这些关键值：

```bash
XAGENT_API_TOKEN=replace-with-a-long-random-token
API_HOST=127.0.0.1
PORT=8787

PRIMARY_RPC_URL=https://your-primary-rpc.example
HELIUS_RPC_URL=https://your-backup-rpc.example
GRPC_URL=

WALLET_PRIVATE_KEY=
XAGENT_WALLET_KEY=

GMGN_API_KEY=
PROVIDER_A_URL=
PROVIDER_A_KEY=
PROVIDER_B_URL=
PROVIDER_B_KEY=

JUPITER_API_KEY=
JITO_AUTH_KEY=
METEORA_API_URL=https://dlmm-api.meteora.ag

OPENAI_API_KEY=
SOL_PRICE_USD=

TG_BOT_TOKEN=
TG_CHAT_ID=
DISCORD_WEBHOOK=
```

说明：

- `PRIMARY_RPC_URL` 和 `HELIUS_RPC_URL` 至少填一个，生产建议两个都填。
- `WALLET_PRIVATE_KEY` 不要提交，不要写进 YAML。
- `XAGENT_WALLET_KEY` 只有在使用加密钱包文件时需要；明文 env 私钥模式可以留空。
- `JITO_AUTH_KEY` 可选；如果配置 `submission_strategy: jito_then_rpc`，启动前会尝试 Jito 健康检查。
- `PROVIDER_A_*` / `PROVIDER_B_*` 可选；没有自建 provider 时可以留空。
- `SOL_PRICE_USD` 不影响交易执行，但影响 dashboard/status 里的 USD 估值。

加载环境变量：

```bash
set -a
source ./.env.prod
set +a
```

确认关键变量已经加载：

```bash
printenv PRIMARY_RPC_URL
printenv HELIUS_RPC_URL
printenv XAGENT_API_TOKEN
printenv OPENAI_API_KEY
printenv JUPITER_API_KEY
```

不要用 `printenv WALLET_PRIVATE_KEY` 把私钥打到终端历史或日志里。

## 可选：使用加密钱包文件

明文 `WALLET_PRIVATE_KEY` 最简单，但更推荐生成加密文件：

```bash
npm run build
WALLET_PRIVATE_KEY='[...]' XAGENT_WALLET_KEY='your-passphrase' \
  npm run wallet:secret -- encrypt \
  --secret-env WALLET_PRIVATE_KEY \
  --key-env XAGENT_WALLET_KEY \
  --out ./config/wallet.enc.json \
  --key-version v1
```

之后 `.env.prod` 里保留：

```bash
XAGENT_WALLET_KEY=your-passphrase
WALLET_PRIVATE_KEY=
```

`config/agent.canary.yaml` 默认会读取：

```yaml
wallet:
  secret:
    encrypted_file_path: "./config/wallet.enc.json"
    encryption_key_env: "XAGENT_WALLET_KEY"
```

验证解密：

```bash
npm run build
npm run wallet:secret -- decrypt --file ./config/wallet.enc.json --key-env XAGENT_WALLET_KEY
```

确认能解密后，不要把解密结果写入文件或日志。

## 启动前配置检查

检查 Canary 是否仍保持生产 guardrails：

```bash
rg -n "mode:|allow_mock|require_live_preflight|active_position_reconcile|backend:|per_transaction_max_sol|daily_cumulative_max_sol|max_concurrent_positions" config/agent.canary.yaml
```

期望看到：

```yaml
execution:
  mode: "live_sdk"

guardrails:
  allow_mock_data: false
  allow_mock_llm: false
  require_live_preflight: true
  active_position_reconcile: "repair"

storage:
  backend: "sqlite"

system:
  max_concurrent_positions: 1
```

检查生产配置也已经写入真实钱包地址：

```bash
rg -n "active_address|per_transaction_max_sol|daily_cumulative_max_sol" config/agent.prod.yaml config/agent.canary.yaml
```

## 启动 Mainnet Canary

先确认当前 shell 已加载 `.env.prod`，然后启动：

```bash
npm run start -- --config config/agent.canary.yaml
```

启动时会执行 preflight。典型失败和处理方式：

- `钱包 secret 未加载`：检查 `WALLET_PRIVATE_KEY` 或 `XAGENT_WALLET_KEY` / `config/wallet.enc.json`。
- `active_address 与 signer 不一致`：配置里的 `wallet.active_address` 和私钥不是同一个钱包。
- `当前无可写 RPC`：检查 `PRIMARY_RPC_URL` / `HELIUS_RPC_URL`。
- `主数据源不可用`：检查 GMGN 或自建 provider。
- `Jupiter quote failed`：检查 `JUPITER_API_KEY`、Jupiter endpoint 或网络。
- `Jito block engine 健康检查失败`：检查 `JITO_AUTH_KEY` 或临时把提交策略调成 `rpc` 做排障。
- `检测到本地 active 仓位不一致`：不要手工改 `runtime/state.json`，先看启动恢复和审计。

启动成功后，进程会常驻运行主循环和高频 tick。不要同时启动第二个 writer 实例；runtime lock 会阻止并发写入。

## 控制面访问

Dashboard：

```text
http://127.0.0.1:8787/dashboard
```

健康检查：

```bash
curl -s http://127.0.0.1:8787/health
```

完整状态：

```bash
curl -s http://127.0.0.1:8787/status \
  -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

活跃仓位：

```bash
curl -s "http://127.0.0.1:8787/positions?active=true" \
  -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

最近审计：

```bash
curl -s "http://127.0.0.1:8787/audit/events?limit=20" \
  -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

Prometheus 指标：

```bash
curl -s http://127.0.0.1:8787/metrics \
  -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

## Canary 观察窗口

第一次真钱 Canary 至少观察这些项：

- `/health` 返回 200。
- `/status.mode` 不是 `emergency_paused`。
- `/status.execution.mode` 是 `live_sdk`。
- `/status.execution.healthy` 是 `true`。
- `/status.rpc.canWrite` 是 `true`。
- `/status.dataProviders.hasPrimaryProvider` 是 `true`。
- `/status.storage.stateStoreKind` 是 `sqlite` 或 `sqlite+file`。
- `/status.wallet.loaded` 是 `true`。
- `pendingActions` 不长期堆积。
- 审计里能看到 cycle、phase、action、result。
- `runtime/xagent.db` 和 `runtime/audit/*.jsonl` 持续更新。

Canary 成功标准：

1. 至少完成一次启动 preflight。
2. 至少完成一次主循环。
3. 至少完成一次真实动作，或确认因为风控拒绝而没有动作。
4. 如果有真实动作，必须看到对应 `stateOperations` 回写后的仓位或资金变化。
5. 重启后 active positions 不漂移。
6. 没有未解释的 `statePersistenceError`。
7. 没有持续超过两个主循环的 pending action。

## 常用控制操作

手动暂停：

```bash
curl -s -X POST http://127.0.0.1:8787/control/pause \
  -H "Authorization: Bearer $XAGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_live_check"}'
```

恢复：

```bash
curl -s -X POST http://127.0.0.1:8787/control/resume \
  -H "Authorization: Bearer $XAGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_resume"}'
```

手动触发主循环：

```bash
curl -s -X POST http://127.0.0.1:8787/control/run-main-cycle \
  -H "Authorization: Bearer $XAGENT_API_TOKEN"
```

紧急全撤：

```bash
curl -s -X POST http://127.0.0.1:8787/control/emergency-exit-all \
  -H "Authorization: Bearer $XAGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_emergency"}'
```

单仓强退：

```bash
curl -s -X POST http://127.0.0.1:8787/positions/<position-id>/force-exit \
  -H "Authorization: Bearer $XAGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_position_exit"}'
```

## 重启恢复演练

Canary 跑起来后，必须做一次重启恢复：

1. 先查状态：

   ```bash
   curl -s http://127.0.0.1:8787/status \
     -H "Authorization: Bearer $XAGENT_API_TOKEN"
   ```

2. 停止进程。
3. 重新启动：

   ```bash
   npm run start -- --config config/agent.canary.yaml
   ```

4. 再查：

   ```bash
   curl -s "http://127.0.0.1:8787/positions?active=true" \
     -H "Authorization: Bearer $XAGENT_API_TOKEN"
   ```

成功标准：

- 启动恢复没有报危险漂移。
- pending action 被恢复或安全清理。
- 本地 active positions 与链上账户一致。
- 可用资金没有异常跳变。

## 失败处理

出现以下任一情况，应先暂停或停进程，不要继续放量：

- `/health` 返回 503。
- `mode=close_only` 持续超过一个主循环。
- `mode=emergency_paused`。
- `execution.healthy=false`。
- `rpc.canWrite=false`。
- `statePersistenceError` 非空。
- `pendingActions` 持续超过两个主循环。
- Dashboard / audit 显示真实动作成功但本地仓位没有变化。
- active positions 重启后漂移。

建议排障顺序：

1. `POST /control/pause` 暂停新动作。
2. 拉取 `/status`、`/positions?active=true`、`/audit/events?limit=50`。
3. 检查 RPC / Jupiter / Jito / market data provider 是否可用。
4. 检查 `runtime/xagent.db` 和 `runtime/audit/` 是否可写。
5. 必要时执行 `emergency-exit-all` 或逐仓 `force-exit`。
6. 只在确认链上和本地状态一致后恢复。

不要通过手工编辑 `runtime/state.json` 或 SQLite 来“修复”仓位，除非已经离线备份、确认链上真实状态，并明确知道状态序列化结构。

## 升级到 Prod

只有在 Canary 满足以下条件后，才切 `config/agent.prod.yaml`：

- 至少一轮启动、主循环、状态持久化、审计闭环成功。
- 已做重启恢复演练。
- 没有 lingering pending action。
- 没有未解释告警。
- 钱包余额和风险额度符合正式预算。
- `config/agent.prod.yaml` 的 `wallet.active_address`、`wallet.limits`、`system.max_concurrent_positions` 已确认。

启动 prod：

```bash
set -a
source ./.env.prod
set +a

npm run start -- --config config/agent.prod.yaml
```

Prod 启动后继续观察 `/health`、`/status`、`/metrics` 和 Dashboard。第一次 prod 放量仍建议手动盯盘至少一个主循环。

## live_gateway 备选路径

如果不想让 xAgent 进程直接持有 signer，可以切 `execution.mode=live_gateway`，由外部 gateway 负责真实交易。此时必须提供：

- `EXECUTION_GATEWAY_URL`
- `EXECUTION_GATEWAY_API_KEY`，如果 gateway 要鉴权
- gateway `/health`
- gateway `/v1/actions/execute`
- 如果启用 live preflight，还需要 gateway `/v1/positions`

gateway 成功响应必须返回 `stateOperations`。否则 xAgent 会拒绝把 mutating action 视为成功，避免链上成功但本地不记账。

默认不向 gateway 透传钱包 secret。只有明确设置：

```yaml
wallet:
  secret:
    allow_secret_forwarding: true
```

并且 gateway 是 HTTPS 或 loopback 地址时，才会透传 secret。

## 上线后日常巡检

每日至少检查：

- `/health` 是否稳定 200。
- 当前 `mode` 是否为 `normal` 或可解释的降级状态。
- active positions 数量和总敞口。
- 单 token 敞口。
- 过去 24 小时 actions 的 success / failed / skipped 比例。
- 累计 fee claim。
- `runtime/xagent.db` 文件大小和更新时间。
- `runtime/audit/` 是否持续追加。
- 钱包余额是否与预期一致。

每次改配置后至少运行：

```bash
npm run verify
npm run start:once
```

`start:once` 使用默认 dry_run 配置，不会触发真钱交易。真实配置改动上线前，仍需要用 `config/agent.canary.yaml` 做一次小额验证。
