import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { RuntimeCommandServer, runtimeCommandPath, sendRuntimeCommand } from '../src/runtime/commands.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  } vi.useRealTimers();
});
async function setup(handler = vi.fn(async () => undefined)) {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-');
  const server = new RuntimeCommandServer(storage, handler);
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  expect(await server.start()).toBe(true);
  return { storage, server, handler };
}
const request = { deviceId: 'tv', kind: 'remote' as const, command: { type: 'volume', direction: 'up' } };

test('local command reaches one handler and socket permissions are private', async () => {
  const { storage, handler } = await setup();
  await sendRuntimeCommand(storage, request);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]?.[0]).toEqual(request);
  expect((await fs.stat(runtimeCommandPath(storage))).mode & 0o777).toBe(0o600);
});
test('a second server cannot unlink an active endpoint', async () => {
  const { storage, handler } = await setup();
  const other = new RuntimeCommandServer(storage, vi.fn());
  expect(await other.start()).toBe(false);
  await other.stop();
  await sendRuntimeCommand(storage, request);
  expect(handler).toHaveBeenCalledTimes(1);
});
test('raw requirements and oversized frames are rejected before dispatch', async () => {
  const { storage, handler } = await setup();
  await expect(sendRuntimeCommand(storage, { ...request, requirements: { power: true } } as never)).rejects.toThrow();
  await expect(sendRuntimeCommand(storage, { ...request, command: 'x'.repeat(17000) })).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});
test('shutdown aborts pending requests, removes its socket, and cannot reopen', async () => {
  let signal!: AbortSignal;
  const handler = vi.fn(async (_request, current: AbortSignal) => {
    signal = current; await new Promise<void>(() => undefined);
  });
  const { storage, server } = await setup(handler);
  const pending = expect(sendRuntimeCommand(storage, request)).rejects.toThrow();
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  const stopping = server.stop();
  expect(signal.aborted).toBe(true);
  await stopping; await pending;
  expect(signal.aborted).toBe(true);
  expect(await server.start()).toBe(false);
  await expect(fs.stat(runtimeCommandPath(storage))).rejects.toThrow();
});
test('timeout does not retransmit an uncertain IR command', async () => {
  let accepted!: () => void;
  const entered = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const { storage, handler } = await setup(vi.fn(async () => {
    accepted(); await new Promise<void>(() => undefined);
  }));
  vi.useFakeTimers();
  const pending = expect(sendRuntimeCommand(storage, request)).rejects.toThrow(/확인|응답/);
  await entered;
  await vi.advanceTimersByTimeAsync(15001);
  await pending;
  expect(handler).toHaveBeenCalledOnce();
});

test('unsupported platform or long socket paths disable only the optional command bridge', async () => {
  const windows = new RuntimeCommandServer('/tmp/hej-ipc', vi.fn(), 'win32');
  expect(await windows.start()).toBe(false);
  const long = new RuntimeCommandServer(`/tmp/${'x'.repeat(150)}`, vi.fn());
  expect(await long.start()).toBe(false);
});

test('an existing ordinary file is never removed as a stale socket', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-file-');
  await fs.mkdir(`${storage}/hejhome`, { recursive: true });
  await fs.writeFile(runtimeCommandPath(storage), 'preserve');
  const server = new RuntimeCommandServer(storage, vi.fn());
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  expect(await server.start()).toBe(false);
  expect(await fs.readFile(runtimeCommandPath(storage), 'utf8')).toBe('preserve');
});

test('multiple frames in one request never dispatch commands', async () => {
  const { storage, handler } = await setup();
  await new Promise<void>((resolve) => {
    const socket = net.createConnection(runtimeCommandPath(storage));
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, requestId: 'test-123', issuedAt: Date.now() })}\n{}\n`));
    socket.on('data', () => socket.destroy()); socket.on('close', () => resolve());
  });
  expect(handler).not.toHaveBeenCalled();
});


test('a stale socket from a dead process is recovered under the startup lock', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-stale-');
  await fs.mkdir(`${storage}/hejhome`, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['-e',
    'require(\'node:net\').createServer().listen(process.argv[1],()=>process.stdout.write(\'ready\'))', runtimeCommandPath(storage)]);
  await once(child.stdout, 'data');
  child.kill('SIGKILL'); await once(child, 'exit');
  const handler = vi.fn(async () => undefined);
  const server = new RuntimeCommandServer(storage, handler);
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  expect((await fs.lstat(runtimeCommandPath(storage))).isSocket()).toBe(true);
  expect(await server.start()).toBe(true);
  await sendRuntimeCommand(storage, request);
  expect(handler).toHaveBeenCalledOnce();
});

test('stop during startup never leaves a socket listening or reopens later', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-stop-');
  const server = new RuntimeCommandServer(storage, vi.fn());
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  const starting = server.start();
  await server.stop();
  expect(await starting).toBe(false);
  expect(server.available).toBe(false);
  expect(await server.start()).toBe(false);
  await expect(sendRuntimeCommand(storage, request)).rejects.toThrow();
});


test('duplicate request IDs never repeat a dispatched command', async () => {
  const { storage, handler } = await setup();
  const frame = JSON.stringify({ ...request, requestId: 'same-request', issuedAt: Date.now() });
  const send = () => new Promise<void>((resolve) => {
    const socket = net.createConnection(runtimeCommandPath(storage));
    socket.on('connect', () => socket.write(`${frame}\n`));
    socket.on('data', () => socket.destroy()); socket.on('error', () => socket.destroy()); socket.on('close', () => resolve());
  });
  await send(); await send();
  expect(handler).toHaveBeenCalledOnce();
});

test('a dead startup-lock owner is recovered but a live owner is preserved', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-owner-');
  const lock = `${runtimeCommandPath(storage)}.starting`;
  await fs.mkdir(lock, { recursive: true, mode: 0o700 });
  await fs.writeFile(`${lock}/owner.json`, JSON.stringify({ pid: process.pid }));
  const server = new RuntimeCommandServer(storage, vi.fn(async () => undefined));
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  expect(await server.start()).toBe(false);
  expect(JSON.parse(await fs.readFile(`${lock}/owner.json`, 'utf8')).pid).toBe(process.pid);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid!; await once(child, 'exit');
  await fs.writeFile(`${lock}/owner.json`, JSON.stringify({ pid: deadPid }));
  expect(await server.start()).toBe(true);
});


test('validation failures return a definite rejection instead of an uncertain acknowledgement', async () => {
  const { storage } = await setup(vi.fn(() => {
    throw new Error('private vendor detail');
  }));
  await expect(sendRuntimeCommand(storage, request)).rejects.toThrow('명령을 처리하지 못했습니다');
});

test('a dead recovery-lock owner can also be reclaimed without removing active owners', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-ipc-recover-');
  const lock = `${runtimeCommandPath(storage)}.starting`;
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = child.pid!; await once(child, 'exit');
  await fs.mkdir(`${lock}/recovering`, { recursive: true, mode: 0o700 });
  for (const dir of [lock, `${lock}/recovering`]) {
    await fs.writeFile(`${dir}/owner.json`, JSON.stringify({ pid: deadPid }));
  }
  const server = new RuntimeCommandServer(storage, vi.fn(async () => undefined));
  cleanups.push(async () => {
    await server.stop(); await fs.rm(storage, { recursive: true, force: true });
  });
  expect(await server.start()).toBe(true);
});
