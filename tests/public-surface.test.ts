import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('public project surface', () => {
  test('does not describe private provenance or removed archive directories in public markdown', () => {
    const publicMarkdown = [
      'README.md',
      'DOCUMENTATION_REFACTORING.md',
      'docs/README.md',
      'docs/generated/project-structure/README.md',
      'docs/generated/project-structure/monorepo.md',
    ].map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(root, relativePath), 'utf8'),
    ] as const);

    const forbidden = [
      /\bsource-derived\b/i,
      /\brestored-from(?:-sourcemaps|-source)?\b/i,
      /\bsource\s*map\b|\bsourcemap\b/i,
      /\bbackup\/?\b/i,
    ];

    for (const [relativePath, text] of publicMarkdown) {
      for (const pattern of forbidden) {
        expect.soft(text, `${relativePath} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test('release workflow uses npm Trusted Publishing without a long-lived token secret', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish --access public --provenance');
    expect(workflow).not.toMatch(/\bNPM_TOKEN\b/);
    expect(workflow).not.toMatch(/\bNODE_AUTH_TOKEN\b/);
  });
});
