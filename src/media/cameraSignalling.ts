import { randomUUID } from 'node:crypto';

const MAX_INBOUND_BYTES = 64 * 1024;
const MAX_OUTBOUND_BYTES = 8 * 1024;
const MAX_OFFER_SDP_BYTES = 6 * 1024; // Leaves room for credentials and routing in the 8 KiB envelope.
const MAX_ANSWER_SDP_BYTES = 16 * 1024;
const MAX_CANDIDATE_BYTES = 2048;
const MAX_CANDIDATES = 32;
const PUBLISH_TOPIC = 'mqtt.goqual.io';

type AccessRequest = { uid: string | number; unique_id: string; link_type: 'websocket'; topics: 'ipc' };
type IceServer = { urls: string; username?: string; credential?: string };

export interface CameraApi {
  getUserProfile(signal: AbortSignal): Promise<unknown>;
  getCameraDevices(signal: AbortSignal): Promise<unknown>;
  getWebrtcConfig(cameraId: string, signal: AbortSignal): Promise<unknown>;
  createWebrtcAccessConfig(body: AccessRequest, signal: AbortSignal): Promise<unknown>;
}

/** The broker login must be supplied independently; access-config credentials are payload fields. */
export interface AuthenticatedCameraTransport {
  connect(signal: AbortSignal): Promise<void>;
  subscribe(topic: string, onMessage: (raw: string) => void, signal: AbortSignal): Promise<void>;
  publish(topic: string, raw: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** A Node WebRTC implementation supplies dynamic SDP negotiation and media tracks. */
export interface CameraPeer {
  createOffer(iceServers: IceServer[], signal: AbortSignal): Promise<string>;
  setAnswer(sdp: string, signal: AbortSignal): Promise<void>;
  addCandidate(candidate: string, signal: AbortSignal): Promise<void>;
  onLocalCandidate(handler: (candidate: string) => void): void;
  close(): Promise<void>;
}

interface CameraSignallingOptions {
  cameraId: string;
  api: CameraApi;
  transport: AuthenticatedCameraTransport;
  peer: CameraPeer;
  ownerGeneration: number;
  getOwnerGeneration(): number;
  /** Must abort when the account owner/session changes, including while no message arrives. */
  ownerSignal: AbortSignal;
  sessionId?: () => string;
  deadlineMs?: number;
}

interface CameraConfig { motoId: string; auth: string; iceServers: IceServer[] }
interface AccessConfig { sourceTopic: string; sinkTopic: string; username: string; password: string; clientId: string }

/** An authenticated signalling session. It does not expose HomeKit media or a camera accessory. */
export class CameraSignallingSession {
  private readonly controller = new AbortController();
  private readonly sessionId: string;
  private readonly deadlineMs: number;
  private state: 'new' | 'starting' | 'ready' | 'closed' = 'new';
  private closePromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ownerAbort: (() => void) | undefined;
  private externalAbort: (() => void) | undefined;
  private externalSignal: AbortSignal | undefined;
  private transportUsed = false;
  private offerPublished = false;
  private answerReceived = false;
  private readonly pendingRemoteCandidates: string[] = [];
  private readonly pendingLocalCandidates: string[] = [];
  private readonly seenCandidates = new Set<string>();
  private readonly seenLocalCandidates = new Set<string>();
  private pendingMessages = 0;
  private candidatePublishQueue = Promise.resolve();
  private messageQueue = Promise.resolve();
  private answerPromise: Promise<void> | undefined;
  private resolveAnswer: (() => void) | undefined;
  private rejectAnswer: ((error: Error) => void) | undefined;
  private config: CameraConfig | undefined;
  private access: AccessConfig | undefined;
  private fromId = '';

  constructor(private readonly options: CameraSignallingOptions) {
    this.sessionId = (options.sessionId ?? randomUUID)();
    this.deadlineMs = options.deadlineMs ?? 15000;
    if (!isSafeId(options.cameraId) || !isSafeId(this.sessionId)
      || !Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0 || this.deadlineMs > 120000) {
      throw new Error('Invalid camera session configuration.');
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'new') {
      throw new Error('Camera session already started.');
    }
    if (this.options.ownerSignal.aborted || signal?.aborted) {
      await this.close();
      throw new Error('Camera session cancelled.');
    }
    try {
      this.assertOwner();
    } catch (error) {
      await this.close();
      throw publicError(error);
    }
    this.state = 'starting';
    this.externalSignal = signal;
    this.ownerAbort = () => {
      this.controller.abort();
      void this.close();
    };
    this.externalAbort = () => {
      this.controller.abort();
      void this.close();
    };
    this.options.ownerSignal.addEventListener('abort', this.ownerAbort, { once: true });
    signal?.addEventListener('abort', this.externalAbort, { once: true });
    if (this.options.ownerSignal.aborted || signal?.aborted) {
      this.controller.abort();
    }
    this.timer = setTimeout(() => this.controller.abort(), this.deadlineMs);
    try {
      this.assertLive();
      const profile = parseProfile(await this.awaitStep(this.options.api.getUserProfile(this.controller.signal)));
      this.assertLive();
      const camera = parseCamera(await this.awaitStep(this.options.api.getCameraDevices(this.controller.signal)), this.options.cameraId);
      this.assertLive();
      this.config = parseConfig(await this.awaitStep(this.options.api.getWebrtcConfig(camera.id, this.controller.signal)));
      this.assertLive();
      this.access = parseAccess(await this.awaitStep(this.options.api.createWebrtcAccessConfig({
        uid: profile.uid, unique_id: camera.uuid, link_type: 'websocket', topics: 'ipc',
      }, this.controller.signal)));
      this.fromId = this.access.sourceTopic.split('/').at(-1) ?? '';
      if (!isSafeId(this.fromId)) {
        throw new Error('Invalid camera signalling response.');
      }
      this.assertLive();
      this.transportUsed = true;
      await this.awaitTransport(this.options.transport.connect(this.controller.signal));
      this.assertLive();
      this.answerPromise = new Promise<void>((resolve, reject) => {
        this.resolveAnswer = resolve;
        this.rejectAnswer = reject;
      });
      void this.answerPromise.catch(() => undefined);
      await this.awaitTransport(this.options.transport.subscribe(this.access.sourceTopic,
        (raw) => this.enqueueMessage(raw), this.controller.signal));
      this.assertLive();
      this.options.peer.onLocalCandidate((candidate) => this.queueLocalCandidate(candidate));
      const offer = await this.awaitPeer(this.options.peer.createOffer(this.config.iceServers, this.controller.signal));
      this.assertLive();
      if (typeof offer !== 'string') {
        throw new Error('Invalid camera offer.');
      }
      const compactOffer = offer.replace(/\r?\na=extmap[^\r\n]*/g, '');
      if (Buffer.byteLength(compactOffer) > MAX_OFFER_SDP_BYTES) {
        throw new Error('Invalid camera offer.');
      }
      await this.publish('offer', { mode: 'webrtc', sdp: compactOffer, stream_type: 1, auth: this.config.auth });
      this.offerPublished = true;
      for (const candidate of this.pendingLocalCandidates.splice(0)) {
        this.enqueueCandidatePublish(candidate);
      }
      await this.awaitStep(this.candidatePublishQueue);
      this.assertLive();
      await this.awaitStep(this.answerPromise);
      this.assertLive();
      this.state = 'ready';
      this.clearDeadline();
    } catch (error) {
      await this.close();
      throw publicError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = Promise.resolve().then(async () => {
      this.state = 'closed';
      this.controller.abort();
      this.rejectAnswer?.(new Error('Camera session cancelled.'));
      this.clearDeadline();
      if (this.ownerAbort) {
        this.options.ownerSignal.removeEventListener('abort', this.ownerAbort);
      }
      if (this.externalAbort && this.externalSignal) {
        this.externalSignal.removeEventListener('abort', this.externalAbort);
      }
      if (this.offerPublished) {
        try {
          await waitAtMost(this.options.transport.publish(PUBLISH_TOPIC,
            this.envelope('disconnect', { mode: 'webrtc' }), AbortSignal.timeout(1000)), 1000);
        } catch { /* The session is closing even if its peer cannot receive disconnect. */ }
      }
      await Promise.allSettled([
        waitAtMost(Promise.resolve().then(() => this.options.peer.close()), 1000),
        this.transportUsed ? waitAtMost(Promise.resolve().then(() => this.options.transport.close()), 1000)
          : Promise.resolve(),
      ]);
      this.config = undefined;
      this.access = undefined;
    });
    return this.closePromise;
  }

  private assertOwner(): void {
    if (this.options.getOwnerGeneration() !== this.options.ownerGeneration) {
      throw new Error('Camera session owner changed.');
    }
  }

  private assertLive(): void {
    this.assertOwner();
    if (this.controller.signal.aborted || this.state === 'closed') {
      throw new Error('Camera session cancelled.');
    }
  }

  private clearDeadline(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async awaitStep<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) {
      throw new Error('Camera session cancelled.');
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('Camera session cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async awaitTransport<T>(work: Promise<T>): Promise<T> {
    void work.then(() => {
      if (this.state === 'closed') {
        void this.options.transport.close().catch(() => undefined);
      }
    }).catch(() => undefined);
    return this.awaitStep(work);
  }

  private async awaitPeer<T>(work: Promise<T>): Promise<T> {
    void work.then(() => {
      if (this.state === 'closed') {
        void this.options.peer.close().catch(() => undefined);
      }
    }).catch(() => undefined);
    return this.awaitStep(work);
  }

  private enqueueMessage(raw: string): void {
    if (this.state === 'closed') {
      return;
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_INBOUND_BYTES || this.pendingMessages >= 64) {
      this.rejectAnswer?.(new Error('Invalid camera signalling message.'));
      void this.close();
      return;
    }
    this.pendingMessages++;
    this.messageQueue = this.messageQueue.then(() => this.processMessage(raw)).catch((error) => {
      this.rejectAnswer?.(publicError(error));
      void this.close();
    }).finally(() => {
      this.pendingMessages--;
    });
  }

  private async processMessage(raw: string): Promise<void> {
    this.assertLive();
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_INBOUND_BYTES) {
      throw new Error('Invalid camera signalling message.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid camera signalling message.');
    }
    const data = object(object(parsed).data);
    const header = object(data.header);
    if (header.sessionid !== this.sessionId || (header.from !== undefined && header.from !== this.options.cameraId)
      || (header.to !== undefined && header.to !== this.fromId)) {
      return;
    }
    const msg = object(data.msg);
    if (header.type === 'answer') {
      if (this.answerReceived) {
        return;
      }
      if (typeof msg.sdp !== 'string' || !msg.sdp || Buffer.byteLength(msg.sdp) > MAX_ANSWER_SDP_BYTES) {
        throw new Error('Invalid camera answer.');
      }
      await this.awaitPeer(this.options.peer.setAnswer(msg.sdp, this.controller.signal));
      this.assertLive();
      this.answerReceived = true;
      for (const candidate of this.pendingRemoteCandidates.splice(0)) {
        await this.awaitPeer(this.options.peer.addCandidate(candidate, this.controller.signal));
      }
      this.resolveAnswer?.();
    } else if (header.type === 'candidate') {
      const candidate = normalizeCandidate(msg.candidate);
      if (this.seenCandidates.has(candidate)) {
        return;
      }
      this.seenCandidates.add(candidate);
      if (this.seenCandidates.size > MAX_CANDIDATES) {
        throw new Error('Too many camera candidates.');
      }
      if (this.answerReceived) {
        await this.awaitPeer(this.options.peer.addCandidate(candidate, this.controller.signal));
      } else {
        this.pendingRemoteCandidates.push(candidate);
      }
    } else if (header.type === 'disconnect') {
      throw new Error('Camera disconnected.');
    }
  }

  private queueLocalCandidate(raw: string): void {
    if (this.state === 'closed') {
      return;
    }
    try {
      const candidate = normalizeCandidate(raw);
      if (this.seenLocalCandidates.has(candidate)) {
        return;
      }
      if (this.seenLocalCandidates.size >= MAX_CANDIDATES) {
        throw new Error('Too many camera candidates.');
      }
      this.seenLocalCandidates.add(candidate);
      if (this.offerPublished) {
        this.enqueueCandidatePublish(candidate);
      } else if (this.pendingLocalCandidates.length < MAX_CANDIDATES) {
        this.pendingLocalCandidates.push(candidate);
      } else {
        throw new Error('Too many camera candidates.');
      }
    } catch (error) {
      this.rejectAnswer?.(publicError(error));
      void this.close();
    }
  }

  private enqueueCandidatePublish(candidate: string): void {
    this.candidatePublishQueue = this.candidatePublishQueue.then(async () => {
      if (this.state === 'closed' || this.controller.signal.aborted) {
        return;
      }
      await this.publish('candidate', { mode: 'webrtc', candidate: `a=${candidate}` });
    }).catch((error) => {
      this.rejectAnswer?.(publicError(error));
      void this.close();
    });
  }

  private envelope(type: string, msg: Record<string, unknown>): string {
    const config = this.config;
    const access = this.access;
    if (!config || !access) {
      throw new Error('Camera signalling is not ready.');
    }
    const value = {
      protocol: 302, pv: '2.2', t: Math.floor(Date.now() / 1000),
      data: { header: { type, from: this.fromId, to: this.options.cameraId, sub_dev_id: '',
        sessionid: this.sessionId, moto_id: config.motoId }, msg },
      source_topic: access.sourceTopic,
      sink_topic: access.sinkTopic.replace('moto_id', config.motoId).replace('{device_id}', this.options.cameraId),
      userName: access.username, password: access.password, client_id: access.clientId,
    };
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_OUTBOUND_BYTES) {
      throw new Error('Camera signalling message too large.');
    }
    return raw;
  }

  private async publish(type: string, msg: Record<string, unknown>): Promise<void> {
    this.assertLive();
    await this.awaitTransport(this.options.transport.publish(PUBLISH_TOPIC, this.envelope(type, msg), this.controller.signal));
    this.assertLive();
  }
}

function parseProfile(raw: unknown): { uid: string | number } {
  const member = object(raw).member;
  const uid = Array.isArray(member) ? object(member[0]).uid : undefined;
  if (!(typeof uid === 'number' && Number.isFinite(uid)) && !(typeof uid === 'string' && uid.trim())) {
    throw new Error('Invalid camera profile.');
  }
  return { uid: uid as string | number };
}

function parseCamera(raw: unknown, id: string): { id: string; uuid: string } {
  const match = Array.isArray(raw) ? raw.find((entry) => isRecord(entry) && entry.id === id) : undefined;
  if (!isRecord(match) || !isSafeId(match.id) || !isSafeId(match.uuid)) {
    throw new Error('Camera not found.');
  }
  return { id: match.id, uuid: match.uuid };
}

function parseConfig(raw: unknown): CameraConfig {
  const data = object(raw);
  const p2p = object(data.p2p_config);
  if (!isSafeId(data.moto_id) || !isBoundedString(data.auth, 2048)
    || !Array.isArray(p2p.ices) || p2p.ices.length > 16) {
    throw new Error('Invalid camera WebRTC configuration.');
  }
  const iceServers = p2p.ices.map((entry) => {
    const server = object(entry);
    if (!isBoundedString(server.urls, 512) || !/^(stun|stuns|turn|turns):/i.test(server.urls)) {
      throw new Error('Invalid camera ICE server.');
    }
    const ice: IceServer = { urls: server.urls };
    if (server.username !== undefined) {
      if (!isBoundedString(server.username, 512)) {
        throw new Error('Invalid camera ICE server.');
      }
      ice.username = server.username;
    }
    if (server.credential !== undefined) {
      if (!isBoundedString(server.credential, 2048)) {
        throw new Error('Invalid camera ICE server.');
      }
      ice.credential = server.credential;
    }
    return ice;
  }).filter((server) => !server.urls.includes('tuya'));
  return { motoId: data.moto_id, auth: data.auth, iceServers };
}

function parseAccess(raw: unknown): AccessConfig {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid camera access configuration.');
    }
  }
  const data = object(parsed);
  const sourceTopic = object(data.source_topic).ipc;
  const sinkTopic = object(data.sink_topic).ipc;
  if (!isBoundedString(sourceTopic, 512) || !isBoundedString(sinkTopic, 512)
    || !isBoundedString(data.username, 512) || !isBoundedString(data.password, 2048)
    || !isBoundedString(data.client_id, 512)) {
    throw new Error('Invalid camera access configuration.');
  }
  return { sourceTopic, sinkTopic, username: data.username, password: data.password, clientId: data.client_id };
}

function normalizeCandidate(raw: unknown): string {
  if (!isBoundedString(raw, MAX_CANDIDATE_BYTES)) {
    throw new Error('Invalid camera candidate.');
  }
  const candidate = raw.replace(/^a=/, '').replace(/\r?\n$/, '');
  if (!candidate.startsWith('candidate:') || Buffer.byteLength(candidate) > MAX_CANDIDATE_BYTES) {
    throw new Error('Invalid camera candidate.');
  }
  return candidate;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function object(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error('Invalid camera signalling response.');
  }
  return raw;
}

function isBoundedString(raw: unknown, max: number): raw is string {
  return typeof raw === 'string' && raw.length > 0 && Buffer.byteLength(raw) <= max;
}

function isSafeId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[a-zA-Z0-9_.:{}-]{1,128}$/.test(raw);
}

function publicError(error: unknown): Error {
  if (error instanceof Error && /^(Camera session cancelled|Camera session owner changed)\.$/.test(error.message)) {
    return new Error(error.message);
  }
  return new Error('Camera signalling failed.');
}

async function waitAtMost(work: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    })]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
