import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WalletSecretManager } from "../../src/wallet/wallet-secret-manager.js";
import { createTestLogger } from "../helpers/logger.js";

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("WalletSecretManager 优先加载明文环境变量", async () => {
  await withEnv(
    {
      WALLET_PRIVATE_KEY: "plaintext-secret"
    },
    async () => {
      const manager = new WalletSecretManager(
        process.cwd(),
        {
          plaintext_env: "WALLET_PRIVATE_KEY",
          encrypted_file_path: "./missing.json",
          encryption_key_env: "XAGENT_WALLET_KEY",
          key_version: "v1",
          allow_secret_forwarding: true
        },
        createTestLogger()
      );

      const loaded = await manager.load();
      assert.equal(loaded?.secret, "plaintext-secret");
      assert.equal(loaded?.source, "plaintext_env");
      assert.equal(loaded?.keyVersion, "v1");
      assert.equal(loaded?.allowSecretForwarding, true);
    }
  );
});

test("WalletSecretManager 可以加密文件、解密文件并保留 key version", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-wallet-"));
  try {
    const envelope = WalletSecretManager.encryptSecret("encrypted-secret", "passphrase", "v2");
    await writeFile(path.join(tmpDir, "wallet.enc.json"), JSON.stringify(envelope), "utf8");

    await withEnv(
      {
        XAGENT_WALLET_KEY: "passphrase",
        WALLET_PRIVATE_KEY: undefined
      },
      async () => {
        const manager = new WalletSecretManager(
          tmpDir,
          {
            plaintext_env: "WALLET_PRIVATE_KEY",
            encrypted_file_path: "./wallet.enc.json",
            encryption_key_env: "XAGENT_WALLET_KEY",
            key_version: "v1"
          },
          createTestLogger()
        );

        const loaded = await manager.load();
        assert.equal(loaded?.secret, "encrypted-secret");
        assert.equal(loaded?.source, "encrypted_file");
        assert.equal(loaded?.keyVersion, "v2");
        assert.equal(loaded?.allowSecretForwarding, false);
      }
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("WalletSecretManager 主加密文件失败时会回退 previous 文件且禁止转发", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-wallet-"));
  try {
    const previous = WalletSecretManager.encryptSecret("previous-secret", "passphrase", "v0");
    await writeFile(path.join(tmpDir, "broken.enc.json"), "{", "utf8");
    await writeFile(path.join(tmpDir, "previous.enc.json"), JSON.stringify(previous), "utf8");

    await withEnv(
      {
        XAGENT_WALLET_KEY: "passphrase",
        WALLET_PRIVATE_KEY: undefined
      },
      async () => {
        const manager = new WalletSecretManager(
          tmpDir,
          {
            plaintext_env: "WALLET_PRIVATE_KEY",
            encrypted_file_path: "./broken.enc.json",
            previous_encrypted_file_path: "./previous.enc.json",
            encryption_key_env: "XAGENT_WALLET_KEY",
            key_version: "v1",
            previous_key_version: "v0",
            allow_secret_forwarding: true
          },
          createTestLogger()
        );

        const loaded = await manager.load();
        assert.equal(loaded?.secret, "previous-secret");
        assert.equal(loaded?.source, "previous_encrypted_file");
        assert.equal(loaded?.keyVersion, "v0");
        assert.equal(loaded?.allowSecretForwarding, false);
      }
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

