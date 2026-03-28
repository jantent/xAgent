# RFC: 全自动 Meteora DLMM Meme Coin LP 管理 Agent

| 字段 | 内容 |
|------|------|
| **标题** | 全自动 Meteora DLMM Meme Coin LP 管理 Agent |
| **状态** | Draft |
| **日期** | 2026-03-28 |
| **版本** | v0.3 |


## 1. 背景与目标

### 1.1 为什么是 Meme Coin 而非主流币

主流币对（SOL/USDC 等）的 DLMM LP 面临结构性劣势：

| 问题 | 说明 |
|------|------|
| **暗池吃量** | 大额交易走暗池/OTC/Jupiter DCA，DEX 公开池子有效交易量持续萎缩 |
| **JIT Liquidity** | MEV bot 在大单前瞬间注入流动性、完成后撤出，平均稀释 LP 手续费达 85% |
| **收益天花板低** | 高 TVL + 低 fee rate（0.04-0.25%），扣除 IL 后常为负 |

Meme coin 池子的核心优势：fee rate 2-5%（是蓝筹的 20-50 倍），Volume/TVL 比率极端不对称，MEV bot 竞争较少。

**核心矛盾转变**：从"IL 吃掉手续费"变为"**token 归零风险 vs 超高手续费**"。

### 1.2 系统目标

构建一个**全自动、策略可插拔、外部依赖可降级**的 DLMM LP Agent，核心能力：

| 编号 | 目标 | 优先级 |
|------|------|--------|
| G1 | 自动池子发现与评分（聚焦 meme coin） | P0 |
| G2 | 策略化流动性部署（单边 SOL 为主） | P0 |
| G3 | 自动 Rebalance / 轮转 / 撤出 | P0 |
| G4 | 多数据源冗余与降级 | P0 |
| G5 | Skill 化策略管理（版本、灰度、回滚） | P1 |
| G6 | 可配置 LLM 驱动决策 | P1 |
| G7 | 实时风控与熔断 | P0 |
| G8 | 全链路监控与审计 | P0 |
| G9 | Web Dashboard | P2 |

### 1.3 非功能目标

| 指标 | 目标值 |
|------|--------|
| 核心循环可用性 | > 99.5% |
| 从检测信号到交易上链 | < 30s |
| 交易成功率 | > 90%（含重试） |
| 紧急撤出响应 | < 15s |
| 外部依赖不可用时降级时间 | < 5s（自动切换） |
| 单策略/Skill 上线到灰度验证 | < 1h |

---

## 2. 整体架构概览

### 2.1 架构图

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        Web Dashboard (Next.js)                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ 仓位概览 │ │ 池子雷达 │ │ P&L 追踪 │ │ 风控面板 │ │ Skill 管理面板 │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ REST / WebSocket
┌───────────────────────────────▼────────────────────────────────────────────┐
│                          API Gateway (Hono)                                │
│               (认证 · 限流 · 全局暂停开关 · 审计日志)                       │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│                       自研 Agent 框架 (Core Loop)                          │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    Orchestrator (30min 主循环)                       │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐  │  │
│  │  │ Pool Scout │ │ Strategy   │ │ Risk       │ │ Portfolio      │  │  │
│  │  │  (发现)    │ │ Selector   │ │ Sentinel   │ │ Manager        │  │  │
│  │  └──────┬─────┘ └──────┬─────┘ └──────┬─────┘ └───────┬────────┘  │  │
│  │         │ ▲             │ ▲             │ ▲              │ ▲        │  │
│  │         ▼ │             ▼ │             ▼ │              ▼ │        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │               LLM Interface Layer (可配置)                   │  │  │
│  │  │   ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────────┐  │  │  │
│  │  │   │ OpenAI  │  │Anthropic│  │ 本地模型  │  │ ...其他    │  │  │  │
│  │  │   └─────────┘  └─────────┘  └──────────┘  └────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    Skill Manager (策略生命周期)                      │  │
│  │  skill:bread_n_butter@v2.1 [active]                                 │  │
│  │  skill:sawtooth@v1.3       [active]                                 │  │
│  │  skill:sniper@v3.0         [canary 10%]                             │  │
│  │  skill:ewan@v1.0           [disabled]                               │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└──────────┬──────────────────────┬──────────────────────┬──────────────────┘
           │                      │                      │
           │                      │                      │
┌──────────▼──────────┐ ┌────────▼────────────┐ ┌──────▼──────────────────┐
│  Execution Layer    │ │  Data Provider      │ │  Solana RPC Layer       │
│  (Meteora 官方)     │ │  Abstraction        │ │  (主备切换)             │
│                     │ │                     │ │                         │
│ @meteora-ag/dlmm   │ │ ┌─────────────────┐ │ │ ┌───────┐ ┌──────────┐│
│ dlmm.datapi.       │ │ │  GMGN (Primary) │ │ │ │Primary│ │ Helius   ││
│   meteora.ag       │ │ ├─────────────────┤ │ │ │ RPC   │ │ (Backup) ││
│                     │ │ │ Provider A (2nd)│ │ │ └───┬───┘ └────┬─────┘│
│ • Pool Discovery   │ │ ├─────────────────┤ │ │     │    自动    │      │
│ • Add/Remove Liq.  │ │ │ Provider B (3rd)│ │ │     │    切换    │      │
│ • Rebalance        │ │ ├─────────────────┤ │ │     └─────┬──────┘      │
│ • Claim Fees       │ │ │ Local Cache     │ │ │           │             │
│ • Swap             │ │ │ (降级兜底)      │ │ │    ┌──────▼──────┐      │
│                     │ │ └─────────────────┘ │ │    │ Jito Bundle │      │
│                     │ │                     │ │    │ (MEV 防护)  │      │
│                     │ │ Health Check +      │ │    └─────────────┘      │
│                     │ │ Circuit Breaker     │ │                         │
└─────────────────────┘ └─────────────────────┘ └─────────────────────────┘
           │                      │                      │
           └──────────────────────┼──────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │        Storage Layer       │
                    │  ┌──────────┐ ┌─────────┐ │
                    │  │PostgreSQL│ │  Redis   │ │
                    │  │(State +  │ │(Cache + │ │
                    │  │ Audit)   │ │ Realtime)│ │
                    │  └──────────┘ └─────────┘ │
                    └───────────────────────────┘
```

### 2.2 核心模块说明

#### M1: 自研 Agent 框架（Core Loop）

不使用 LangGraph 或任何第三方 Agent 框架。自建一个**轻量级的任务编排引擎**，核心是一个 30 分钟周期的主循环（Orchestrator），内部顺序调度 4 个子模块：

| 子模块 | 职责 |
|--------|------|
| Pool Scout | 从数据源发现候选池、执行评分模型 |
| Strategy Selector | 根据池子特征 + 当前 Skill 配置选择策略并计算参数 |
| Risk Sentinel | 检查所有仓位安全状态、执行熔断规则 |
| Portfolio Manager | 跨池资金分配、轮转决策、执行入场/退出 |

同时有一个**高频监控循环**（每 5-10s），仅负责：
- 监听 gRPC 推送的 bin 状态变化
- 检查紧急信号（Dev Sell、Rug 等）
- 触发紧急撤出

详见 [3.3 自研 Agent 框架的核心流程](#33-自研-agent-框架的核心流程)。

#### M2: LLM Interface Layer（可配置 LLM）

抽象统一接口，通过配置文件指定 provider + model：

```yaml
# config/llm.yaml
llm:
  default:
    provider: "anthropic"        # openai | anthropic | local | ...
    model: "claude-sonnet-4-20250514"
    api_key_env: "ANTHROPIC_API_KEY"
    max_tokens: 4096
    temperature: 0.3
  classification:                 # 用于轻量分类任务
    provider: "anthropic"
    model: "claude-haiku"
    max_tokens: 1024
    temperature: 0.1
  fallback:                       # 主模型不可用时的降级
    provider: "openai"
    model: "gpt-4o-mini"
    api_key_env: "OPENAI_API_KEY"
