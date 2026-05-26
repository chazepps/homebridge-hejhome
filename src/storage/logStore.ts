import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitizeForLog } from '../utils/redact.js';

export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export class LogStore {
  private readonly logPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(homebridgeStoragePath: string) {
    this.logPath = path.join(homebridgeStoragePath, 'hejhome', 'hejhome.log');
  }

  get path(): string {
    return this.logPath;
  }

  async append(level: LogLevel, event: string, data: unknown = {}): Promise<void> {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${event} ${JSON.stringify(sanitizeForLog(data))}\n`;
    const write = this.writeQueue.then(async () => {
      const directory = path.dirname(this.logPath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.logPath, line, { mode: 0o600 });
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}
