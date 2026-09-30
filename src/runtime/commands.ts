import fs from 'node:fs/promises';
import net, { type Socket, type Server } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RuntimeCommandRequest {
  deviceId: string;
  kind: 'remote' | 'air-conditioner';
  command: unknown;
}
const MAX_FRAME = 16 * 1024;
const TIMEOUT = 15000;
const UNAVAILABLE = 'Homebridge의 기기 제어 연결을 사용할 수 없습니다. Homebridge 실행 상태를 확인해 주세요.';
const UNCERTAIN = '기기 응답을 확인하지 못했습니다. 같은 명령을 자동으로 다시 보내지 않았습니다.';

export function runtimeCommandPath(storagePath: string): string {
  return path.join(storagePath, 'hejhome', 'runtime.sock');
}
function supported(file: string, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && Buffer.byteLength(file) <= 100;
}
function validRequest(value: unknown): value is RuntimeCommandRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && typeof record.deviceId === 'string' && record.deviceId.length > 0
    && record.deviceId.length <= 256 && (record.kind === 'remote' || record.kind === 'air-conditioner') && Object.hasOwn(record, 'command');
}

export async function sendRuntimeCommand(storagePath: string, request: RuntimeCommandRequest): Promise<void> {
  const file = runtimeCommandPath(storagePath);
  if (!supported(file, process.platform)) {
    throw new Error(UNAVAILABLE);
  }
  if (!validRequest(request)) {
    throw new Error('지원하지 않는 기기 명령입니다.');
  }
  const requestId = randomUUID();
  const frame = `${JSON.stringify({ requestId, issuedAt: Date.now(), ...request })}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME) {
    throw new Error('기기 명령이 너무 큽니다.');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(file);
    let settled = false;
    let received = '';
    const timeout: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout.timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    timeout.timer = setTimeout(() => finish(new Error(UNCERTAIN)), TIMEOUT);
    socket.on('connect', () => socket.write(frame));
    socket.on('error', () => finish(new Error(UNAVAILABLE)));
    socket.on('close', () => finish(new Error(UNCERTAIN)));
    socket.on('data', (data: Buffer) => {
      received += data.toString('utf8');
      if (Buffer.byteLength(received) > MAX_FRAME) {
        finish(new Error(UNCERTAIN)); return;
      }
      if (!received.includes('\n')) {
        return;
      }
      try {
        const result = JSON.parse(received.trim()) as { requestId?: string; ok?: boolean; error?: string };
        if (result.requestId !== requestId || typeof result.ok !== 'boolean') {
          throw new Error();
        }
        finish(result.ok ? undefined : new Error(typeof result.error === 'string' ? result.error : UNCERTAIN));
      } catch {
        finish(new Error(UNCERTAIN));
      }
    });
  });
}

export class RuntimeCommandServer {
  private server: Server | null = null;
  private readonly sockets = new Map<Socket, AbortController>();
  private stopping = false;
  private starting: Promise<boolean> | null = null;
  private socketInode: number | undefined;
  private ready = false;
  private readonly recentRequests = new Map<string, number>();

  constructor(
    private readonly storagePath: string,
    private readonly execute: (request: RuntimeCommandRequest, signal: AbortSignal) => Promise<void>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get available(): boolean {
    return this.ready && !this.stopping;
  }

  start(): Promise<boolean> {
    if (this.stopping) {
      return Promise.resolve(false);
    }
    if (this.ready) {
      return Promise.resolve(true);
    }
    this.starting ??= this.bind().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async bind(): Promise<boolean> {
    const file = runtimeCommandPath(this.storagePath);
    if (!supported(file, this.platform)) {
      return false;
    }
    const directory = path.dirname(file);
    const lockPath = `${file}.starting`;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      // The lock contains its owner before its atomic rename makes it visible.
      releaseLock = await acquireStartupLock(lockPath);
      if (!releaseLock) {
        return false;
      }
      const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        } throw error;
      });
      if (existing) {
        if (!existing.isSocket() || await isListening(file)) {
          return false;
        }
        const current = await fs.lstat(file);
        if (current.ino !== existing.ino || !current.isSocket()) {
          return false;
        }
        await fs.unlink(file);
      }
      if (this.stopping) {
        return false;
      }
      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      server.on('error', () => {
        this.ready = false;
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(file, () => {
          server.off('error', reject); resolve();
        });
      });
      this.socketInode = (await fs.lstat(file)).ino;
      await fs.chmod(file, 0o600);
      server.on('error', () => {
        this.ready = false;
      });
      this.ready = !this.stopping;
      return this.ready;
    } catch {
      this.ready = false;
      if (this.server?.listening) {
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      }
      this.server = null;
      return false;
    } finally {
      await releaseLock?.();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    for (const [socket, controller] of this.sockets) {
      controller.abort();
      socket.destroy();
    }
    await this.starting;
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const file = runtimeCommandPath(this.storagePath);
    if (this.socketInode !== undefined) {
      const current = await fs.lstat(file).catch(() => null);
      if (current?.isSocket() && current.ino === this.socketInode) {
        await fs.unlink(file).catch(() => undefined);
      }
    }
  }

  private accept(socket: Socket): void {
    if (!this.available) {
      socket.destroy(); return;
    }
    const controller = new AbortController();
    this.sockets.set(socket, controller);
    const timer = setTimeout(() => socket.destroy(), TIMEOUT);
    let received = '';
    let dispatched = false;
    socket.on('close', () => {
      clearTimeout(timer); controller.abort(); this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (data: Buffer) => {
      if (dispatched) {
        socket.destroy(); return;
      }
      received += data.toString('utf8');
      if (Buffer.byteLength(received) > MAX_FRAME) {
        socket.destroy(); return;
      }
      if (!received.includes('\n')) {
        return;
      }
      dispatched = true;
      try {
        if (received.indexOf('\n') !== received.length - 1) {
          throw new Error();
        }
        const envelope = JSON.parse(received) as Record<string, unknown>;
        const { requestId, issuedAt, ...request } = envelope;
        if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || Date.now() - issuedAt > TIMEOUT || issuedAt - Date.now() > 1000) {
          throw new Error();
        }
        if (typeof requestId !== 'string' || requestId.length > 64 || !requestId || !validRequest(request)) {
          throw new Error();
        }
        const now = Date.now();
        for (const [id, at] of this.recentRequests) {
          if (now - at > 60000) {
            this.recentRequests.delete(id);
          }
        }
        if (this.recentRequests.has(requestId) || this.recentRequests.size >= 1024) {
          throw new Error();
        }
        this.recentRequests.set(requestId, now);
        const respond = (ok: boolean) => {
          if (!socket.destroyed) {
            socket.end(`${JSON.stringify({ requestId, ok, ...(ok ? {} : { error: '명령을 처리하지 못했습니다. 로그인과 기기 상태를 확인해 주세요.' }) })}\n`);
          }
        };
        void Promise.resolve().then(() => {
          if (this.stopping || controller.signal.aborted) {
            throw new Error('Command cancelled');
          }
          return this.execute(request, controller.signal);
        }).then(() => respond(true), () => respond(false));
      } catch {
        socket.destroy();
      }
    });
  }
}

async function isListening(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(file);
    const timeout: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (active: boolean) => {
      clearTimeout(timeout.timer); socket.destroy(); resolve(active);
    };
    timeout.timer = setTimeout(() => finish(true), 1000);
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
  });
}


async function acquireStartupLock(lockPath: string, depth = 0): Promise<(() => Promise<void>) | undefined> {
  if (depth > 16) {
    return undefined;
  }
  const candidate = `${lockPath}.${randomUUID()}`;
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  try {
    try {
      await fs.rename(candidate, lockPath);
    } catch {
      if (!await recoverStartupLock(lockPath, depth)) {
        return undefined;
      }
      await fs.rename(candidate, lockPath);
    }
    const owned = await fs.lstat(lockPath);
    return async () => {
      const current = await fs.lstat(lockPath).catch(() => null);
      if (current?.ino === owned.ino) {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    };
  } finally {
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

async function recoverStartupLock(lockPath: string, depth: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { pid?: number };
    if (!Number.isInteger(owner.pid) || !owner.pid || processAlive(owner.pid)) {
      return false;
    }
    // Recovery itself is a PID-owned lock, so a crash during recovery is recoverable too.
    const releaseRecovery = await acquireStartupLock(path.join(lockPath, 'recovering'), depth + 1);
    if (!releaseRecovery) {
      return false;
    }
    try {
      const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
      await fs.rename(lockPath, abandoned);
      await fs.rm(abandoned, { recursive: true, force: true });
      return true;
    } finally {
      await releaseRecovery();
    }
  } catch {
    return false;
  }
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
