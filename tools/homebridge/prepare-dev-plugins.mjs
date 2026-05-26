#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const pluginDirectory = path.join(root, 'test/plugins');

const links = new Map([
  ['homebridge-hejhome', root],
  ['homebridge-config-ui-x', path.join(root, 'node_modules/homebridge-config-ui-x')],
]);

fs.mkdirSync(pluginDirectory, { recursive: true });

for (const [name, target] of links) {
  if (!fs.existsSync(target)) {
    throw new Error(`Missing required Homebridge dev plugin target: ${target}`);
  }

  const linkPath = path.join(pluginDirectory, name);
  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      throw new Error(`Refusing to replace non-symlink dev plugin path: ${linkPath}`);
    }
  }

  fs.symlinkSync(target, linkPath, 'dir');
}

console.log(`Prepared Homebridge dev plugin directory: ${pluginDirectory}`);
