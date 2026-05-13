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
    server = await startApiServer(runtime, {
      host: process.env.API_HOST ?? runtime.config.api?.host ?? "127.0.0.1",
      port: Number(process.env.PORT ?? runtime.config.api?.port ?? 8787)
    });
  }

  await runtime.orchestrator.start();

  const shutdown = (signal: string): void => {
    rootLogger.warn(`收到 ${signal}，准备停止服务`);
    runtime.orchestrator.stop();
    server?.close();
    void runtime.state.flush()
      .catch((error) => {
        rootLogger.error("停止服务时状态刷盘失败", { error });
      })
      .finally(() => runtime.shutdown());
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
