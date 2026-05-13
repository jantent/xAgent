import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAgentConfig, loadSkills } from "../../src/config/loader.js";
import { createAgentConfig } from "../helpers/factories.js";

test("loadAgentConfig 会在关键字段类型错误时 fail fast", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-config-"));
  try {
    const configPath = path.join(tmpDir, "agent.yaml");
    const config = createAgentConfig() as unknown as Record<string, unknown>;
    (config.system as Record<string, unknown>).main_loop_interval_ms = "bad";
    await writeFile(configPath, JSON.stringify(config));

    await assert.rejects(loadAgentConfig(configPath), /main_loop_interval_ms/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadSkills 会在 skill 缺少关键对象时 fail fast", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-skills-"));
  try {
    await writeFile(
      path.join(tmpDir, "broken.yaml"),
      ["id: broken", "version: 1.0.0", "name: Broken Skill", "riskLimits: {}", "applicability: {}"].join("\n")
    );

    await assert.rejects(loadSkills(tmpDir), /params/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadAgentConfig 会解析 production guardrails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-config-"));
  try {
    const configPath = path.join(tmpDir, "agent.yaml");
    const config = createAgentConfig();
    config.guardrails = {
      allow_mock_data: false,
      allow_mock_llm: false,
      require_live_preflight: true,
      active_position_reconcile: "close_missing"
    };
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadAgentConfig(configPath);
    assert.deepEqual(loaded.guardrails, {
      ...config.guardrails,
      persist_failure_strategy: undefined
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadAgentConfig 会解析 paper_trading 并补齐默认值", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-config-"));
  try {
    const configPath = path.join(tmpDir, "agent.yaml");
    const config = createAgentConfig();
    config.paper_trading = {
      enabled: true,
      fee_capture_rate: 0.25
    };
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadAgentConfig(configPath);
    assert.equal(loaded.paper_trading?.enabled, true);
    assert.equal(loaded.paper_trading?.fee_capture_rate, 0.25);
    assert.equal(loaded.paper_trading?.valuation_interval_ms, 300_000);
    assert.equal(loaded.paper_trading?.max_fee_tvl_ratio_24h, 250);
    assert.equal(loaded.paper_trading?.snapshot_retention, 5_000);
    assert.equal(loaded.skill_optimizer?.enabled, true);
    assert.equal(loaded.skill_optimizer?.min_closed_positions, 5);
    assert.equal(loaded.skill_optimizer?.min_snapshots, 20);
    assert.equal(loaded.skill_optimizer?.max_patch_pct, 20);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadAgentConfig 会解析 gmgn_cli data provider 配置", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-config-"));
  try {
    const configPath = path.join(tmpDir, "agent.yaml");
    const config = createAgentConfig();
    config.data_providers.gmgn = {
      kind: "gmgn_cli",
      priority: 1,
      command: "gmgn-cli",
      chain: "sol",
      api_key_env: "GMGN_API_KEY",
      timeout_ms: 10_000,
      circuit_breaker: {
        failure_threshold: 5,
        recovery_time_ms: 60_000
      }
    };
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadAgentConfig(configPath);
    assert.equal(loaded.data_providers.gmgn?.kind, "gmgn_cli");
    assert.equal(loaded.data_providers.gmgn?.command, "gmgn-cli");
    assert.equal(loaded.data_providers.gmgn?.chain, "sol");
    assert.equal(loaded.data_providers.gmgn?.api_key_env, "GMGN_API_KEY");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
