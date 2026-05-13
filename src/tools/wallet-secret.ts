import { promises as fs } from "node:fs";
import path from "node:path";

import { WalletSecretManager } from "../wallet/wallet-secret-manager.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function requireArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing required arg --${key}`);
  }

  return value.trim();
}

async function writeEnvelope(outputPath: string, envelope: unknown): Promise<void> {
  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, resolvedPath);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "encrypt") {
    const secretEnv = requireArg(args, "secret-env");
    const keyEnv = requireArg(args, "key-env");
    const outputPath = requireArg(args, "out");
    const keyVersion = typeof args["key-version"] === "string" ? args["key-version"] : undefined;
    const secret = process.env[secretEnv];
    const passphrase = process.env[keyEnv];
    if (!secret) {
      throw new Error(`environment variable ${secretEnv} is empty`);
    }
    if (!passphrase) {
      throw new Error(`environment variable ${keyEnv} is empty`);
    }

    const envelope = WalletSecretManager.encryptSecret(secret, passphrase, keyVersion);
    await writeEnvelope(outputPath, envelope);
    console.log(`encrypted wallet secret -> ${path.resolve(outputPath)}`);
    return;
  }

  if (command === "decrypt") {
    const filePath = requireArg(args, "file");
    const keyEnv = requireArg(args, "key-env");
    const passphrase = process.env[keyEnv];
    if (!passphrase) {
      throw new Error(`environment variable ${keyEnv} is empty`);
    }

    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const envelope = JSON.parse(raw);
    const secret = WalletSecretManager.decryptEnvelope(envelope, passphrase);
    console.log(secret);
    return;
  }

  if (command === "rotate") {
    const filePath = requireArg(args, "file");
    const fromKeyEnv = requireArg(args, "from-key-env");
    const toKeyEnv = requireArg(args, "to-key-env");
    const outputPath = requireArg(args, "out");
    const keyVersion = typeof args["key-version"] === "string" ? args["key-version"] : undefined;
    const fromPassphrase = process.env[fromKeyEnv];
    const toPassphrase = process.env[toKeyEnv];
    if (!fromPassphrase || !toPassphrase) {
      throw new Error("rotation key env is empty");
    }

    const raw = await fs.readFile(path.resolve(filePath), "utf8");
    const envelope = JSON.parse(raw);
    const secret = WalletSecretManager.decryptEnvelope(envelope, fromPassphrase);
    const rotated = WalletSecretManager.encryptSecret(secret, toPassphrase, keyVersion);
    await writeEnvelope(outputPath, rotated);
    console.log(`rotated wallet secret -> ${path.resolve(outputPath)}`);
    return;
  }

  throw new Error("usage: wallet-secret <encrypt|decrypt|rotate> [--args]");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
