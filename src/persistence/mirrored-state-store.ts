import type { SharedStateSnapshot } from "../core/shared-state.js";
import type { Logger } from "../utils/logger.js";
import type { IStateStore } from "./contracts.js";

export class MirroredStateStore implements IStateStore {
  readonly kind: string;

  constructor(
    private readonly primary: IStateStore,
    private readonly mirrors: IStateStore[],
    private readonly logger: Logger
  ) {
    this.kind = mirrors.length > 0 ? `${primary.kind}+mirror` : primary.kind;
  }

  async load(): Promise<SharedStateSnapshot | null> {
    try {
      return await this.primary.load();
    } catch (error) {
      this.logger.warn("主状态存储读取失败，尝试镜像", {
        primary: this.primary.kind,
        error
      });
    }

    for (const mirror of this.mirrors) {
      try {
        const snapshot = await mirror.load();
        if (snapshot) {
          return snapshot;
        }
      } catch (error) {
        this.logger.warn("镜像状态存储读取失败", { mirror: mirror.kind, error });
      }
    }

    return null;
  }

  async save(snapshot: SharedStateSnapshot): Promise<void> {
    await this.primary.save(snapshot);
    if (this.mirrors.length === 0) {
      return;
    }

    const results = await Promise.all(
      this.mirrors.map(async (mirror) => {
        try {
          await mirror.save(snapshot);
          return { mirror: mirror.kind, ok: true } as const;
        } catch (error) {
          this.logger.warn("镜像状态写入失败", {
            mirror: mirror.kind,
            error
          });
          return { mirror: mirror.kind, ok: false } as const;
        }
      })
    );

    const failedMirrors = results.filter((result) => !result.ok).map((result) => result.mirror);
    if (failedMirrors.length === this.mirrors.length) {
      this.logger.error("所有镜像状态写入失败", {
        primary: this.primary.kind,
        failedMirrors
      });
    }
  }

  async ping(): Promise<boolean> {
    if (!this.primary.ping) {
      return true;
    }

    return this.primary.ping();
  }

  async close(): Promise<void> {
    await this.primary.close?.();
    await Promise.all(this.mirrors.map((mirror) => mirror.close?.()));
  }
}
