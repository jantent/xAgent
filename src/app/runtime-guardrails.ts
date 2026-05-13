import type { AgentConfig, RuntimeGuardrailsConfig } from "../config/types.js";
import { loadKeypairFromSecret } from "../execution/solana/signer-utils.js";
import type { PositionRecord } from "../domain/models.js";
import type { LoadedWalletSecret } from "../wallet/wallet-secret-manager.js";

export interface RuntimeGuardrailContext {
  walletSecret: LoadedWalletSecret | null;
  rpcManager: {
    healthCheck(): Promise<void>;
    getHealth(): {
      canWrite: boolean;
      statuses: Array<{
        provider: string;
        lastError?: string;
      }>;
    };
  };
  activePositions?: PositionRecord[];
  checkDataProviders?: () => Promise<{
    hasAnyProvider: boolean;
    hasPrimaryProvider: boolean;
    providerErrors?: string[];
  }>;
  checkPoolSource?: () => Promise<{
    provider: string;
    ok: boolean;
    error?: string;
  }>;
  checkExecutionDependencies?: () => Promise<void>;
  checkPositionAccountExists?: (positionPubkey: string) => Promise<boolean>;
  storage: {
    stateStoreKind: string;
  };
}

const DEFAULT_GUARDRAILS: Required<RuntimeGuardrailsConfig> = {
  allow_mock_data: true,
  allow_mock_llm: true,
  require_live_preflight: false,
  active_position_reconcile: "fail",
  persist_failure_strategy: "close_only_then_pause"
};

export function resolveRuntimeGuardrails(config: AgentConfig): Required<RuntimeGuardrailsConfig> {
  return {
    allow_mock_data: config.guardrails?.allow_mock_data ?? DEFAULT_GUARDRAILS.allow_mock_data,
    allow_mock_llm: config.guardrails?.allow_mock_llm ?? DEFAULT_GUARDRAILS.allow_mock_llm,
    require_live_preflight: config.guardrails?.require_live_preflight ?? DEFAULT_GUARDRAILS.require_live_preflight,
    active_position_reconcile:
      config.guardrails?.active_position_reconcile ?? DEFAULT_GUARDRAILS.active_position_reconcile,
    persist_failure_strategy:
      config.guardrails?.persist_failure_strategy ?? DEFAULT_GUARDRAILS.persist_failure_strategy
  };
}

export function deriveSignerAddress(walletSecret: LoadedWalletSecret): string {
  return loadKeypairFromSecret(walletSecret.secret).publicKey.toBase58();
}

function summarizeRpcErrors(
  statuses: Array<{
    provider: string;
    lastError?: string;
  }>
): string {
  const errors = statuses
    .filter((status) => status.lastError)
    .map((status) => `${status.provider}: ${status.lastError}`);

  return errors.length > 0 ? errors.join("; ") : "无可写 RPC，但未返回额外错误";
}

export function validateActivePositionLocalInvariants(
  signerAddress: string,
  positions: PositionRecord[]
): void {
  const seenIds = new Set<string>();
  const seenPositionPubkeys = new Set<string>();

  for (const position of positions) {
    if (position.status !== "active") {
      throw new Error(`live preflight 失败：启动时活跃仓位列表包含非 active 状态记录 ${position.id}`);
    }

    if (position.walletAddress !== signerAddress) {
      throw new Error(
        `live preflight 失败：仓位 ${position.id} 的 walletAddress=${position.walletAddress} 与 signer=${signerAddress} 不一致`
      );
    }

    if (seenIds.has(position.id)) {
      throw new Error(`live preflight 失败：检测到重复仓位 id ${position.id}`);
    }
    seenIds.add(position.id);

    if (seenPositionPubkeys.has(position.positionPubkey)) {
      throw new Error(`live preflight 失败：检测到重复仓位 positionPubkey ${position.positionPubkey}`);
    }
    seenPositionPubkeys.add(position.positionPubkey);
  }
}

export function validateMirroredActivePositions(
  sourceName: string,
  signerAddress: string,
  localPositions: PositionRecord[],
  mirroredPositions: PositionRecord[]
): void {
  validateActivePositionLocalInvariants(signerAddress, localPositions);
  validateActivePositionLocalInvariants(signerAddress, mirroredPositions);

  const mirroredById = new Map(mirroredPositions.map((position) => [position.id, position]));
  const mirroredPubkeys = new Set(mirroredPositions.map((position) => position.positionPubkey));

  if (localPositions.length !== mirroredPositions.length) {
    throw new Error(
      `live preflight 失败：${sourceName} 活跃仓位数=${mirroredPositions.length} 与本地活跃仓位数=${localPositions.length} 不一致`
    );
  }

  for (const localPosition of localPositions) {
    const mirrored = mirroredById.get(localPosition.id);
    if (!mirrored) {
      throw new Error(`live preflight 失败：${sourceName} 未返回本地活跃仓位 ${localPosition.id}`);
    }

    if (mirrored.positionPubkey !== localPosition.positionPubkey) {
      throw new Error(
        `live preflight 失败：${sourceName} 仓位 ${localPosition.id} 的 positionPubkey=${mirrored.positionPubkey} 与本地=${localPosition.positionPubkey} 不一致`
      );
    }

    if (!mirroredPubkeys.has(localPosition.positionPubkey)) {
      throw new Error(
        `live preflight 失败：${sourceName} 未返回本地活跃仓位 ${localPosition.id} 的 positionPubkey ${localPosition.positionPubkey}`
      );
    }
  }

  const localIds = new Set(localPositions.map((position) => position.id));
  for (const mirrored of mirroredPositions) {
    if (!localIds.has(mirrored.id)) {
      throw new Error(`live preflight 失败：${sourceName} 返回了本地不存在的活跃仓位 ${mirrored.id}`);
    }
  }
}

