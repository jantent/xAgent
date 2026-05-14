import { timingSafeEqual } from "node:crypto";

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";

import type { AppRuntime } from "../app/runtime.js";
import { DASHBOARD_CONTENT_TYPE, DASHBOARD_SCRIPT, DASHBOARD_STYLES, renderDashboardPage } from "../dashboard/page.js";
import { ControlService } from "../services/control-service.js";
import { rootLogger } from "../utils/logger.js";
import type { ActionType, PositionRecord, PositionStatus } from "../domain/models.js";

interface ApiServerOptions {
  host: string;
  port: number;
}

function resolveApiBearerToken(runtime: AppRuntime): string | undefined {
  const envKey = runtime.config.api?.auth?.bearer_token_env;
  if (!envKey) {
    return undefined;
  }

  const value = process.env[envKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unauthorizedResponse(context: Context) {
  return context.json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": 'Bearer realm="xagent-control-plane"'
  });
}

function isExpectedToken(providedToken: string, expectedToken: string): boolean {
  const provided = Buffer.from(providedToken.trim());
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function hasValidBearerToken(request: Request, expectedToken: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return false;
  }

  return isExpectedToken(header.slice("Bearer ".length), expectedToken);
}

function hasValidQueryToken(request: Request, expectedToken: string): boolean {
  const token = new URL(request.url).searchParams.get("token");
  return typeof token === "string" && token.length > 0 ? isExpectedToken(token, expectedToken) : false;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function tryReadJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const AUDIT_SOURCES = new Set(["actions", "errors", "phases", "cycles", "llm"]);
const POSITION_STATUSES = new Set<PositionStatus>(["active", "closed", "closing", "error"]);
const POSITION_SORT_KEYS = new Set(["openedAt", "closedAt", "pnlPercent", "currentValueUsd", "depositedSol", "fees"]);
const TRADE_ACTION_TYPES = new Set(["open", "close", "rebalance", "claim", "noop", "emergency_exit"]);
const TRADE_STATUSES = new Set(["success", "failed", "skipped"]);

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) {
    return Math.max(0, Math.trunc(fallback));
  }

  return Math.min(Math.trunc(requested), Math.max(0, Math.trunc(max)));
}

function parseOffset(value: string | undefined): number {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 0;
}

function normalizeQueryText(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeIsoQuery(value: string | undefined): string | undefined {
  const normalized = normalizeQueryText(value);
  if (!normalized) {
    return undefined;
  }

  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function parseReportDays(value: string | undefined): number {
  const requested = Number(value);
  return requested === 30 || requested === 90 ? requested : 7;
}

function parseTimezoneOffsetMinutes(value: string | undefined): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) {
    return 0;
  }

  return Math.max(-840, Math.min(840, Math.trunc(requested)));
}

function buildPage(limit: number, offset: number, resultCount: number) {
  const hasMore = resultCount > limit;
  return {
    limit,
    offset,
    nextOffset: hasMore ? offset + limit : null,
    hasMore
  };
}

function countPositions(positions: PositionRecord[]) {
  const counts = {
    total: positions.length,
    active: 0,
    closed: 0,
    closing: 0,
    error: 0
  };

  for (const position of positions) {
    if (position.status === "active") {
      counts.active += 1;
    } else if (position.status === "closed") {
      counts.closed += 1;
    } else if (position.status === "closing") {
      counts.closing += 1;
    } else if (position.status === "error") {
      counts.error += 1;
    }
  }

  return counts;
}

function positionSortValue(position: PositionRecord, sortKey: string): number {
  if (sortKey === "closedAt") {
    return position.closedAt?.getTime() ?? 0;
  }
  if (sortKey === "pnlPercent") {
    return position.pnlPercent;
  }
  if (sortKey === "currentValueUsd") {
    return position.currentValueUsd;
  }
  if (sortKey === "depositedSol") {
    return position.depositedSol;
  }
  if (sortKey === "fees") {
    return position.totalFeesClaimedSol;
  }

  return position.openedAt.getTime();
}

