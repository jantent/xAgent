import { startApiServer } from "./api/server.js";
import { buildRuntime } from "./app/runtime.js";
import { rootLogger } from "./utils/logger.js";

function parseArgs(argv: string[]): { once: boolean; noApi: boolean; configPath: string; skillsPath: string } {
  const once = argv.includes("--once");
  const noApi = argv.includes("--no-api");

  const configFlagIndex = argv.indexOf("--config");
  const skillsFlagIndex = argv.indexOf("--skills");

  return {
    once,
    noApi,
    configPath: configFlagIndex >= 0 ? argv[configFlagIndex + 1]! : "config/agent.yaml",
    skillsPath: skillsFlagIndex >= 0 ? argv[skillsFlagIndex + 1]! : "config/skills"
  };
}

async function closeServer(server: Awaited<ReturnType<typeof startApiServer>> | undefined): Promise<void> {
  if (!server) {
    return;
  }

  const forceClosableServer = server as typeof server & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    server.close(() => finish());
    forceClosableServer.closeIdleConnections?.();
    const forceClose = setTimeout(() => {
      forceClosableServer.closeAllConnections?.();
      finish();
    }, 1_000);
    forceClose.unref?.();
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = rootLogger.child("bootstrap");
  const runtime = await buildRuntime({
    cwd: process.cwd(),
    configPath: args.configPath,
    skillsPath: args.skillsPath
  });

  logger.info("系统启动完成", {
    configPath: runtime.configPath,
    skillsPath: runtime.skillsPath,
    samplePoolPath: runtime.samplePoolPath,
    once: args.once,
    apiEnabled: runtime.config.api?.enabled !== false && !args.noApi
  });

  if (args.once) {
    await runtime.orchestrator.runMainCycle();
    await runtime.orchestrator.runHighFreqTick();
    try {
      await runtime.state.flush();
    } finally {
      await runtime.shutdown();
    }
    return;
  }

  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  const apiEnabled = runtime.config.api?.enabled !== false && !args.noApi;
  if (apiEnabled) {
    const apiHost = process.env.API_HOST ?? runtime.config.api?.host ?? "127.0.0.1";
    const apiPort = Number(process.env.PORT ?? runtime.config.api?.port ?? 8787);
    server = await startApiServer(runtime, {
      host: apiHost,
      port: apiPort
    });
    const dashboardHost = apiHost === "0.0.0.0" || apiHost === "::" ? "127.0.0.1" : apiHost;
    runtime.telegramBot?.setRuntimeDashboardUrl(`http://${dashboardHost}:${apiPort}/dashboard`);
  }

  runtime.telegramBot?.start();
  await runtime.orchestrator.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    rootLogger.warn(`收到 ${signal}，准备停止服务`);

    void (async () => {
      runtime.orchestrator.stop();
      try {
        await closeServer(server);
        await runtime.state.flush();
      } catch (error) {
        rootLogger.error("停止服务时状态刷盘失败", { error });
        process.exitCode = 1;
      }

      try {
        await runtime.shutdown();
      } catch (error) {
        rootLogger.error("停止服务时资源释放失败", { error });
        process.exitCode = 1;
      } finally {
        process.exit(process.exitCode ?? 0);
      }
    })();
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main().catch((error) => {
  rootLogger.error("程序启动失败", { error });
  process.exitCode = 1;
});
