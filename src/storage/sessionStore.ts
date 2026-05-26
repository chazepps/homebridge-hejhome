import fs from 'node:fs/promises';
import path from 'node:path';

import type { HejSession } from '../types.js';

export class SessionStore {
  private readonly sessionPath: string;

  constructor(homebridgeStoragePath: string) {
    this.sessionPath = path.join(homebridgeStoragePath, 'hejhome', 'session.json');
  }

  async load(): Promise<HejSession | null> {
    try {
      const raw = await fs.readFile(this.sessionPath, 'utf8');
      const parsed = JSON.parse(raw) as HejSession;
      if (!parsed.accessToken || !parsed.jsessionId || !parsed.identifier) {
        return null;
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(session: HejSession): Promise<void> {
    const safeSession: HejSession = {
      identifier: session.identifier,
      autoLogin: true,
      accessToken: session.accessToken,
      jsessionId: session.jsessionId,
      usernameCookie: session.usernameCookie,
      expiresAt: session.expiresAt,
    };
    const directory = path.dirname(this.sessionPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.sessionPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(safeSession, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.sessionPath);
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.sessionPath, { force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
