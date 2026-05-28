import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const serverPath = path.resolve(import.meta.dirname, '../homebridge-ui/server.js');

describe('Homebridge custom UI server logout support', () => {
  test('registers a logout endpoint that clears the stored session', () => {
    const source = fs.readFileSync(serverPath, 'utf8');

    expect(source).toContain('this.onRequest(\'/logout\', this.handleLogout.bind(this));');
    expect(source).toMatch(/async handleLogout\(\)\s*\{[\s\S]*await this\.sessionStore\.clear\(\);/);
    expect(source).toMatch(/async handleLogout\(\)\s*\{[\s\S]*this\.verifiedIdentifiers\.clear\(\);/);
  });
});