function queryPositions(positions: PositionRecord[], request: Request) {
  const url = new URL(request.url);
  const statusParam = normalizeQueryText(url.searchParams.get("status") ?? undefined);
  const status =
    statusParam && POSITION_STATUSES.has(statusParam as PositionStatus)
      ? (statusParam as PositionStatus)
      : url.searchParams.get("active") === "true"
        ? "active"
        : undefined;
  const skillId = normalizeQueryText(url.searchParams.get("skillId") ?? undefined);
  const token = normalizeQueryText(url.searchParams.get("token") ?? undefined)?.toLowerCase();
  const search = normalizeQueryText(url.searchParams.get("q") ?? undefined)?.toLowerCase();
  const sort = normalizeQueryText(url.searchParams.get("sort") ?? undefined);
  const sortKey = sort && POSITION_SORT_KEYS.has(sort) ? sort : undefined;
  const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
  const offset = parseOffset(url.searchParams.get("offset") ?? undefined);
  const explicitLimit = normalizeQueryText(url.searchParams.get("limit") ?? undefined);
  const limit = explicitLimit ? parseLimit(explicitLimit, positions.length, 500) : positions.length;
  const counts = countPositions(positions);

  let filtered = positions;
  if (status) {
    filtered = filtered.filter((position) => position.status === status);
  }
  if (skillId) {
    filtered = filtered.filter((position) => position.skillId === skillId);
  }
  if (token) {
    filtered = filtered.filter((position) => {
      return (
        position.tokenSymbol.toLowerCase().includes(token) ||
        position.tokenMint.toLowerCase().includes(token) ||
        position.poolAddress.toLowerCase().includes(token)
      );
    });
  }
  if (search) {
    filtered = filtered.filter((position) => {
      const haystack = [
        position.id,
        position.positionPubkey,
        position.poolAddress,
        position.tokenMint,
        position.tokenSymbol,
        position.skillId,
        position.skillVersion,
        position.status,
        position.narrative ?? ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }
  if (sortKey) {
    filtered = [...filtered].sort((left, right) => {
      const leftValue = positionSortValue(left, sortKey);
      const rightValue = positionSortValue(right, sortKey);
      return order === "asc" ? leftValue - rightValue : rightValue - leftValue;
    });
  }

  const paged = filtered.slice(offset, offset + limit + 1);
  return {
    positions: paged.slice(0, limit),
    page: {
      ...buildPage(limit, offset, paged.length),
      total: filtered.length
    },
    counts
  };
}

/**
 * API Server 聚焦三个方向：
 * 1. 暴露 RFC 定义的控制面能力；
 * 2. 提供最小但够用的观测入口，方便接 Dashboard、脚本和监控系统；
 * 3. 在需要时对控制面增加最小认证边界。
 */
export function createApiApp(runtime: AppRuntime, options: ApiServerOptions): Hono {
  const controlService = new ControlService(runtime);
  const app = new Hono();
  const bearerToken = resolveApiBearerToken(runtime);

  if (!bearerToken && !isLoopbackHost(options.host)) {
    throw new Error(`API 监听地址 ${options.host} 不是 loopback，但未配置 Bearer Token`);
  }

  const requireApiAuth = (context: Context, options: { allowQueryToken?: boolean } = {}) => {
    if (!bearerToken) {
      return null;
    }

    if (hasValidBearerToken(context.req.raw, bearerToken) || (options.allowQueryToken && hasValidQueryToken(context.req.raw, bearerToken))) {
      return null;
    }

    return unauthorizedResponse(context);
  };

  app.get("/", async (context) => {
    return context.redirect("/dashboard");
  });

  app.get("/dashboard", async (context) => {
    return context.html(renderDashboardPage(), 200, {
      "Content-Type": DASHBOARD_CONTENT_TYPE.html
    });
  });

  app.get("/dashboard/styles.css", async (context) => {
    return context.text(DASHBOARD_STYLES, 200, {
      "Content-Type": DASHBOARD_CONTENT_TYPE.css
    });
  });

  app.get("/dashboard/app.js", async (context) => {
    return context.text(DASHBOARD_SCRIPT, 200, {
      "Content-Type": DASHBOARD_CONTENT_TYPE.js
    });
  });

  app.get("/health", async (context) => {
    const status = controlService.getStatus();
    const ok = runtime.executionLayer.getStatus().healthy && runtime.rpcManager.getHealth().canWrite && !runtime.state.getLastPersistError();
    return context.json({
      ok,
      status
    }, ok ? 200 : 503);
  });

  app.get("/status", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(controlService.getStatus());
  });

  app.get("/events/status", async (context) => {
    const unauthorized = requireApiAuth(context, { allowQueryToken: true });
    if (unauthorized) {
      return unauthorized;
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let statusTimer: ReturnType<typeof setInterval> | undefined;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

        const send = (event: string, payload: Record<string, unknown>) => {
          if (closed) {
            return;
          }

          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };

        const close = () => {
          if (closed) {
            return;
          }

          closed = true;
          if (statusTimer) {
            clearInterval(statusTimer);
          }
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          controller.close();
        };

        send("status", {
          status: controlService.getStatus()
        });

        statusTimer = setInterval(() => {
          send("status", {
            status: controlService.getStatus()
          });
        }, 5_000);

        heartbeatTimer = setInterval(() => {
          send("ping", {
            ok: true
          });
        }, 15_000);

        context.req.raw.signal.addEventListener("abort", close, { once: true });
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      }
    });
  });

  app.get("/skills", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const skills = runtime.skillStatsService.enrichSkills(runtime.skillManager.listAll());
    return context.json({
      skills,
      stats: runtime.skillStatsService.listStats()
    });
  });

  app.get("/skills/stats", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json({
      stats: runtime.skillStatsService.listStats()
    });
  });

  app.get("/skills/optimizer/recommendations", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(controlService.getSkillOptimizationRecommendations());
  });

  app.post("/skills/optimizer/evaluate", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(controlService.evaluateSkillOptimizationRecommendations());
  });

  app.get("/positions", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(queryPositions(runtime.state.getAllPositions(), context.req.raw));
  });

  app.get("/trades", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const actionType = normalizeQueryText(context.req.query("actionType"));
    if (actionType && !TRADE_ACTION_TYPES.has(actionType)) {
      return context.json({ error: "unsupported trade actionType" }, 400);
    }
    const status = normalizeQueryText(context.req.query("status"));
    if (status && !TRADE_STATUSES.has(status)) {
      return context.json({ error: "unsupported trade status" }, 400);
    }

    return context.json(
      await controlService.getTradeHistory({
        limit: parseLimit(context.req.query("limit"), 50, 200),
        offset: parseOffset(context.req.query("offset")),
        actionType: actionType as ActionType | undefined,
        status: status as "success" | "failed" | "skipped" | undefined,
        token: normalizeQueryText(context.req.query("token")),
        since: normalizeIsoQuery(context.req.query("since")),
        until: normalizeIsoQuery(context.req.query("until"))
      })
    );
  });

  app.get("/paper-trading/snapshots", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const configuredLimit = runtime.config.storage?.audit_query_limit ?? 30;
    const requestedLimit = Number(context.req.query("limit"));
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, configuredLimit) : configuredLimit;

    return context.json({
      snapshots: runtime.state.getPaperPositionSnapshots({
        positionId: context.req.query("positionId"),
        skillId: context.req.query("skillId"),
        limit
      })
    });
  });

  app.get("/portfolio/report", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(
      await controlService.getPortfolioReport({
        days: parseReportDays(context.req.query("days")),
        timezoneOffsetMinutes: parseTimezoneOffsetMinutes(context.req.query("timezoneOffsetMinutes"))
      })
    );
  });

  app.post("/control/pause", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const body = await tryReadJsonBody(context.req.raw);
    return context.json(await controlService.pause(typeof body.reason === "string" ? body.reason : "manual_api"));
  });

  app.post("/control/resume", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(await controlService.resume());
  });

  app.post("/control/run-main-cycle", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(await controlService.runMainCycle());
  });

  app.post("/control/emergency-exit-all", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(await controlService.emergencyExitAll());
  });

  app.post("/skills/:id/disable", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const result = await controlService.disableSkill(context.req.param("id"));
    if (!result) {
      return context.json({ error: "skill not found" }, 404);
    }

    return context.json(result);
  });

  app.post("/skills/:id/enable", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const body = await tryReadJsonBody(context.req.raw);
    const canaryPercent =
      typeof body.canaryPercent === "number" && Number.isFinite(body.canaryPercent)
        ? body.canaryPercent
        : undefined;
    const result = await controlService.enableSkill(context.req.param("id"), canaryPercent);
    if (!result) {
      return context.json({ error: "skill not found" }, 404);
    }

    return context.json(result);
  });

  app.put("/skills/:id/params", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const body = await tryReadJsonBody(context.req.raw);
    const result = await controlService.updateSkillParams(context.req.param("id"), body);
    if (!result) {
      return context.json({ error: "skill not found" }, 404);
    }

    return context.json(result);
  });

  app.post("/skills/:id/rollback", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const body = await tryReadJsonBody(context.req.raw);
    const version = typeof body.version === "string" ? body.version : undefined;
    const result = await controlService.rollbackSkill(context.req.param("id"), version);
    if (!result) {
      return context.json({ error: "skill/version not found" }, 404);
    }

    return context.json(result);
  });

  app.post("/positions/:id/force-exit", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.json(await controlService.forceExitPosition(context.req.param("id")));
  });

  app.get("/audit/events", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    const configuredLimit = runtime.config.storage?.audit_query_limit ?? 30;
    const source = normalizeQueryText(context.req.query("source"));
    if (source && !AUDIT_SOURCES.has(source)) {
      return context.json({ error: "unsupported audit source" }, 400);
    }
    const limit = parseLimit(context.req.query("limit"), configuredLimit, configuredLimit);
    const offset = parseOffset(context.req.query("offset"));
    const queriedEvents = runtime.auditReader.queryEvents
      ? await runtime.auditReader.queryEvents({
          source,
          cycleId: normalizeQueryText(context.req.query("cycleId")),
          q: normalizeQueryText(context.req.query("q")),
          since: normalizeIsoQuery(context.req.query("since")),
          until: normalizeIsoQuery(context.req.query("until")),
          limit: limit + 1,
          offset
        })
      : await runtime.auditReader.readRecent(limit + offset + 1);
    const events = runtime.auditReader.queryEvents ? queriedEvents : queriedEvents.slice(offset, offset + limit + 1);

    return context.json({
      events: events.slice(0, limit),
      page: {
        ...buildPage(limit, offset, events.length),
        total: undefined
      }
    });
  });

  app.get("/metrics", async (context) => {
    const unauthorized = requireApiAuth(context);
    if (unauthorized) {
      return unauthorized;
    }

    return context.text(runtime.metricsService.renderPrometheus(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8"
    });
  });

  return app;
}

export async function startApiServer(runtime: AppRuntime, options: ApiServerOptions): Promise<ServerType> {
  const logger = rootLogger.child("api_server");
  const app = createApiApp(runtime, options);
  const bearerToken = resolveApiBearerToken(runtime);

  return await new Promise<ServerType>((resolve, reject) => {
    let settled = false;

    const server = serve(
      {
        fetch: app.fetch,
        hostname: options.host,
        port: options.port
      },
      (info) => {
        if (settled) {
          return;
        }

        settled = true;
        server.off("error", onStartupError);
        server.on("error", (error) => {
          logger.error("API Server 运行异常", { error });
        });
        logger.info("API Server 已启动", {
          host: info.address,
          port: info.port,
          authEnabled: Boolean(bearerToken)
        });
        resolve(server);
      }
    );

    const onStartupError = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    server.once("error", onStartupError);
  });
}