async function validateActivePositions(
  config: AgentConfig,
  signerAddress: string,
  positions: PositionRecord[],
  checkPositionAccountExists?: (positionPubkey: string) => Promise<boolean>
): Promise<void> {
  validateActivePositionLocalInvariants(signerAddress, positions);

  for (const position of positions) {
    if (config.execution?.mode === "live_sdk") {
      if (!checkPositionAccountExists) {
        throw new Error("live preflight 失败：未提供链上仓位账户校验器");
      }

      const exists = await checkPositionAccountExists(position.positionPubkey);
      if (!exists) {
        throw new Error(
          `live preflight 失败：本地活跃仓位 ${position.id} 对应的链上账户 ${position.positionPubkey} 不存在`
        );
      }
    }
  }
}

export async function enforceRuntimeGuardrails(
  config: AgentConfig,
  context: RuntimeGuardrailContext
): Promise<void> {
  const guardrails = resolveRuntimeGuardrails(config);

  if ((config.execution?.mode ?? "dry_run") === "dry_run" || !guardrails.require_live_preflight) {
    return;
  }

  const liveConfig = config.execution?.live;
  if (!liveConfig) {
    throw new Error(`guardrails.require_live_preflight=true，但 execution.mode=${config.execution?.mode} 缺少 live 配置`);
  }

  if (!context.walletSecret) {
    throw new Error("live preflight 失败：钱包 secret 未加载");
  }

  let signerAddress: string;
  try {
    signerAddress = deriveSignerAddress(context.walletSecret);
  } catch (error) {
    throw new Error(
      `live preflight 失败：钱包 secret 无法解析为有效 signer: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (signerAddress !== config.wallet.active_address) {
    throw new Error(
      `live preflight 失败：wallet.active_address=${config.wallet.active_address} 与 signer=${signerAddress} 不一致`
    );
  }

  await context.rpcManager.healthCheck();
  const rpcHealth = context.rpcManager.getHealth();
  if (!rpcHealth.canWrite) {
    throw new Error(`live preflight 失败：当前无可写 RPC。${summarizeRpcErrors(rpcHealth.statuses)}`);
  }

  if (context.checkDataProviders) {
    const dataHealth = await context.checkDataProviders();
    if (!dataHealth.hasAnyProvider) {
      throw new Error(
        `live preflight 失败：所有数据源都不可用。${(dataHealth.providerErrors ?? []).join("; ") || "无额外错误"}`
      );
    }

    if (!dataHealth.hasPrimaryProvider) {
      throw new Error(
        `live preflight 失败：主数据源不可用。${(dataHealth.providerErrors ?? []).join("; ") || "无额外错误"}`
      );
    }
  }

  if (context.checkPoolSource) {
    const poolSourceHealth = await context.checkPoolSource();
    if (!poolSourceHealth.ok) {
      throw new Error(
        `live preflight 失败：池子发现源 ${poolSourceHealth.provider} 不可用: ${poolSourceHealth.error ?? "unknown error"}`
      );
    }
  }

  if (config.execution?.mode === "live_sdk") {
    if (!liveConfig.jupiter) {
      throw new Error("live preflight 失败：execution.mode=live_sdk 但缺少 execution.live.jupiter 配置");
    }

    if (!liveConfig.meteora) {
      throw new Error("live preflight 失败：execution.mode=live_sdk 但缺少 execution.live.meteora 配置");
    }
  }

  if (config.execution?.mode === "live_gateway") {
    const gatewayBaseUrl = process.env[liveConfig.gateway.base_url_env]?.trim();
    if (!gatewayBaseUrl) {
      throw new Error(
        `live preflight 失败：execution.mode=live_gateway 但未配置环境变量 ${liveConfig.gateway.base_url_env}`
      );
    }
  }

  if (context.checkExecutionDependencies) {
    await context.checkExecutionDependencies();
  }

  await validateActivePositions(
    config,
    signerAddress,
    context.activePositions ?? [],
    context.checkPositionAccountExists
  );
}