```

详见 [3.2 LLM 可配置接口设计](#32-llm-可配置接口设计)。

#### M3: Skill Manager（策略配置与生命周期）

策略 = Skill。每个 Skill 是一个自包含的策略单元，有独立的元数据、版本、生命周期状态、运行参数和风险限额。

支持：创建 → 启用 → 灰度（canary）→ 全量 → 停用 → 下线/回滚。

详见 [3.1 策略/Skill 配置管理与生命周期](#31-策略skill-配置管理与生命周期)。

#### M4: Execution Layer（Meteora 官方 SDK + API）

**唯一的链上执行层**，直接使用：

| 组件 | 用途 |
|------|------|
| `@meteora-ag/dlmm` SDK | 链上交易构建：创建 Position、Add/Remove Liquidity、Rebalance、Claim Fees、Swap |
| `dlmm.datapi.meteora.ag` REST API | 池子发现与筛选、池子统计数据、手续费/交易量历史 |
| `jito-ts` | MEV 防护，所有 rebalance 交易通过 Jito Bundle 提交 |
| Jupiter SDK | Token swap（调仓时的 token 比例调整） |

详见 [3.5 Execution Layer 详细设计](#35-execution-layer-详细设计)。

#### M5: Data Provider Abstraction（数据源抽象层）

对所有外部数据源（GMGN、Provider A、Provider B）做统一抽象，支持：
- 多源冗余（primary → secondary → tertiary → local cache）
- 健康检查（定时探活 + 错误率统计）
- 自动熔断与切换
- 降级模式（仅缓存 → 只读 → 仅允许平仓）

详见 [3.4 数据源冗余与兜底方案](#34-数据源冗余与兜底方案)。

#### M6: Solana RPC Layer（主备 RPC）

| 角色 | 供应商 | 用途 |
|------|--------|------|
| Primary RPC | 可配置（如 QuickNode / Triton / Alchemy） | 全部读写操作 |
| Backup RPC | Helius Developer ($49/月) | Primary 不可用时自动切换 |
| gRPC Stream | Helius LaserStream 或 Yellowstone | 实时 bin 状态推送 |
| Jito | Jito Block Engine | 关键交易（rebalance、紧急撤出）的 MEV 防护提交 |

#### M7: 监控与运维

全链路可观测性：
- **Metrics**：Prometheus 格式，采集延迟、错误率、P&L 波动、调用 QPS
- **Logging**：结构化 JSON 日志，关键决策链路全量记录
- **Alerting**：多级告警（Telegram + Discord）
- **Audit**：每笔交易指令、策略版本、LLM 调用入参出参全部落盘

详见 [4. 稳定性与可靠性](#4-稳定性与可靠性)。

---

## 3. 关键设计

### 3.1 策略/Skill 配置管理与生命周期

#### 3.1.1 Skill 元数据结构

```typescript
interface SkillMeta {
  // === 标识 ===
  id: string;                    // 唯一ID，如 "bread_n_butter"
  version: string;               // 语义化版本，如 "2.1.0"
  name: string;                  // 展示名
  description: string;           // 策略描述

  // === 生命周期 ===
  status: SkillStatus;           // draft | canary | active | disabled | deprecated
  canaryPercent?: number;        // canary 模式下的流量百分比 (0-100)
  enabledAt?: Date;
  disabledAt?: Date;

  // === 策略参数 ===
  params: {
    direction: "below" | "above" | "both";   // 单边/双边
    distributionType: "Spot" | "Curve" | "BidAsk";
    binCount: number;                         // bin 数量
    binStepPreference: number[];              // 偏好的 bin step (如 [80, 100])
    feeRatePreference: number[];              // 偏好的 fee rate (如 [0.02, 0.05])
    entryConditions: EntryCondition[];        // 入场条件集合
    exitConditions: ExitCondition[];          // 退出条件集合
    rebalanceRules: RebalanceRule[];          // rebalance 规则
  };

  // === 风险限额 ===
  riskLimits: {
    maxPositionSizePercent: number;   // 单仓位最大占比 (如 2%)
    maxTotalExposurePercent: number;  // 此策略总敞口上限 (如 10%)
    maxConcurrentPositions: number;   // 同时持仓数上限
    stopLossPercent: number;          // 止损线
    maxAliveHours: number;            // 最大存活时间
    maxDailyRebalances: number;       // 日最大 rebalance 次数
  };

  // === 适用条件 ===
  applicability: {
    minLincolnScore: number;
    minSafetyScore: number;
    minMcap?: number;
    maxMcap?: number;
    lifecycleStages: LifecycleStage[];  // 适用的生命周期阶段
  };

  // === 版本历史 ===
  changelog: string;
  previousVersion?: string;      // 用于回滚
  createdAt: Date;
  updatedAt: Date;
}

enum SkillStatus {
  DRAFT = "draft",           // 草稿，不参与调度
  CANARY = "canary",         // 灰度模式（仅分配 canaryPercent% 的资金）
  ACTIVE = "active",         // 全量生效
  DISABLED = "disabled",     // 临时停用（可重新启用）
  DEPRECATED = "deprecated"  // 永久下线
}
```

#### 3.1.2 Skill 生命周期状态机

```
          create()
             │
             ▼
          ┌──────┐    enable(canary=10%)    ┌────────┐
          │ DRAFT │ ──────────────────────→  │ CANARY │
          └──────┘                           └────┬───┘
             │                                    │
             │  enable(canary=100%)                │ promote() 或
             │                                    │ enable(canary=100%)
             ▼                                    ▼
          ┌────────┐                          ┌────────┐
          │ ACTIVE │ ◄────────────────────── │ ACTIVE │
          └────┬───┘                          └────────┘
               │
       disable()│                rollback(toVersion)
               │                       │
               ▼                       ▼
          ┌──────────┐           加载 previousVersion
          │ DISABLED │           的 Skill 配置并设为 ACTIVE
          └────┬─────┘
               │
       deprecate()
               │
               ▼
          ┌────────────┐
          │ DEPRECATED │
          └────────────┘
```

#### 3.1.3 Skill 调度逻辑

```typescript
function selectSkillForPool(pool: PoolCandidate, activeSkills: SkillMeta[]): SkillMeta | null {
  // 1. 过滤：仅保留 status=active 或 status=canary 的 Skill
  const eligible = activeSkills.filter(s =>
    s.status === "active" || s.status === "canary"
  );

  // 2. 匹配：检查 Skill 的 applicability 是否满足池子特征
  const matched = eligible.filter(s =>
    pool.lincolnScore >= s.applicability.minLincolnScore &&
    pool.safetyScore >= s.applicability.minSafetyScore &&
    (!s.applicability.minMcap || pool.mcap >= s.applicability.minMcap) &&
    (!s.applicability.maxMcap || pool.mcap <= s.applicability.maxMcap) &&
    s.applicability.lifecycleStages.includes(pool.lifecycleStage)
  );

  if (matched.length === 0) return null;

  // 3. 优先级：active > canary；同级按 specificity 排序
  const sorted = matched.sort((a, b) => {
    if (a.status === "active" && b.status === "canary") return -1;
    if (a.status === "canary" && b.status === "active") return 1;
    // 同级按条件精确度排序（条件越多 = 越具体 = 越优先）
    return Object.keys(b.applicability).length - Object.keys(a.applicability).length;
  });

  const selected = sorted[0];

  // 4. Canary 概率判断
  if (selected.status === "canary") {
    if (Math.random() * 100 > selected.canaryPercent!) {
      // 未命中 canary，使用下一个 active skill
      return sorted.find(s => s.status === "active") || null;
    }
  }

  return selected;
}
```

#### 3.1.4 Skill 配置存储

```sql
CREATE TABLE skills (
    id              VARCHAR(64) PRIMARY KEY,
    version         VARCHAR(16) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    description     TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'draft',
    canary_percent  INT DEFAULT 0,
    params          JSONB NOT NULL,
    risk_limits     JSONB NOT NULL,
    applicability   JSONB NOT NULL,
    changelog       TEXT,
    previous_version VARCHAR(16),
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    enabled_at      TIMESTAMP,
    disabled_at     TIMESTAMP,
    UNIQUE(id, version)
);

