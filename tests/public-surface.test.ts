import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('public project surface', () => {
  test('production branding metadata and assets are complete', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name: string;
      displayName?: string;
      description?: string;
      author?: { name?: string; url?: string };
      contributors?: Array<{ name?: string; url?: string }>;
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      funding?: Array<{ type?: string; url?: string }>;
      icon?: string;
      files?: string[];
    };
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const issueTemplateConfig = fs.readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');

    expect(pkg.name).toBe('homebridge-hejhome');
    expect(pkg.displayName).toBe('Hejhome');
    expect(pkg.description).toContain('Hejhome');
    expect(pkg.author).toEqual({
      name: 'Chaz',
      url: 'https://github.com/chazepps',
    });
    expect(pkg.contributors).toContainEqual({
      name: 'Chaz',
      url: 'https://github.com/chazepps',
    });
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'https://github.com/chazepps/homebridge-hejhome.git',
    });
    expect(pkg.bugs?.url).toBe('https://github.com/chazepps/homebridge-hejhome/issues');
    expect(pkg.homepage).toBe('https://github.com/chazepps/homebridge-hejhome#readme');
    expect(pkg.funding).toContainEqual({
      type: 'github',
      url: 'https://github.com/sponsors/chazepps',
    });
    expect(pkg.icon).toBe('https://raw.githubusercontent.com/chazepps/homebridge-hejhome/main/branding/icon.png');
    expect(pkg.files).toContain('branding');
    expect(fs.existsSync(path.join(root, 'branding/icon.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'branding/logo.png'))).toBe(true);
    expect(readme).toContain('https://raw.githubusercontent.com/chazepps/homebridge-hejhome/main/branding/logo.png');
    expect(issueTemplateConfig).not.toMatch(/YOUR_CHANNEL_HERE|blank_issues_enabled:\s*#/);
  });

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
