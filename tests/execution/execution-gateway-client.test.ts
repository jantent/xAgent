import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionGatewayClient } from "../../src/execution/clients/execution-gateway-client.js";
import { createOpenAction } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

const originalFetch = globalThis.fetch;

function mockFetch(handler: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler
  });
}

test.afterEach(() => {
  mockFetch(originalFetch);
});

test("ExecutionGatewayClient 会把 gateway payload 规范化为 ActionExecutionResult", async () => {
  mockFetch(async () => new Response(JSON.stringify({
    status: "success",
    message: "position opened",
    txSignatures: ["5Qx"],
    stateOperations: [
      {
        kind: "adjust_capital",
        deltaSol: -1.2
      },
      {
        kind: "upsert_position",
        position: {
          id: "position-123",
          positionPubkey: "9abc",
          poolAddress: "DLMM",
          tokenMint: "Mint",
          tokenSymbol: "BONK",
          walletAddress: "Wallet",
          skillId: "bread_n_butter",
          skillVersion: "1.0.0",
          direction: "both",
          fromBinId: -20,
          toBinId: 20,
          depositedSol: 1.2,
          currentValueUsd: 180,
          pnlPercent: 0,
          isInRange: true,
          totalFeesClaimedSol: 0,
          rebalanceCount: 0,
          status: "active",
          entryLincolnScore: 8.8,
          openedAt: "2026-03-28T08:00:00.000Z",
          maxAliveUntil: "2026-04-04T08:00:00.000Z"
        }
      }
    ]
  }), { status: 200 }));

  const client = new ExecutionGatewayClient(createTestLogger());
  const result = await client.execute({
    action: createOpenAction(),
    baseUrl: "https://gateway.example.com",
    timeoutMs: 1_000,
    payload: {}
  });

  assert.equal(result.status, "success");
  assert.equal(result.stateOperations?.length, 2);
  assert.ok(result.stateOperations?.[1]?.kind === "upsert_position");
  if (result.stateOperations?.[1]?.kind === "upsert_position") {
    assert.ok(result.stateOperations[1].position.openedAt instanceof Date);
    assert.ok(result.stateOperations[1].position.maxAliveUntil instanceof Date);
  }
});

test("ExecutionGatewayClient 遇到未知状态操作时会报错", async () => {
  mockFetch(async () => new Response(JSON.stringify({
    status: "success",
    message: "position opened",
    stateOperations: [
      {
        kind: "mystery_operation"
      }
    ]
  }), { status: 200 }));

  const client = new ExecutionGatewayClient(createTestLogger());

  await assert.rejects(
    client.execute({
      action: createOpenAction(),
      baseUrl: "https://gateway.example.com",
      timeoutMs: 1_000,
      payload: {}
    }),
    /未知状态操作/
  );
});

test("ExecutionGatewayClient.listPositions 会规范化 active positions 响应", async () => {
  mockFetch(async () => new Response(JSON.stringify({
    positions: [
      {
        id: "position-123",
        positionPubkey: "9abc",
        poolAddress: "DLMM",
        tokenMint: "Mint",
        tokenSymbol: "BONK",
        walletAddress: "Wallet",
        skillId: "bread_n_butter",
        skillVersion: "1.0.0",
        direction: "both",
        fromBinId: -20,
        toBinId: 20,
        depositedSol: 1.2,
        currentValueUsd: 180,
        pnlPercent: 0,
        isInRange: true,
        totalFeesClaimedSol: 0,
        rebalanceCount: 0,
        status: "active",
        entryLincolnScore: 8.8,
        openedAt: "2026-03-28T08:00:00.000Z",
        maxAliveUntil: "2026-04-04T08:00:00.000Z"
      }
    ]
  }), { status: 200 }));

  const client = new ExecutionGatewayClient(createTestLogger());
  const positions = await client.listPositions({
    baseUrl: "https://gateway.example.com",
    positionsPath: "/v1/positions",
    timeoutMs: 1_000,
    walletAddress: "Wallet",
    activeOnly: true
  });

  assert.equal(positions.length, 1);
  assert.ok(positions[0]?.openedAt instanceof Date);
  assert.equal(positions[0]?.status, "active");
});