-- 每个 Skill 实例的运行时统计
CREATE TABLE skill_stats (
    skill_id          VARCHAR(64) REFERENCES skills(id),
    skill_version     VARCHAR(16),
    total_positions   INT DEFAULT 0,
    active_positions  INT DEFAULT 0,
    total_pnl_usd     DECIMAL(20,2) DEFAULT 0,
    total_fees_usd    DECIMAL(20,2) DEFAULT 0,
    avg_position_hours DECIMAL(10,2) DEFAULT 0,
    win_rate           DECIMAL(5,4) DEFAULT 0,       -- 盈利仓位比例
    max_drawdown_pct   DECIMAL(5,4) DEFAULT 0,
    updated_at         TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY(skill_id, skill_version)
);
```

#### 3.1.5 预置 Skill 示例

| Skill ID | 名称 | 方向 | Bins | 适用条件 | 状态 |
|----------|------|------|------|---------|------|
| `bread_n_butter` | Bread 'n Butter | 单边 SOL (below) | 69, Spot | Lincoln > 1.5%, Safety > 50, Hype/Plateau | active |
| `sawtooth` | Sawtooth BidAsk | 单边 SOL (below) | 2×69, BidAsk | Lincoln > 2%, Safety > 60, 看跌信号 | active |
| `sniper` | Sniper | 单边 SOL (below) | 30, Curve | Lincoln > 5%, Safety > 70, Hype 阶段 | canary 20% |
| `ewan` | Ewan | 双边 | 61, Spot | MC > $30M, 存活 > 7d, Lincoln > 3% | disabled |

### 3.2 LLM 可配置接口设计

#### 3.2.1 统一接口定义

```typescript
// === 抽象接口 ===
interface ILLMProvider {
  readonly name: string;
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  chatWithTools(request: LLMToolRequest): Promise<LLMToolResponse>;
  healthCheck(): Promise<boolean>;
}

interface LLMChatRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;           // 强制 JSON 输出
}

interface LLMChatResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number; };
  latencyMs: number;
  model: string;
  provider: string;
}

interface LLMToolRequest extends LLMChatRequest {
  tools: ToolDefinition[];      // 可调用的函数定义
}

interface LLMToolResponse extends LLMChatResponse {
  toolCalls?: ToolCall[];       // LLM 请求调用的函数
}
```

#### 3.2.2 Provider 实现

```typescript
// === Anthropic Provider ===
class AnthropicProvider implements ILLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(config: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    const start = Date.now();
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.3,
      system: req.systemPrompt,
      messages: req.messages,
    });
    return {
      content: resp.content[0].type === "text" ? resp.content[0].text : "",
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
      latencyMs: Date.now() - start,
      model: this.model,
      provider: this.name,
    };
  }
  // ... chatWithTools, healthCheck 类似
}

// === OpenAI Provider ===
class OpenAIProvider implements ILLMProvider { /* 类似实现 */ }

// === 本地模型 Provider (Ollama) ===
class LocalProvider implements ILLMProvider { /* 类似实现 */ }
```

#### 3.2.3 LLM Manager（路由 + 降级）

```typescript
class LLMManager {
  private providers: Map<string, ILLMProvider> = new Map();
  private config: LLMConfig;

  constructor(configPath: string) {
    this.config = loadYaml(configPath);
    this.initProviders();
  }

  async chat(role: "default" | "classification" | "fallback", req: LLMChatRequest): Promise<LLMChatResponse> {
    const providerName = this.config.llm[role]?.provider ?? this.config.llm.default.provider;
    const provider = this.providers.get(providerName);

    try {
      return await provider.chat(req);
    } catch (err) {
      // 降级到 fallback provider
      if (role !== "fallback" && this.config.llm.fallback) {
        logger.warn(`LLM ${providerName} failed, falling back`, { error: err });
        return this.chat("fallback", req);
      }
      throw err;
    }
  }
}
```

#### 3.2.4 LLM 在系统中的具体用途

| 用途 | 调用角色 | 频率 | 输入 | 输出 |
|------|---------|------|------|------|
| 池子 narrative 分析 | default | 每 30min | Token 名、描述、社交数据 | narrative 分类 + 热度判断 |
| 异常解读 | default | 事件触发 | 异常数据点集合 | 根因分析 + 建议操作 |
| 策略选择辅助 | default | 每 30min | 池子特征 + 可用 Skill 列表 | 推荐 Skill + 参数调整建议 |
| Dev Sell 真假判断 | classification | 事件触发 | 钱包行为序列 | true/false + 置信度 |
| 日报/周报生成 | default | 定时 | 统计数据 | 格式化报告 |

**关键设计决策**：LLM **不直接控制**任何链上操作。LLM 输出的是"建议"，最终决策由规则引擎（Risk Sentinel + Skill 参数）把关。这消除了 LLM 幻觉导致资金损失的风险。

### 3.3 自研 Agent 框架的核心流程

#### 3.3.1 双循环架构

```
┌─────────────────────────────────────────────────────────┐
│               HIGH-FREQ LOOP (5-10s)                     │
│                                                          │
│  while (running && !globalPause) {                       │
│    // 1. 检查紧急信号                                     │
│    signals = await dataProvider.getUrgentSignals();       │
│    if (signals.hasDevSell || signals.hasRug) {            │
│      await riskSentinel.executeEmergencyExit(signals);    │
│    }                                                      │
│                                                          │
│    // 2. 检查活跃仓位状态（通过 gRPC 推送或轮询）          │
│    for (pos of activePositions) {                         │
│      if (pos.isOutOfRange && outOfRangeDuration > 5min) { │
│        await evaluateRebalanceOrExit(pos);                │
│      }                                                    │
│    }                                                      │
│                                                          │
│    // 3. 检查风控熔断条件                                  │
│    await riskSentinel.checkCircuitBreakers();              │
│                                                          │
│    await sleep(config.highFreqIntervalMs); // 5000-10000  │
│  }                                                        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               MAIN LOOP (30min)                          │
│                                                          │
│  while (running && !globalPause) {                       │
│    // Phase 1: SCAN — 发现候选池                          │
│    candidates = await poolScout.discoverAndScore();       │
│                                                          │
│    // Phase 2: EVALUATE — 策略匹配                        │
│    plans = await strategySelector.matchSkills(candidates);│
│                                                          │
│    // Phase 3: RISK CHECK — 风控审核                      │
│    approvedPlans = await riskSentinel.review(plans);      │
│                                                          │
│    // Phase 4: PORTFOLIO — 资金分配 + 退出决策             │
│    actions = await portfolioManager.optimize(              │
│      approvedPlans, currentPositions, availableCapital    │
│    );                                                     │
│                                                          │
│    // Phase 5: EXECUTE — 执行所有操作                     │
│    for (action of actions) {                              │
│      result = await executionLayer.execute(action);       │
│      await auditLog.record(action, result);               │
│    }                                                      │
│                                                          │
│    // Phase 6: REPORT — 生成摘要                          │
│    await notifier.sendCycleSummary(actions, results);     │
│                                                          │
│    await sleep(config.mainLoopIntervalMs); // 1800000     │
│  }                                                        │
└─────────────────────────────────────────────────────────┘
```

#### 3.3.2 模块间通信

模块间**不使用消息队列或事件总线**（过度设计），直接通过函数调用 + 共享状态（Redis）通信：

```typescript
// 核心协调器
class Orchestrator {
  private poolScout: PoolScout;
  private strategySelector: StrategySelector;
  private riskSentinel: RiskSentinel;
  private portfolioManager: PortfolioManager;
  private executionLayer: ExecutionLayer;
  private llm: LLMManager;
  private skillManager: SkillManager;
  private state: SharedState;         // Redis-backed
  private auditLog: AuditLogger;      // PostgreSQL-backed

