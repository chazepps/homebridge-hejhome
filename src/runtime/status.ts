import fs from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeStatus {
  version: 1;
  controlsAvailable?: boolean;
  updatedAt: string;
  connection: {
    session: 'missing' | 'valid' | 'expired' | 'unknown';
    realtime: 'connecting' | 'connected' | 'disconnected' | 'unknown';
  };
  devices: Array<{
    id: string; name: string; deviceType: string; online: boolean | null;
    lastSeenAt: string | null; lastControlAt: string | null;
    lastControl: 'success' | 'failed' | 'unknown'; homekit: boolean; matter: boolean;
    temperatureCelsius?: number | null;
  }>;
}

export function runtimeStatusPath(storagePath: string): string {
  return path.join(storagePath, 'hejhome', 'runtime-status.json');
}

export async function loadRuntimeStatus(storagePath: string): Promise<RuntimeStatus | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(runtimeStatusPath(storagePath), 'utf8')) as RuntimeStatus;
    return parsed.version === 1 && parsed.connection && Array.isArray(parsed.devices) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export class RuntimeStatusStore {
  private active: Promise<void> | null = null;
  private pending: RuntimeStatus | null = null;
  constructor(private readonly storagePath: string) {}

  save(status: RuntimeStatus): Promise<void> {
    // Diagnostics need the newest snapshot, not an unbounded history of writes.
    this.pending = status;
    if (!this.active) {
      this.active = this.drain().finally(() => {
        this.active = null;
        // A save may arrive between the final write and this promise's cleanup.
        if (this.pending) {
          return this.save(this.pending);
        }
      });
    }
    return this.active;
  }

  flush(): Promise<void> {
    return this.active ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    const file = runtimeStatusPath(this.storagePath);
    while (this.pending) {
      const status = this.pending;
      this.pending = null;
      const data = JSON.stringify(status);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${data}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    }
  }
}
