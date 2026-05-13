import { promises as fs } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import type { WalletSecretConfig } from "../config/types.js";
import type { Logger } from "../utils/logger.js";

interface WalletSecretEnvelopeV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  keyVersion?: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
}

export interface LoadedWalletSecret {
  secret: string;
  source: "plaintext_env" | "encrypted_file" | "previous_encrypted_file";
  keyVersion?: string;
  allowSecretForwarding: boolean;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function toBase64(value: Buffer): string {
  return value.toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export class WalletSecretManager {
  constructor(
    private readonly cwd: string,
    private readonly config: WalletSecretConfig | undefined,
    private readonly logger: Logger
  ) {}

  async load(): Promise<LoadedWalletSecret | null> {
    if (!this.config) {
      return null;
    }

    const plaintextEnv = this.config.plaintext_env ? process.env[this.config.plaintext_env]?.trim() : undefined;
    if (plaintextEnv) {
      return {
        secret: plaintextEnv,
        source: "plaintext_env",
        keyVersion: this.config.key_version,
        allowSecretForwarding: this.config.allow_secret_forwarding === true
      };
    }

    const passphrase = this.config.encryption_key_env ? process.env[this.config.encryption_key_env] : undefined;
    if (this.config.encrypted_file_path && passphrase) {
      try {
        return await this.loadEncryptedFile(
          this.config.encrypted_file_path,
          passphrase,
          this.config.key_version,
          "encrypted_file",
          this.config.allow_secret_forwarding === true
        );
      } catch (error) {
        this.logger.warn("读取主钱包密钥文件失败", {
          path: this.config.encrypted_file_path,
          error
        });
      }
    }

    if (this.config.previous_encrypted_file_path && passphrase) {
      try {
        return await this.loadEncryptedFile(
          this.config.previous_encrypted_file_path,
          passphrase,
          this.config.previous_key_version ?? this.config.key_version,
          "previous_encrypted_file",
          false
        );
      } catch (error) {
        this.logger.warn("读取上一版本钱包密钥文件失败", {
          path: this.config.previous_encrypted_file_path,
          error
        });
      }
    }

    this.logger.warn("钱包密钥未加载，缺少明文环境变量或加密文件配置", {
      plaintextEnv: this.config.plaintext_env,
      encryptedFilePath: this.config.encrypted_file_path,
      encryptionKeyEnv: this.config.encryption_key_env
    });
    return null;
  }

  static encryptSecret(secret: string, passphrase: string, keyVersion?: string): WalletSecretEnvelopeV1 {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      version: 1,
      algorithm: "aes-256-gcm",
      keyVersion,
      salt: toBase64(salt),
      iv: toBase64(iv),
      authTag: toBase64(authTag),
      ciphertext: toBase64(ciphertext),
      createdAt: new Date().toISOString()
    };
  }

  static decryptEnvelope(envelope: WalletSecretEnvelopeV1, passphrase: string): string {
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
      throw new Error("unsupported wallet secret envelope");
    }

    const key = deriveKey(passphrase, fromBase64(envelope.salt));
    const decipher = createDecipheriv("aes-256-gcm", key, fromBase64(envelope.iv));
    decipher.setAuthTag(fromBase64(envelope.authTag));
    const plaintext = Buffer.concat([
      decipher.update(fromBase64(envelope.ciphertext)),
      decipher.final()
    ]);

    return plaintext.toString("utf8");
  }

  private async loadEncryptedFile(
    relativePath: string,
    passphrase: string,
    keyVersion: string | undefined,
    source: LoadedWalletSecret["source"],
    allowSecretForwarding: boolean
  ): Promise<LoadedWalletSecret> {
    const resolvedPath = path.resolve(this.cwd, relativePath);
    const raw = await fs.readFile(resolvedPath, "utf8");
    const envelope = JSON.parse(raw) as WalletSecretEnvelopeV1;
    const secret = WalletSecretManager.decryptEnvelope(envelope, passphrase).trim();
    if (!secret) {
      throw new Error(`wallet secret file is empty: ${resolvedPath}`);
    }

    return {
      secret,
      source,
      keyVersion: envelope.keyVersion ?? keyVersion,
      allowSecretForwarding
    };
  }
}
