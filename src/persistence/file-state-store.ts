import { promises as fs } from "node:fs";
import path from "node:path";

import type { SharedStateSnapshot } from "../core/shared-state.js";
import type { IStateStore } from "./contracts.js";
import { deserializeStateSnapshot, serializeStateSnapshot } from "./state-serialization.js";

export class FileStateStore implements IStateStore {
  private writeQueue: Promise<void> = Promise.resolve();
  readonly kind = "file";

  constructor(private readonly filePath: string) {}

  async load(): Promise<SharedStateSnapshot | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return deserializeStateSnapshot(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  save(snapshot: SharedStateSnapshot): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(JSON.parse(serializeStateSnapshot(snapshot)), null, 2)}\n`, "utf8");
        await fs.rename(tempPath, this.filePath);
      });

    return this.writeQueue;
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
