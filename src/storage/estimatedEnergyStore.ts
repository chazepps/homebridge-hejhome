import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_ESTIMATED_ENERGY_MWH = 1_000_000_000_000_000;

/** Account identity stays stable across token/cookie rotation; no credential is written. */
export function estimatedEnergyOwner(identifier: string): string {
  return createHash('sha256').update(`hejhome:estimated-energy:v1:${identifier.trim()}`).digest('hex');
}

export class EstimatedEnergyStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly storagePath: string, private readonly onInvalid: (error: Error) => void = () => undefined) {}

  async load(identifier: string): Promise<Record<string, number>> {
    await this.pending.catch(() => undefined);
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.path(identifier), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return this.invalid();
      }
      const data = raw as Record<string, unknown>;
      if (data.version !== 1 || data.owner !== estimatedEnergyOwner(identifier) || !validTotals(data.totals)) {
        return this.invalid();
      }
      return data.totals;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return this.invalid();
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  save(identifier: string, totals: Record<string, number>): Promise<void> {
    if (!validTotals(totals)) {
      return Promise.reject(new Error('Invalid estimated energy totals.'));
    }
    const data = JSON.stringify({ version: 1, owner: estimatedEnergyOwner(identifier), totals });
    const file = this.path(identifier);
    const operation = this.pending.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${data}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    this.pending = operation;
    return operation;
  }

  private invalid(): Record<string, number> {
    this.onInvalid(new Error('Invalid estimated energy store: previous cumulative history is unavailable; only newly observed intervals can be estimated.'));
    return {};
  }

  private path(identifier: string): string {
    return path.join(this.storagePath, 'hejhome', `estimated-energy-${estimatedEnergyOwner(identifier)}.json`);
  }
}

function validTotals(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 10000) {
    return false;
  }
  return Object.entries(value).every(([id, total]) => id.length > 0 && id.length <= 128
    && !['__proto__', 'prototype', 'constructor'].includes(id)
    && typeof total === 'number' && Number.isFinite(total) && total >= 0 && total <= MAX_ESTIMATED_ENERGY_MWH);
}
