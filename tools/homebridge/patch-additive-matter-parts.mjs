#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const MARKER = '// hejhome-additive-matter-parts-v1';
const SERVER = 'dist/matter/server.js';
const MANAGER = 'dist/matter/server/AccessoryManager.js';
const RUNTIME = 'dist/matter/hejhome-additive-parts.js';
const BACKUP = '.hejhome-additive-parts-backup';
const UPDATE_HASH = 'd08a17ea7560ef3963fee1e5443f72e162199c64c284160f791ac7e1589fa9fb';
const PARTS_HASH = '228678a6fe7da1c72a410afe41b95107f8c7547453c77a1468d32a83415a7741';
const hash = (data) => createHash('sha256').update(data).digest('hex');

function replaceOnce(source, needle, replacement) {
  const index = source.indexOf(needle);
  if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error('Unsupported Homebridge source: expected exactly one patch target');
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

function lifecycleGuard(indent) {
  const space = ' '.repeat(indent);
  return `\n${space}if (!isCurrent()) {\n${space}    throw new Error('Matter accessory changed during child creation');\n${space}}`;
}

async function writeAtomic(file, content, mode) {
  const temporary = `${file}.hejhome-tmp`;
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, file);
}

function validateManifest(manifest) {
  const paths = [RUNTIME, MANAGER, SERVER];
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (manifest?.version !== '2.4.0' || !Array.isArray(manifest.files) || manifest.files.length !== paths.length
    || manifest.files.some((entry, index) => !entry || entry.path !== paths[index]
      || !digest(entry.patchedHash) || !(digest(entry.originalHash) || (entry.path === RUNTIME && entry.originalHash === null))
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) {
    throw new Error('Invalid recovery manifest');
  }
}

export async function patchAdditiveMatterParts(root, mode = 'check') {
  root = path.resolve(root);
  const backup = path.join(root, BACKUP);
  if (mode === 'restore') {
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
    validateManifest(manifest);
    const originals = new Map();
    for (const entry of manifest.files) {
      const current = await fs.readFile(path.join(root, entry.path)).catch((error) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      if (current !== null && hash(current) !== entry.patchedHash && hash(current) !== entry.originalHash) {
        throw new Error(`Refusing to overwrite a changed file: ${entry.path}`);
      }
      if (entry.originalHash !== null) {
        const original = await fs.readFile(path.join(backup, entry.path));
        if (hash(original) !== entry.originalHash) {
          throw new Error(`Recovery original checksum mismatch: ${entry.path}`);
        }
        originals.set(entry.path, original);
      }
    }
    for (const entry of [...manifest.files].reverse()) {
      const file = path.join(root, entry.path);
      if (entry.originalHash === null) {
        await fs.rm(file, { force: true });
      } else {
        await writeAtomic(file, originals.get(entry.path), entry.mode);
      }
    }
    await fs.rm(backup, { recursive: true });
    return { status: 'restored', root };
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'homebridge' || pkg.version !== '2.4.0') {
    throw new Error('This compatibility patch is verified only for Homebridge 2.4.0');
  }
  const server = await fs.readFile(path.join(root, SERVER), 'utf8');
  const manager = await fs.readFile(path.join(root, MANAGER), 'utf8');
  const runtime = await fs.readFile(new URL('./additive-matter-parts-runtime.mjs', import.meta.url), 'utf8');
  if (server.includes(MARKER)) {
    if (!manager.includes(MARKER) || await fs.readFile(path.join(root, RUNTIME), 'utf8') !== runtime) {
      throw new Error('Existing patch differs; restore it before applying this version');
    }
    const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
    validateManifest(manifest);
    for (const entry of manifest.files) {
      if (hash(await fs.readFile(path.join(root, entry.path))) !== entry.patchedHash) {
        throw new Error(`Patched file changed outside the tool: ${entry.path}`);
      }
    }
    return { status: 'already-applied', root };
  }
  const start = server.indexOf('    async updatePlatformAccessories(accessories) {');
  const end = server.indexOf('    // ============================================================================', start);
  const partsStart = manager.indexOf('    async createAccessoryParts(');
  const partsEnd = manager.indexOf('    /**\n     * Advertise the ElectricalSensor', partsStart);
  if (start < 0 || end < 0 || hash(server.slice(start, end)) !== UPDATE_HASH
    || partsStart < 0 || partsEnd < 0 || hash(manager.slice(partsStart, partsEnd)) !== PARTS_HASH) {
    throw new Error('Unsupported Homebridge update implementation');
  }
  const patchedServer = `import { updateWithAdditiveParts } from './hejhome-additive-parts.js';\n${server.slice(0, start)}${MARKER}
    async updatePlatformAccessories(accessories) {
        return updateWithAdditiveParts.call(this, accessories);
    }
${server.slice(end)}`.replace('//# sourceMappingURL=server.js.map', '');
  let patchedManager = replaceOnce(manager,
    'async createAccessoryParts(accessory, parentEndpoint, deps) {',
    `async createAccessoryParts(accessory, parentEndpoint, deps, partIndexOffset = 0, isCurrent = () => true) {\n        ${MARKER}`);
  patchedManager = replaceOnce(patchedManager, 'tag: partIndex,', 'tag: partIndex + partIndexOffset,')
    .replace('//# sourceMappingURL=AccessoryManager.js.map', '');
  for (const [needle, indent] of [
    ['for (const [partIndex, part] of accessory.parts.entries()) {', 12],
    ['const partPrepared = await this.prepareDeviceType(this.partAsAccessory(part, partEndpointId));', 12],
    ['await parentEndpoint.add(partEndpoint);', 12],
    ['await this.advertiseUtilityDeviceType(partEndpoint, \'ElectricalSensor\', part.displayName || part.id);', 16],
    ['await this.advertiseUtilityDeviceType(partEndpoint, \'PowerSource\', part.displayName || part.id);', 16],
  ]) {
    patchedManager = replaceOnce(patchedManager, needle, needle + lifecycleGuard(indent));
  }
  // Enable the import last; restore removes it before deleting its runtime module.
  const files = [{ path: RUNTIME, content: runtime }, { path: MANAGER, content: patchedManager }, { path: SERVER, content: patchedServer }];
  if (mode === 'check') {
    return { status: 'ready', root, version: pkg.version, files: files.map((entry) => entry.path) };
  }
  if (mode !== 'apply') {
    throw new Error('Expected check, apply or restore');
  }
  await fs.mkdir(backup, { mode: 0o700 });
  const manifest = { version: pkg.version, files: [] };
  for (const entry of files) {
    const file = path.join(root, entry.path);
    const original = await fs.readFile(file).catch((error) => {
      if (error.code === 'ENOENT' && entry.path === RUNTIME) {
        return null;
      }
      throw error;
    });
    const permissions = original === null ? 0o644 : (await fs.stat(file)).mode & 0o777;
    if (original !== null) {
      const saved = path.join(backup, entry.path);
      await fs.mkdir(path.dirname(saved), { recursive: true });
      await fs.writeFile(saved, original, { mode: permissions });
    }
    manifest.files.push({ path: entry.path, mode: permissions, originalHash: original === null ? null : hash(original), patchedHash: hash(entry.content) });
  }
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  for (const entry of files) {
    await writeAtomic(path.join(root, entry.path), entry.content, manifest.files.find((item) => item.path === entry.path).mode);
  }
  return { status: 'applied', root, backup };
}

const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath && invokedPath === await fs.realpath(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--homebridge-root');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const actions = args.filter((arg) => ['--apply', '--restore', '--check'].includes(arg));
  if (!root || actions.length > 1 || args.filter((arg) => arg === '--homebridge-root').length !== 1
    || args.some((arg, index) => index !== rootIndex + 1 && !['--homebridge-root', '--apply', '--restore', '--check'].includes(arg))) {
    console.error('Usage: node patch-additive-matter-parts.mjs --homebridge-root PATH [--check|--apply|--restore]');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await patchAdditiveMatterParts(root, actions[0]?.slice(2) ?? 'check')));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
