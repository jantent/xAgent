# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

xAgent 是一个 TypeScript 实现的 Meteora DLMM Agent，用于在 Solana 上全自动管理 meme coin 流动性仓位。系统包含编排、风控、数据源、执行层、持久化、审计和控制面。

## 常用命令

```bash
npm run check          # TypeScript 类型检查
npm run build          # 编译 src/ → dist/
npm run test           # 编译 src/ + tests/ → dist-test/，执行 node:test
npm run verify         # 完整验证：check → build → test
npm run start:once     # 跑一次主循环 + 高频 tick（冒烟测试）
npm run start          # 常驻编排器 + API
npm run start:no-api   # 只启动编排器
npm run replay:audit   # 回放 actions 审计，输出资金/PnL 摘要
npm run wallet:secret  # 钱包密钥 encrypt/decrypt/rotate CLI
```

CI 在 push/PR 上执行 `npm run verify`。本地改动先过 `npm run verify` 再提交。

### 验证策略

- 纯文档改动：可不跑测试
- 纯配置改动：至少 `npm run check`；影响 runtime 装配则补 `npm run verify`
- TypeScript 代码改动：必须 `npm run verify`
- 入口/runtime/执行 backend 改动：`npm run verify` + `npm run start:once` 冒烟

## 技术栈约束

- ESM (`"type": "module"`)，导入路径统一写 `.js` 后缀
- 测试框架：`node:test`（内建 test runner），无 Jest/Vitest/ESLint/Prettier
- 代码注释、日志、文档以中文为主，新增说明优先中文
- 编译输出 `dist/`，测试编译输出 `dist-test/`，运行时状态 `runtime/`

## 架构分层

```
providers/ (数据源/LLM/池子发现) → managers/ (协调) → modules/ (决策) → orchestration/ (编排) → api/ (控制面)
```

核心入口：
- `src/index.ts` — CLI 入口，解析 `--once`/`--no-api`/`--config`/`--skills`
- `src/app/runtime.ts` — 运行时装配中心，接线所有 backend/provider/持久化/通知
- `src/core/shared-state.ts` — 共享状态中心（仓位、资金、Skill 快照）
- `src/services/telegram-bot-service.ts` — Telegram 只读 command bot（Dashboard 链接、状态/KPI、基础设施、仓位、交易历史、资产报告、Skill/Optimizer、事件）
- `src/config/types.ts` — 配置类型定义
- `src/orchestration/orchestrator.ts` — 主循环 (30min) + 高频 tick (5-10s) 编排

## 三条执行路径

- `dry_run`：本地模拟，默认开发模式
- `live_sdk`：仓内直连 Meteora SDK / Jupiter Metis / Jito，真实链上执行
- `live_gateway`：委托外部 gateway 执行，按返回的 `stateOperations` 回写本地状态

当前 dry_run paper trading 会在活跃仓位缺失于本轮候选池时按 pool address 回查真实池子 active bin；系统还包含 PnL ledger、成本模型、硬风控过滤、Canary kill switch、策略实验状态、dry-run 自动调参和 replay/backtest 工具。

## 改动约束

变更配置结构时，联动检查：`src/config/types.ts`、`src/config/loader.ts`、所有 `config/agent*.yaml`、`src/app/runtime.ts`、`src/app/runtime-guardrails.ts`、`src/app/startup-reconciliation.ts`

变更执行模式/契约时，联动检查：`src/domain/models.ts`、`src/domain/contracts.ts`、`src/execution/`、`src/services/`、`src/api/server.ts`、`src/dashboard/page.ts`

变更 Skill 生命周期/控制面状态时，联动检查：`src/core/shared-state.ts`、`src/managers/skill-manager.ts`、`src/services/control-service.ts`、`src/api/server.ts`、`src/dashboard/page.ts`、`src/persistence/state-serialization.ts`

变更 data provider 降级/system mode 策略时，联动检查：`src/managers/data-provider-manager.ts`、`src/managers/system-mode-manager.ts`、`src/orchestration/orchestrator.ts`、`src/modules/risk-sentinel.ts`

保持分层，不要把 provider/manager/execution/api 逻辑混进同一文件。变更外部数据源时保留 fallback 语义。不要硬编码密钥。

## 关键设计模式

- **优雅降级**：所有外部依赖（数据源、RPC、存储、LLM）失败时均有 fallback 路径
- **熔断器**：per-provider 健康检查，失败阈值后自动断开，超时后自动恢复
- **单实例锁**：file lock 防止并发写入
- **系统模式自动切换**：NORMAL → DEGRADED → CLOSE_ONLY → EMERGENCY_PAUSED
- **mutating action 约束**：执行结果为 success 时必须带 `stateOperations`，否则视为失败

## 测试

测试位于 `tests/`，按模块拆分。新增核心逻辑时优先补测试：
1. 纯逻辑单测（风控、选池、组合管理）
2. 契约测试（gateway payload、状态序列化）
3. 场景测试（编排器主循环、fallback、降级）

## 配置

默认配置 `config/agent.yaml`（dry_run），Skill 定义在 `config/skills/*.yaml`。
API 默认 `127.0.0.1:8787`，`XAGENT_API_TOKEN` 控制认证。
Telegram bot 默认只读，使用 `TG_BOT_TOKEN` + `TG_CHAT_ID` 授权，可通过 `XAGENT_DASHBOARD_URL` 返回公网 Dashboard 链接，并覆盖 Dashboard 主要只读视图。
状态持久化支持 file/SQLite，数据源缓存当前使用 memory backend。
审计事件支持 `storage.audit_retention` 定期清理，SQLite 与 JSONL 都按 source 裁剪旧事件/超量事件。
live preflight 会检查 signer/RPC、主数据源、池子发现、Jupiter/Jito/gateway、成本模型、硬过滤、SQLite 主存储，以及活跃仓位与 signer/链上账户一致性。