  async runMainCycle(): Promise<CycleResult> {
    const cycleId = generateCycleId();
    this.auditLog.startCycle(cycleId);

    try {
      // Phase 1-5 如上
      // 每个 phase 的输入输出都记录到 auditLog
    } catch (err) {
      this.auditLog.recordError(cycleId, err);
      // 不 throw — 主循环不能因为单次错误停止
      logger.error("Main cycle error", { cycleId, error: err });
    }
  }
}
```

#### 3.3.3 全局控制能力（替代 Human-in-the-Loop）

不需要日常人工审批，但保留以下**紧急手动干预能力**：

| 操作 | 触发方式 | 效果 |
|------|---------|------|
| **全局暂停** | Dashboard 按钮 / Telegram `/pause` / API `POST /control/pause` | 两个循环立即停止，不开新仓，现有仓位不动 |
| **全局恢复** | 同上 `/resume` | 恢复两个循环 |
| **单 Skill 停机** | `POST /skills/{id}/disable` | 该 Skill 不再匹配新池子，现有仓位继续管理直到自然退出 |
| **强制全撤** | `POST /control/emergency-exit-all` | 立即撤出所有仓位，换回 SOL |
| **强制单仓撤出** | `POST /positions/{id}/force-exit` | 撤出指定仓位 |
| **参数热更新** | `PUT /skills/{id}/params` | 运行时更新 Skill 参数，不需要重启 |

### 3.4 数据源冗余与兜底方案

#### 3.4.1 GMGN 依赖点梳理

| 依赖点 | 具体数据 | 调用频率 | 可替代性 |
|--------|---------|---------|---------|
| **Token 安全信息** | mint_disable, freeze_authority, top_holder_pct, lp_burn_pct, rug_probability, is_honeypot, dev_rug_history | 每个候选池评估时 (~30min/batch) | 中 — 可从链上直接读取 mint/freeze authority，但 rug_probability 和 dev_history 是 GMGN 的增值数据 |
| **Smart Money 流向** | smart_buy_24h, smart_sell_24h | 每 30min | 低 — 这是 GMGN 核心差异化数据 |
| **Trending Tokens** | 热度排行、volume 排行 | 每 30min | 高 — 可从 Meteora API 的 volume/fee 排序替代 |
| **Dev Sell 信号** | 开发者钱包卖出告警 | 实时（WebSocket） | 低 — 需要追踪特定钱包，GMGN 有积累 |
| **Token OHLCV** | K 线数据 | 按需 | 高 — Jupiter / Birdeye / DexScreener 均可替代 |

#### 3.4.2 Data Provider 抽象层

```typescript
// === 统一数据接口 ===
interface IDataProvider {
  readonly name: string;
  readonly priority: number;     // 数字越小优先级越高

  // Token 安全
  getTokenSafety(mint: string): Promise<TokenSafetyData>;
  // Smart Money
  getSmartMoneyFlow(mint: string): Promise<SmartMoneyData>;
  // Trending
  getTrendingTokens(chain: string, period: string): Promise<TrendingToken[]>;
  // Dev Sell 信号（WebSocket 或轮询）
  subscribeDevSellSignals?(callback: (signal: DevSellSignal) => void): void;
  // OHLCV
  getOHLCV(mint: string, interval: string): Promise<OHLCV[]>;
  // 健康检查
  healthCheck(): Promise<HealthStatus>;
}

// === 实现 ===
class GmgnProvider implements IDataProvider {
  readonly name = "gmgn";
  readonly priority = 1;
  // ... 实现所有方法
}

class ProviderA implements IDataProvider {  // 例如 Birdeye / DexScreener
  readonly name = "provider_a";
  readonly priority = 2;
  // 部分方法实现，getSmartMoneyFlow 可以 throw NotSupported
}

class ProviderB implements IDataProvider {  // 例如链上直读 + Jupiter
  readonly name = "provider_b";
  readonly priority = 3;
  // 仅能提供基础安全数据和 OHLCV
}
```

#### 3.4.3 DataProviderManager（路由 + 熔断 + 缓存）

```typescript
class DataProviderManager {
  private providers: IDataProvider[];
  private circuitBreakers: Map<string, CircuitBreaker>;
  private cache: Redis;

