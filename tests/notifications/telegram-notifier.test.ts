import assert from "node:assert/strict";
import test from "node:test";

import { TelegramNotifier } from "../../src/notifications/telegram-notifier.js";
import { SystemMode } from "../../src/domain/models.js";
import { rootLogger } from "../../src/utils/logger.js";

test("TelegramNotifier 会向多个 chat_id 扇出通知", async () => {
  const previousFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }) as typeof fetch;

  try {
    const notifier = new TelegramNotifier(
      "telegram-token",
      ["chat-1", "chat-2"],
      {
        levels: ["low", "medium", "high", "critical"]
      },
      rootLogger.child("telegram_notifier.test")
    );
    await notifier.sendCycleSummary({
      cycleId: "cycle-1",
      mode: SystemMode.NORMAL,
      scanned: 1,
      plans: 1,
      approved: 1,
      executed: 1,
      failed: 0,
      actions: [],
      results: [],
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:01.000Z")
    });

    assert.deepEqual(
      bodies.map((body) => body.chat_id),
      ["chat-1", "chat-2"]
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