  async getTokenSafety(mint: string): Promise<TokenSafetyData> {
    // 1. 先查 Redis 缓存
    const cached = await this.cache.get(`safety:${mint}`);
    if (cached && !isExpired(cached, 300_000)) {  // 5min TTL
      return JSON.parse(cached);
    }

    // 2. 按优先级逐个尝试 provider
    for (const provider of this.providers) {
      const breaker = this.circuitBreakers.get(provider.name);

      if (breaker.isOpen()) {
        continue;  // 熔断中，跳过
      }

      try {
        const result = await withTimeout(
          provider.getTokenSafety(mint),
          5000  // 5s 超时
        );
        // 成功：写缓存 + 重置熔断器
        await this.cache.setex(`safety:${mint}`, 300, JSON.stringify(result));
        breaker.recordSuccess();
        return result;
      } catch (err) {
        breaker.recordFailure();
        logger.warn(`Provider ${provider.name} failed for getTokenSafety`, { mint, err });
        continue;  // 尝试下一个 provider
      }
    }

    // 3. 所有 provider 失败：使用过期缓存（如果有）
    if (cached) {
      logger.warn("All providers failed, using stale cache", { mint });
      return JSON.parse(cached);
    }

    // 4. 完全没数据：返回保守默认值（高风险标记）
    return {
      mint,
      safetyScore: 0,
      verdict: "UNKNOWN",
      source: "default_fallback",
      isStale: true
    };
  }
}
```

#### 3.4.4 熔断器实现

```typescript
class CircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failureCount = 0;
  private lastFailureAt?: Date;
  private readonly failureThreshold: number;     // 默认 5
  private readonly recoveryTimeMs: number;        // 默认 60000 (1min)

  isOpen(): boolean {
    if (this.state === "open") {
      // 检查是否该尝试半开
      if (Date.now() - this.lastFailureAt!.getTime() > this.recoveryTimeMs) {
        this.state = "half_open";
        return false;  // 允许一次探测
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = new Date();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      metrics.increment("circuit_breaker.opened", { provider: this.name });
    }
  }
}
```

#### 3.4.5 降级策略矩阵

| 场景 | 新开仓 | Rebalance | 撤出/平仓 | Smart Money 信号 | 安全评分 |
|------|--------|-----------|----------|-----------------|---------|
| **正常** | ✅ | ✅ | ✅ | ✅ 实时 | ✅ 实时 |
| **GMGN 不可用，Provider A 可用** | ✅（降级评分） | ✅ | ✅ | ❌ 无 Smart Money | ✅ 基础 |
| **GMGN + Provider A 不可用** | ❌ **暂停新开仓** | ✅（仅已有仓位） | ✅ | ❌ | ⚠️ 仅缓存 |
| **所有 Provider 不可用 > 10min** | ❌ | ❌ | ✅ **仅允许平仓** | ❌ | ❌ |
| **所有 Provider 不可用 > 30min** | ❌ | ❌ | ✅ **自动全撤** | ❌ | ❌ |

### 3.5 Execution Layer 详细设计

#### 3.5.1 Meteora 官方 API + SDK 能力映射

**REST API（`dlmm.datapi.meteora.ag`）— 只读数据**：

| 端点 | 用途 | 关键参数 |
|------|------|---------|
| `GET /pools` | 池子发现与筛选 | `filter_by[]=volume_24h:>10000`, `sort_by=fee_tvl_ratio:desc`, `limit=50` |
| `GET /pools/{address}` | 单池详情 | 返回 TVL、active bin、current_price、fee_rate 等 |
| `GET /pools/{address}/analytics/volume` | 交易量历史 | `period=1h/24h/7d` |
| `GET /pools/{address}/analytics/fee` | 手续费历史 | `period=1h/24h/7d` |
| `GET /pair/all` | 全量交易对列表 | 轻量级概览数据 |
| `GET /pools/groups` | 按 token 分组的池子列表 | 用于发现同一 token 的最优池子 |

**限速**：30 RPS（所有端点共享）。

**SDK（`@meteora-ag/dlmm`）— 链上读写操作**：

| 操作 | SDK 方法 | 说明 |
|------|---------|------|
| 创建池子实例 | `DLMM.create(connection, poolPubkey)` | 加载池子链上状态 |
| 获取 Active Bin | `dlmmPool.getActiveBin()` | 返回 binId + price |
| **获取价格**（替代预言机） | `dlmmPool.fromPricePerLamport(price)` | 从 active bin 计算精确价格 |
| 创建 Position | `dlmmPool.initializePositionAndAddLiquidityByStrategy()` | 一步完成创建 + 加仓 |
| 添加流动性 | `dlmmPool.addLiquidityByStrategy({strategyType, minBinId, maxBinId, ...})` | 支持 Spot/Curve/BidAsk |
| 移除流动性 | `dlmmPool.removeLiquidity({binIds, bps, ...})` | bps=10000 为全量移除 |
| **原子化 Rebalance** | `dlmmPool.rebalanceLiquidity({positionPubkey, removeBinIds, addBinIds, shrinkMode})` | PositionV2 专属，单交易完成移除+重新部署 |
| 提取手续费 | `dlmmPool.claimAllSwapFee({positions})` | 批量提取所有仓位手续费 |
| Swap | `dlmmPool.swap({inAmount, outToken, slippage, ...})` | 池内 swap |

**PositionV2 关键参数**：
- 最大 bin 数：**1,400 bins**
- 支持 `ShrinkMode`：ShrinkBoth / NoShrinkLeft / NoShrinkRight
- 支持动态 resize（扩大/缩小 bin 范围而不移除流动性）

#### 3.5.2 价格获取方案（替代预言机）

**方案：Active Bin Price + Jupiter Price API 双源**

```typescript
async function getPrice(tokenMint: string, poolAddress: string): Promise<PriceData> {
  // 来源 1: Meteora Active Bin（最精确的 DEX 内价格）
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  const activeBin = await dlmmPool.getActiveBin();
  const meteoraPrice = parseFloat(activeBin.pricePerToken);

  // 来源 2: Jupiter Price API（跨 DEX 聚合价格）
  const jupResp = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`);
  const jupPrice = (await jupResp.json()).data?.[tokenMint]?.price;

  // 交叉验证
  if (jupPrice && Math.abs(meteoraPrice - jupPrice) / jupPrice > 0.05) {
    // 分歧 > 5%：标记异常
    logger.warn("Price divergence detected", { meteoraPrice, jupPrice, tokenMint });
    return { price: meteoraPrice, jupPrice, divergence: true, source: "meteora_primary" };
  }

  return { price: meteoraPrice, jupPrice, divergence: false, source: "meteora_primary" };
}
```

**为什么不需要价格预言机**：
1. Meme coin 绝大多数没有 Pyth/Switchboard feed
2. 我们只需要"当前池子中的价格"来决定 bin range，不需要"跨链一致性"
3. Active Bin 就是实际交易价格，是最直接的数据来源
4. Jupiter API 作为"市场公允价格"的参考，足够做异常检测

#### 3.5.3 核心执行流程

```typescript
class ExecutionLayer {
  private connection: Connection;
  private wallet: Keypair;
  private rpcManager: RPCManager;        // 主备切换
  private jitoClient: JitoClient;

  // === 开仓 ===
  async openPosition(pool: PoolInfo, skill: SkillMeta, amountLamports: BN): Promise<OpenResult> {
    const dlmmPool = await DLMM.create(this.rpcManager.getConnection(), new PublicKey(pool.address));
    const activeBin = await dlmmPool.getActiveBin();

    // 根据 Skill 参数计算 bin range
    const { minBinId, maxBinId } = this.calculateBinRange(activeBin.binId, skill);

    // 构建交易
    const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPositionKeypair.publicKey,
      user: this.wallet.publicKey,
      totalXAmount: skill.params.direction === "below" ? new BN(0) : amountLamports,
      totalYAmount: skill.params.direction === "below" ? amountLamports : new BN(0),
      strategy: {
        strategyType: this.mapDistributionType(skill.params.distributionType),
        minBinId,
        maxBinId,
      },
    });

    // 通过 Jito Bundle 提交（MEV 防护）
    return this.submitViaJito(tx, [this.wallet, newPositionKeypair]);
  }

  // === 平仓（全额撤出 + swap 回 SOL） ===
  async closePosition(positionPubkey: PublicKey, poolAddress: PublicKey): Promise<CloseResult> {
    const dlmmPool = await DLMM.create(this.rpcManager.getConnection(), poolAddress);

    // 1. 提取手续费
    const claimTx = await dlmmPool.claimAllSwapFee({ owner: this.wallet.publicKey, positions: [positionPubkey] });

    // 2. 移除全部流动性
    const position = await dlmmPool.getPosition(positionPubkey);
    const removeTx = await dlmmPool.removeLiquidity({
      position: positionPubkey,
      user: this.wallet.publicKey,
      binIds: position.positionData.positionBinData.map(b => b.binId),
      bps: new BN(10000),  // 100%
    });

    // 3. 如果收到 meme token，swap 回 SOL（通过 Jupiter）
    const swapTx = await this.buildJupiterSwapToSOL(memeTokenMint, memeTokenAmount);

    // 4. 打包为 Jito Bundle 原子执行
    return this.submitViaJito([claimTx, removeTx, swapTx], [this.wallet]);
  }

  // === 原子化 Rebalance（PositionV2） ===
  async rebalancePosition(positionPubkey: PublicKey, poolAddress: PublicKey, newRange: BinRange): Promise<RebalanceResult> {
    const dlmmPool = await DLMM.create(this.rpcManager.getConnection(), poolAddress);
    const position = await dlmmPool.getPosition(positionPubkey);

    const currentBins = position.positionData.positionBinData.map(b => b.binId);
    const newBins = this.generateBinIds(newRange.minBinId, newRange.maxBinId);

    const removeBins = currentBins.filter(b => !newBins.includes(b));
    const addBins = newBins.filter(b => !currentBins.includes(b));

    const tx = await dlmmPool.rebalanceLiquidity({
      positionPubkey,
      user: this.wallet.publicKey,
      removeBinIds: removeBins,
      addBinIds: addBins,
      shrinkMode: ShrinkMode.ShrinkBoth,
      strategyType: StrategyType.Spot,
    });

    return this.submitViaJito(tx, [this.wallet]);
  }

  // === Jito Bundle 提交 ===
  private async submitViaJito(transactions: Transaction[], signers: Keypair[]): Promise<TxResult> {
    const JITO_ENDPOINT = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

    // 添加 tip
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * 8)],
      lamports: this.config.jitoTipLamports,
    });

    // 签名 + 提交 + 轮询确认
    // 重试策略: priority fee 递增 (p50 → p75 → p90)，最多 3 次
    return this.submitWithRetry(transactions, signers, { maxRetries: 3 });
  }
}
```

#### 3.5.4 RPC 主备切换

```typescript
class RPCManager {
  private primary: Connection;
  private backup: Connection;         // Helius
  private activeName: "primary" | "backup" = "primary";
  private breaker: CircuitBreaker;

  getConnection(): Connection {
    if (this.breaker.isOpen()) {
      this.activeName = "backup";
      metrics.increment("rpc.failover_to_backup");
      return this.backup;
    }
    return this.primary;
  }

  async healthCheck(): Promise<void> {
    try {
      await withTimeout(this.primary.getLatestBlockhash(), 5000);
      this.breaker.recordSuccess();
      if (this.activeName === "backup") {
        this.activeName = "primary";
        metrics.increment("rpc.recovered_to_primary");
      }
    } catch {
      this.breaker.recordFailure();
    }
  }
}
```

### 3.6 密钥与钱包地址管理

#### 3.6.1 设计原则

| 原则 | 说明 |
|------|------|
| **轻量起步** | 单 Phantom 钱包 + 单地址，不引入 Squads 多签等企业级方案 |
| **地址可轮换** | 更换钱包地址不影响策略配置和系统运行 |
| **私钥最短生命周期** | 尽可能减少后端持有私钥的时间 |
| **安全与便利的平衡** | 承认全自动交易必须后端能签名的现实 |

#### 3.6.2 两种模式

**模式 A：委托签名模式（推荐初期使用）**

```
┌────────────┐      ┌──────────────┐      ┌───────────────┐
│  Phantom   │      │  Agent 后端   │      │  Solana 链上  │
│  (手动签名) │      │  (不持有私钥) │      │               │
└─────┬──────┘      └───────┬──────┘      └───────────────┘
      │                     │
      │  1. Agent 构建未签名交易
      │  2. 推送到 Dashboard/Telegram
      │                     │
      │  3. 用户在 Phantom 中签名
      │                     │
      │  4. 签名后的交易提交上链
      │                     │
```

- **优点**：后端完全不接触私钥
- **缺点**：不是全自动——每笔交易需要手动签名
- **适用**：大额操作、高风险操作

**模式 B：运行时密钥注入（推荐全自动模式）**

```
┌────────────────────────────────────────────────────────────┐
│  启动流程                                                   │
│                                                             │
│  1. 运维人员通过安全渠道注入私钥（环境变量/加密文件）         │
│     $ export SOLANA_PRIVATE_KEY=$(cat key.json)             │
│     或                                                      │
│     $ WALLET_PASSPHRASE=xxx node agent.js                  │
│                                                             │
│  2. Agent 启动时读取 → 解密 → 加载到内存                    │
│  3. 运行期间私钥仅在内存中，不写磁盘                        │
│  4. Agent 停止时内存释放                                    │
│                                                             │
│  加密方案:                                                  │
│  - 密钥文件使用 AES-256-GCM 加密存储                       │
│  - 密码通过环境变量 WALLET_PASSPHRASE 提供                  │
│  - 解密后的密钥材料仅在进程内存中                           │
└────────────────────────────────────────────────────────────┘
```

#### 3.6.3 地址轮换机制

```typescript
// config/wallet.yaml
wallet:
  active_address: "9xBv...4mZw"          # 当前活跃地址
  mode: "injected"                        # injected | phantom_delegate
  key_encryption: "aes-256-gcm"
  addresses:
    - address: "9xBv...4mZw"
      label: "wallet-v1"
      activated_at: "2026-03-28"
      status: "active"
    - address: "6dKx...3nVw"
      label: "wallet-v0"
      activated_at: "2026-03-01"
      retired_at: "2026-03-27"
      status: "retired"
```

```typescript
// 切换地址流程
async function rotateWalletAddress(newAddress: string): Promise<void> {
  // 1. 暂停所有新操作（全局暂停）
  await orchestrator.pause("wallet_rotation");

  // 2. 清仓：关闭所有现有仓位（Zap-Out 到 SOL）
  await executionLayer.closeAllPositions();

  // 3. 转账：将所有 SOL 转到新地址（手动在 Phantom 中操作）
  logger.info("请手动将资金从旧地址转到新地址", { from: oldAddress, to: newAddress });

  // 4. 等待确认余额到账
  await waitForBalance(newAddress, expectedBalance);

  // 5. 更新配置
  await updateConfig({ "wallet.active_address": newAddress });

  // 6. 注入新地址的密钥
  await promptForNewKeyInjection();

  // 7. 恢复运行
  await orchestrator.resume();
}
```

#### 3.6.4 风险与权衡

| 方案 | 安全性 | 自动化程度 | 适用阶段 |
|------|--------|-----------|---------|
| 模式 A（Phantom 委托签名） | ⭐⭐⭐⭐⭐ | ⭐⭐ | 初期小资金测试 |
| 模式 B（运行时注入） | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 全自动生产运行 |
| 模式 B + 操作限额 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 推荐的生产方案 |

**模式 B + 操作限额**的具体约束：

```yaml
# config/wallet_limits.yaml
limits:
  per_transaction_max_sol: 5.0        # 单笔最大 5 SOL
  daily_cumulative_max_sol: 50.0      # 日累计最大 50 SOL
  max_positions_open: 40              # 最多同时 40 个仓位
  emergency_exit_no_limit: true       # 紧急撤出不受限额约束
```

---

## 4. 稳定性与可靠性

### 4.1 监控指标体系

| 类别 | 指标 | 采集频率 | 告警阈值 |
|------|------|---------|---------|
| **系统健康** | 主循环是否在运行 | 10s | 停止 > 60s |
| | 高频循环是否在运行 | 5s | 停止 > 30s |
| | 内存使用 | 30s | > 80% |
| | CPU 使用 | 30s | > 90% |
| **RPC** | 请求延迟 P50/P95/P99 | 每次请求 | P99 > 5s |
| | 错误率 | 1min 窗口 | > 10% |
| | 当前使用的 RPC (primary/backup) | 实时 | 切到 backup 时告警 |
| **数据源** | 各 Provider 可用性 | 30s | 不可用 > 60s |
| | 数据新鲜度（最后更新时间） | 30s | 过期 > 5min |
| | 熔断器状态 | 实时 | 任何 provider open |
| **执行层** | 交易成功率 | 滑动窗口 | < 80% |
| | 交易延迟（构建→上链） | 每次交易 | P95 > 30s |
| | Jito Bundle 落地率 | 每次交易 | < 70% |
| **业务** | 活跃仓位数 | 实时 | < 5 或 > 50 |
| | 24h 组合 P&L | 实时 | 亏损 > 5% |
| | 各 Skill 命中率 / 胜率 | 每 30min | 胜率 < 30% |
| | Lincoln Score 总体趋势 | 每 30min | 均值持续下降 |
| **LLM** | 调用延迟 | 每次调用 | P95 > 10s |
| | 错误率 | 1min 窗口 | > 20% |
| | Token 消耗 | 每日统计 | 日消耗 > 阈值（成本控制） |

### 4.2 告警分级

| 级别 | 渠道 | 触发条件 |
|------|------|---------|
| **CRITICAL** | Telegram 即时 | Dev Sell, Rug 检测, 组合亏损 > 5%, 全部 RPC 不可用, 全部 Provider 不可用 > 10min |
| **HIGH** | Telegram | 仓位出界 > 5min, 单池亏损 > 20%, Primary RPC 切到 Backup, GMGN 熔断 |
| **MEDIUM** | Telegram (汇总) | 新 S 级池子发现, Rebalance 执行, 手续费提取, Skill 灰度指标 |
| **LOW** | Dashboard / Discord | 日报, Lincoln Score 变化, Skill 统计更新 |

### 4.3 错误处理策略

#### 4.3.1 重试策略

```typescript
interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

const RETRY_POLICIES: Record<string, RetryPolicy> = {
  // 链上交易：aggressive retry + priority fee 递增
  "solana_tx": {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 16000,
    backoffMultiplier: 2,
    retryableErrors: ["BlockhashNotFound", "TransactionExpired", "InsufficientFundsForFee"],
  },
  // 数据 API：quick retry then failover
  "data_api": {
    maxRetries: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    retryableErrors: ["TIMEOUT", "503", "429", "ECONNRESET"],
  },
  // LLM：retry then fallback provider
  "llm": {
    maxRetries: 1,
    baseDelayMs: 3000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableErrors: ["TIMEOUT", "503", "429", "overloaded"],
  },
};
```

#### 4.3.2 降级模式

```typescript
enum SystemMode {
  NORMAL = "normal",                   // 全功能运行
  DEGRADED_NO_SIGNALS = "degraded_no_signals",  // 数据源不可用，暂停新开仓
  DEGRADED_READ_ONLY = "degraded_read_only",    // RPC 写入异常，仅监控
  CLOSE_ONLY = "close_only",           // 仅允许平仓/撤出
  EMERGENCY_PAUSED = "emergency_paused" // 全部暂停（人工触发）
}

class SystemModeManager {
  private currentMode: SystemMode = SystemMode.NORMAL;

  evaluateMode(): SystemMode {
    // 检查各依赖状态
    const rpcHealth = rpcManager.getHealth();
    const dataHealth = dataProviderManager.getHealth();
    const portfolioHealth = portfolioManager.getHealth();

    if (this.isManuallyPaused) return SystemMode.EMERGENCY_PAUSED;
    if (!rpcHealth.canWrite) return SystemMode.DEGRADED_READ_ONLY;
    if (!dataHealth.hasAnyProvider) return SystemMode.CLOSE_ONLY;
    if (!dataHealth.hasPrimaryProvider) return SystemMode.DEGRADED_NO_SIGNALS;
    if (portfolioHealth.dailyLoss > config.maxDailyLossPercent) return SystemMode.CLOSE_ONLY;

    return SystemMode.NORMAL;
  }
}
```

### 4.4 日志与审计

#### 4.4.1 审计日志表

```sql
-- 每个主循环周期的完整记录
CREATE TABLE audit_cycles (
    cycle_id        VARCHAR(36) PRIMARY KEY,
    started_at      TIMESTAMP NOT NULL,
    finished_at     TIMESTAMP,
    system_mode     VARCHAR(32),
    pools_scanned   INT,
    pools_scored    INT,
    actions_planned INT,
    actions_executed INT,
    actions_failed  INT,
    total_pnl_delta DECIMAL(20,2),
    error_summary   TEXT,
    metadata        JSONB                  -- 完整的输入输出摘要
);

-- 每笔交易指令的审计
CREATE TABLE audit_transactions (
    id              SERIAL PRIMARY KEY,
    cycle_id        VARCHAR(36) REFERENCES audit_cycles(cycle_id),
    position_id     INT,
    skill_id        VARCHAR(64),
    skill_version   VARCHAR(16),
    operation       VARCHAR(32),           -- open/close/rebalance/claim/emergency_exit
    trigger         VARCHAR(32),           -- scheduled/lincoln_decay/dev_sell/stop_loss/manual
    input_params    JSONB,                 -- 完整入参
    tx_signatures   TEXT[],
    gas_cost_sol    DECIMAL(20,9),
    jito_tip_sol    DECIMAL(20,9),
    result_status   VARCHAR(16),           -- success/failed/partial
    error_detail    TEXT,
    executed_at     TIMESTAMP DEFAULT NOW()
);

-- LLM 调用审计
CREATE TABLE audit_llm_calls (
    id              SERIAL PRIMARY KEY,
    cycle_id        VARCHAR(36),
    role            VARCHAR(32),           -- default/classification/fallback
    provider        VARCHAR(32),
    model           VARCHAR(64),
    input_messages  JSONB,
    output_content  TEXT,
    tool_calls      JSONB,
    input_tokens    INT,
    output_tokens   INT,
    latency_ms      INT,
    is_fallback     BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT NOW()
);
```

#### 4.4.2 结构化日志格式

```json
{
  "timestamp": "2026-03-28T10:30:15.123Z",
  "level": "info",
  "module": "execution_layer",
  "action": "open_position",
  "cycle_id": "c-20260328-103000",
  "skill_id": "bread_n_butter",
  "skill_version": "2.1.0",
  "pool": "7xKp...3nVw",
  "token": "$PEPECAT",
  "amount_sol": 0.8,
  "bin_range": { "from": 8420, "to": 8351 },
  "tx_sig": "5Yx2...9mKw",
  "latency_ms": 4200,
  "rpc_provider": "primary",
  "data_provider": "gmgn",
  "system_mode": "normal"
}
```

### 4.5 部署、版本管理与回滚

#### 4.5.1 部署策略

| 变更类型 | 部署方式 | 回滚方式 |
|---------|---------|---------|
| **新 Skill 上线** | 灰度（canary 10% → 30% → 100%） | `POST /skills/{id}/rollback?to_version=x.y.z` |
| **Skill 参数调整** | 热更新（不重启） | 恢复旧参数配置文件 |
| **Agent 代码更新** | 蓝绿部署（新旧两个实例） | 切回旧实例 |
| **紧急修复** | 直接部署 + 全局暂停后恢复 | 回滚代码 + 全局暂停 |

#### 4.5.2 蓝绿部署流程

```
1. 构建新版本 Docker 镜像 (agent:v1.2.0)
2. 启动新实例（blue），但标记为 PAUSED
3. 健康检查通过后，切换流量到 blue
4. 观察 10 分钟
   - 正常：停止旧实例（green）
   - 异常：切回 green，停止 blue
5. 清理旧镜像
```

#### 4.5.3 故障演练

| 场景 | 演练方法 | 预期行为 | 频率 |
|------|---------|---------|------|
| Primary RPC 宕机 | 断开 primary 连接 | 自动切换到 Helius backup | 月度 |
| GMGN 全面不可用 | 模拟 GMGN 返回 5xx | 切换 Provider A/B → 降级到 close_only | 月度 |
| 所有 Provider 不可用 | 断开所有数据源 | 10min 后自动全撤 | 季度 |
| LLM 不可用 | 模拟 Claude API 超时 | 降级到 fallback model；若全失败则跳过 LLM 步骤 | 月度 |
| 交易连续失败 | 模拟 blockhash 过期 | 重试 3 次 → 停止该仓位操作 → 告警 | 月度 |

---

## 5. 安全与合规

### 5.1 交易安全

| 措施 | 说明 |
|------|------|
| **操作限额** | 单笔 ≤ 5 SOL，日累计 ≤ 50 SOL，紧急撤出不受限 |
| **Jito Bundle** | 所有 rebalance/开仓/平仓通过 Jito 提交，防三明治攻击 |
| **滑点保护** | 默认 3% 滑点容忍（meme coin），紧急撤出放宽到 10% |
| **双源价格验证** | Meteora Active Bin + Jupiter API 分歧 > 5% 暂停操作 |

### 5.2 密钥安全

| 措施 | 说明 |
|------|------|
| **运行时注入** | 密钥不写磁盘，通过环境变量/加密文件注入到内存 |
| **AES-256-GCM 加密** | 密钥文件静态加密，密码通过独立渠道提供 |
| **进程隔离** | Agent 以低权限用户运行，无 root 权限 |
| **日志脱敏** | 日志中不出现私钥、助记词，交易签名仅记录前 8 位 |

### 5.3 风控边界

| 边界 | 值 | 说明 |
|------|-----|------|
| 单池最大敞口 | 总资产 2% | Skill 可进一步收窄 |
| 总 LP 敞口 | 总资产 20% | 80% 保持为 SOL/USDC |
| 同 token 最大暴露 | 总资产 5% | 跨池聚合计算 |
| 同 narrative 池数上限 | 5 | 防系统性风险 |
| 单仓位最大存活 | 7 天 | 超期强制评估，大概率撤出 |
| 日最大 rebalance 成本 | 总资产 0.3% | 防频繁 rebalance 侵蚀收益 |
| Dev Sell → 全撤 | 0 容忍 | 最高优先级熔断 |

---

## 6. 成本与资源评估

### 6.1 基础设施成本

| 项目 | 月费 | 说明 |
|------|------|------|
| **Primary RPC** | $50-200 | QuickNode / Triton / Alchemy（取决于 QPS 需求） |
| **Helius RPC（Backup）** | $49 | Developer Plan，仅作为 backup + gRPC stream |
| **Jito Tips** | ~$10-50 | 取决于 rebalance 频率（~0.00001 SOL/tx × 日均 50-200 笔） |
| **Solana Gas** | ~$1-5 | 极低（~0.000005 SOL/tx） |
| **LLM API** | $50-150 | Claude Sonnet ~$3/MTok input + $15/MTok output，每日 ~50K tokens |
| **GMGN API** | $0（当前免费） | 监控其收费政策变化 |
| **Data Provider A/B** | $0-50 | 视具体服务商定价 |
| **服务器** | $20-50 | Railway/Fly.io, 2vCPU 4GB RAM |
| **PostgreSQL** | $25 | Supabase Free-Pro |
| **Redis** | $10 | Upstash Serverless |
| **域名 + TLS** | $5 | Dashboard 用 |
| **合计** | **~$220-590/月** | |

### 6.2 与 v0.2 成本对比

| 项目 | v0.2 (LP Agent) | v0.3 (自建) | 差异 |
|------|-----------------|-------------|------|
| LP Agent API 订阅 | $20-40 | $0 | -$40 |
| LP Agent 手续费分成 (8%) | $50-200 | $0 | -$200（最大差异） |
| Primary RPC | $49 (仅 fallback) | $50-200 (需全功能) | +$150 |
| Jito Tips | $0 (LP Agent 包含) | $10-50 | +$50 |
| **月总计** | $300-600 | **$220-590** | -$10~-$110 |

**关键差异**：自建执行层省掉了 8% 手续费分成（这是最大的成本项），但需要承担 primary RPC 和 Jito 的直接费用。在管理资产较大（$5K+）时，自建方案的成本优势更明显。

### 6.3 成本优化方向

| 方向 | 措施 | 预期节省 |
|------|------|---------|
| **RPC 调用缓存** | 池子数据 5s 缓存、position 状态 10s 缓存，减少重复调用 | RPC 成本 -30% |
| **批量请求** | 合并多个 getMultipleAccounts 调用 | RPC 成本 -20% |
| **LLM 调用节约** | 简单分类用 Haiku/GPT-4o-mini；仅在需要时调用 Sonnet | LLM 成本 -50% |
| **交易合并** | 多仓位手续费提取合并为一笔交易 | Gas + Jito tip -40% |
| **gRPC 替代轮询** | 用 Helius LaserStream 替代高频轮询 | RPC 成本 -60% |

---

## 7. 风险分析与后续迭代方向

### 7.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| **Meteora SDK/API 不兼容升级** | 中 | 高 | 锁定 SDK 版本 + 监控 GitHub releases + 抽象执行层接口便于适配 |
| **Solana 网络严重拥塞** | 高 | 中 | 多 RPC + Jito Bundle + 指数退避 + 降级到 close_only 模式 |
| **GMGN API 停服/收费** | 中 | 中 | 多数据源抽象 + 本地缓存 + Provider A/B 备份 |
| **Meme coin 市场整体冷却** | 中 | 高 | 总 LP 敞口限制 20% + 持续监控 Lincoln Score 趋势 |
| **LLM 幻觉误导决策** | 中 | 中 | LLM 仅做建议，规则引擎把关 + 全量审计日志 |
| **洗量（Wash Trading）欺骗评分** | 高 | 中 | organic_score 过滤 + 多维交叉验证 |
| **密钥泄露** | 低 | 极高 | 运行时注入 + AES 加密 + 操作限额 + 进程隔离 |
| **新 Skill 策略亏损** | 中 | 中 | canary 灰度（10% 资金）+ 自动回滚 |
| **Jito Bundle 拒绝/延迟** | 中 | 低 | 回退到直接 sendTransaction + priority fee 递增 |

### 7.2 后续迭代方向

| 阶段 | 内容 | 条件 |
|------|------|------|
| **v0.4** | 接入 PumpSwap 池子（Pump.fun 原生 AMM） | PumpSwap 交易量达到可观水平 |
| **v0.5** | Copy LP 功能（追踪 Top LP 钱包） | 需要稳定的钱包追踪数据源 |
| **v0.6** | 多钱包并行管理 | 资金规模增长后，分散风险 |
| **v0.7** | 策略回测系统（基于历史 bin 数据重放） | 需要积累足够的历史数据 |
| **v0.8** | SaaS 化（多租户隔离） | 验证策略稳定盈利后 |

### 7.3 实施计划

| Phase | 周期 | 核心交付 | 里程碑 |
|-------|------|---------|--------|
| **P1: 核心引擎** | Week 1-3 | Meteora SDK 执行层 + 池子发现评分 + 单 Skill (Bread'n'Butter) + 基础风控 | 单池全自动 LP，$100 实盘验证 |
| **P2: 多池 + 风控** | Week 4-5 | 多池管理 + 完整风控 + GMGN 信号集成 + 多数据源降级 + Telegram 告警 | 15-30 池同时管理，$500 实盘验证 |
| **P3: Agent + Skill** | Week 6-8 | 自研 Agent 框架 + LLM 接口层 + Skill 管理 + 灰度发布 | LLM 驱动策略选择，$2,000 实盘验证 |
| **P4: Dashboard + 稳定性** | Week 9-10 | Web Dashboard + 全链路监控 + 审计系统 + 故障演练 | 完整产品交付，$5,000+ 正式运行 |

---

## 附录 A: 核心数据模型

```sql
-- 池子信息
CREATE TABLE pools (
    address           VARCHAR(44) PRIMARY KEY,
    token_mint        VARCHAR(44) NOT NULL,
    quote_mint        VARCHAR(44) DEFAULT 'So11111111111111111111111111111111', -- SOL
    bin_step          INT NOT NULL,
    fee_rate_pct      DECIMAL(5,2),
    lincoln_score     DECIMAL(8,4),
    safety_score      INT,
    organic_score     INT,
    grade             CHAR(1),
    lifecycle_stage   VARCHAR(16),
    tvl               DECIMAL(20,2),
    vol_24h           DECIMAL(20,2),
    fee_tvl_ratio_24h DECIMAL(10,4),
    mcap              DECIMAL(20,2),
    smart_money_net   DECIMAL(20,2),
    data_source       VARCHAR(32),          -- 数据来自哪个 provider
    is_blacklisted    BOOLEAN DEFAULT FALSE,
    blacklist_reason  TEXT,
    last_scored_at    TIMESTAMP,
    created_at        TIMESTAMP DEFAULT NOW()
);

-- 活跃仓位
CREATE TABLE positions (
    id                SERIAL PRIMARY KEY,
    pool_address      VARCHAR(44) REFERENCES pools(address),
    position_pubkey   VARCHAR(44) UNIQUE,
    wallet_address    VARCHAR(44) NOT NULL,  -- 支持地址轮换
    skill_id          VARCHAR(64),
    skill_version     VARCHAR(16),
    direction         VARCHAR(8),
    from_bin_id       INT,
    to_bin_id         INT,
    deposited_sol     DECIMAL(20,9),
    current_value_usd DECIMAL(20,2),
    pnl_percent       DECIMAL(10,4),
    is_in_range       BOOLEAN DEFAULT TRUE,
    total_fees_claimed_sol DECIMAL(20,9) DEFAULT 0,
    rebalance_count   INT DEFAULT 0,
    status            VARCHAR(16) DEFAULT 'active',
    entry_lincoln_score DECIMAL(8,4),
    opened_at         TIMESTAMP DEFAULT NOW(),
    max_alive_until   TIMESTAMP,
    closed_at         TIMESTAMP
);

-- 操作历史 (同时用于审计)
CREATE TABLE operations (
    id                SERIAL PRIMARY KEY,
    cycle_id          VARCHAR(36),
    position_id       INT REFERENCES positions(id),
    skill_id          VARCHAR(64),
    skill_version     VARCHAR(16),
    operation_type    VARCHAR(32),
    trigger_type      VARCHAR(32),
    amount_sol        DECIMAL(20,9),
    tx_signatures     TEXT[],
    gas_cost_sol      DECIMAL(20,9),
    jito_tip_sol      DECIMAL(20,9),
    rpc_provider      VARCHAR(32),
    data_provider     VARCHAR(32),
    system_mode       VARCHAR(32),
    result_status     VARCHAR(16),
    error_detail      TEXT,
    executed_at       TIMESTAMP DEFAULT NOW()
);

-- 数据源信号日志
CREATE TABLE data_signals (
    id                SERIAL PRIMARY KEY,
    provider          VARCHAR(32),
    signal_type       VARCHAR(32),
    token_mint        VARCHAR(44),
    signal_data       JSONB,
    action_taken      VARCHAR(32),
    created_at        TIMESTAMP DEFAULT NOW()
);
```

## 附录 B: 配置文件总览

```yaml
# config/agent.yaml — 主配置文件

system:
  mode: "normal"                    # normal | close_only | paused
  main_loop_interval_ms: 1800000    # 30min
  high_freq_interval_ms: 5000       # 5s
  max_concurrent_positions: 40

wallet:
  active_address: "9xBv...4mZw"
  mode: "injected"                  # injected | phantom_delegate
  limits:
    per_transaction_max_sol: 5.0
    daily_cumulative_max_sol: 50.0

rpc:
  primary:
    url_env: "PRIMARY_RPC_URL"
    timeout_ms: 10000
  backup:
    url_env: "HELIUS_RPC_URL"       # Helius as backup
    timeout_ms: 10000
  grpc:
    url_env: "GRPC_URL"             # Helius LaserStream / Yellowstone
  jito:
    endpoint: "https://mainnet.block-engine.jito.wtf/api/v1/bundles"
    tip_lamports: 10000
    max_retries: 3

data_providers:
  gmgn:
    priority: 1
    base_url: "https://gmgn.ai"
    api_key_env: "GMGN_API_KEY"
    circuit_breaker:
      failure_threshold: 5
      recovery_time_ms: 60000
  provider_a:                       # e.g., Birdeye / DexScreener
    priority: 2
    base_url_env: "PROVIDER_A_URL"
    api_key_env: "PROVIDER_A_KEY"
    circuit_breaker:
      failure_threshold: 5
      recovery_time_ms: 60000
  provider_b:                       # e.g., 链上直读 + Jupiter
    priority: 3
    circuit_breaker:
      failure_threshold: 10
      recovery_time_ms: 120000
  cache:
    stale_tolerance_ms: 300000      # 5min 过期容忍
    full_degradation_ms: 600000     # 10min 无数据 → close_only
    auto_exit_ms: 1800000           # 30min 无数据 → 全撤

llm:
  default:
    provider: "anthropic"
    model: "claude-sonnet-4-20250514"
    api_key_env: "ANTHROPIC_API_KEY"
  classification:
    provider: "anthropic"
    model: "claude-haiku"
  fallback:
    provider: "openai"
    model: "gpt-4o-mini"
    api_key_env: "OPENAI_API_KEY"

risk:
  max_position_pct: 2.0             # 单仓位 ≤ 总资产 2%
  max_total_lp_pct: 20.0            # 总 LP ≤ 20%
  max_token_exposure_pct: 5.0
  max_narrative_pools: 5
  stop_loss_pct: 30.0
  max_alive_hours: 168              # 7 days
  daily_max_loss_pct: 5.0
  fee_claim_interval_hours: 8
  lincoln_exit_threshold: 1.0       # Lincoln < 1% → 退出

notifications:
  telegram:
    bot_token_env: "TG_BOT_TOKEN"
    chat_id_env: "TG_CHAT_ID"
    levels: ["critical", "high", "medium"]
  discord:
    webhook_env: "DISCORD_WEBHOOK"
    levels: ["critical", "high", "low"]
```
