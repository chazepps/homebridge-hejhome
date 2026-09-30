import { describe, expect, test, vi } from 'vitest';
import { CameraSignallingSession, type CameraApi, type CameraPeer, type AuthenticatedCameraTransport } from '../src/media/cameraSignalling.js';

function fixture(overrides: { deadlineMs?: number; ownerSignal?: AbortSignal; getOwnerGeneration?: () => number } = {}) {
  const api: CameraApi = {
    getUserProfile: vi.fn(async () => ({ member: [{ uid: 42 }] })),
    getCameraDevices: vi.fn(async () => [{ id: 'cam-1', uuid: 'uuid-1' }]),
    getWebrtcConfig: vi.fn(async () => ({ moto_id: 'moto-1', auth: 'offer-auth',
      p2p_config: { ices: [{ urls: 'stun:stun.example.test' }, { urls: 'stun:tuya.example.test' }] } })),
    createWebrtcAccessConfig: vi.fn(async () => JSON.stringify({
      source_topic: { ipc: 'source/ipc/source-1' }, sink_topic: { ipc: 'sink/moto_id/{device_id}' },
      username: 'session-user', password: 'session-pass', client_id: 'session-client',
    })),
  };
  let onMessage: ((raw: string) => void) | undefined;
  const transport: AuthenticatedCameraTransport = {
    connect: vi.fn(async () => undefined),
    subscribe: vi.fn(async (_topic, handler) => {
      onMessage = handler;
    }),
    publish: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  let onCandidate: ((candidate: string) => void) | undefined;
  const peer: CameraPeer = {
    createOffer: vi.fn(async () => 'v=0\r\na=extmap:1 something\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'),
    setAnswer: vi.fn(async () => undefined),
    addCandidate: vi.fn(async () => undefined),
    onLocalCandidate: vi.fn((handler) => {
      onCandidate = handler;
    }),
    close: vi.fn(async () => undefined),
  };
  const owner = new AbortController();
  const session = new CameraSignallingSession({ cameraId: 'cam-1', api, transport, peer,
    ownerGeneration: 7, getOwnerGeneration: overrides.getOwnerGeneration ?? (() => 7),
    ownerSignal: overrides.ownerSignal ?? owner.signal, sessionId: () => 'session-1',
    deadlineMs: overrides.deadlineMs ?? 2000 });
  const receive = (type: string, msg: Record<string, unknown>, sessionid = 'session-1') => {
    onMessage?.(JSON.stringify({ data: { header: { type, from: 'cam-1', to: 'source-1', sessionid }, msg } }));
  };
  return { session, api, transport, peer, owner, receive,
    localCandidate: (candidate: string) => onCandidate?.(candidate) };
}

describe('authenticated Hejhome camera signalling boundary', () => {
  test('validates REST responses and publishes a bounded video offer with the vendor envelope', async () => {
    const { session, api, transport, peer, receive } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    expect(api.createWebrtcAccessConfig).toHaveBeenCalledWith({
      uid: 42, unique_id: 'uuid-1', link_type: 'websocket', topics: 'ipc',
    }, expect.any(AbortSignal));
    expect(transport.subscribe).toHaveBeenCalledWith('source/ipc/source-1', expect.any(Function), expect.any(AbortSignal));
    expect(peer.createOffer).toHaveBeenCalledWith([{ urls: 'stun:stun.example.test' }], expect.any(AbortSignal));
    const [topic, raw] = vi.mocked(transport.publish).mock.calls[0]!;
    expect(topic).toBe('mqtt.goqual.io');
    expect(JSON.parse(raw)).toMatchObject({ protocol: 302, pv: '2.2',
      data: { header: { type: 'offer', from: 'source-1', to: 'cam-1', sessionid: 'session-1', moto_id: 'moto-1' },
        msg: { mode: 'webrtc', stream_type: 1, auth: 'offer-auth', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' } },
      source_topic: 'source/ipc/source-1', sink_topic: 'sink/moto-1/cam-1',
      userName: 'session-user', password: 'session-pass', client_id: 'session-client' });
    receive('answer', { sdp: 'v=0\r\n' });
    await starting;
    expect(peer.setAnswer).toHaveBeenCalledExactlyOnceWith('v=0\r\n', expect.any(AbortSignal));
    await session.close();
  });

  test('ignores another session and duplicate answers, queues candidates until its answer', async () => {
    const { session, transport, peer, receive, localCandidate } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    receive('candidate', { candidate: 'a=candidate:abc\r\n' }, 'wrong-session');
    receive('candidate', { candidate: 'a=candidate:good\r\n' });
    expect(peer.addCandidate).not.toHaveBeenCalled();
    receive('answer', { sdp: 'v=0\r\n' }, 'wrong-session');
    receive('answer', { sdp: 'v=0\r\n' });
    receive('answer', { sdp: 'duplicate' });
    await starting;
    await vi.waitFor(() => expect(peer.addCandidate).toHaveBeenCalledExactlyOnceWith('candidate:good', expect.any(AbortSignal)));
    expect(peer.setAnswer).toHaveBeenCalledTimes(1);
    localCandidate('candidate:local');
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(2));
    const candidate = JSON.parse(vi.mocked(transport.publish).mock.calls[1]![1]);
    expect(candidate.data.msg.candidate).toBe('a=candidate:local');
    await session.close();
  });

  test('abort during a pending subscription rejects start and closes the late transport too', async () => {
    const { session, transport, peer, owner } = fixture();
    let release!: () => void;
    vi.mocked(transport.subscribe).mockImplementationOnce(async () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const starting = session.start();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    owner.abort();
    await expect(starting).rejects.toThrow();
    expect(peer.close).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(2));
  });

  test('deadline and already-aborted owner both stop before an answer', async () => {
    const timed = fixture({ deadlineMs: 30 });
    await expect(timed.session.start()).rejects.toThrow();
    expect(timed.transport.close).toHaveBeenCalled();
    const owner = new AbortController(); owner.abort();
    const aborted = fixture({ ownerSignal: owner.signal });
    await expect(aborted.session.start()).rejects.toThrow();
    expect(aborted.api.getUserProfile).not.toHaveBeenCalled();
    expect(aborted.peer.close).toHaveBeenCalledTimes(1);
  });

  test('owner generation change rejects late REST completion before transport use', async () => {
    let generation = 7;
    const { session, api, transport } = fixture({ getOwnerGeneration: () => generation });
    let release!: (value: unknown) => void;
    vi.mocked(api.getWebrtcConfig).mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const starting = session.start();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    generation = 8;
    release({ moto_id: 'moto-1', auth: 'offer-auth', p2p_config: { ices: [] } });
    await expect(starting).rejects.toThrow();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  test('owner cancellation propagates to the in-flight REST operation', async () => {
    const { session, api, transport, owner } = fixture();
    let requestAborted = false;
    vi.mocked(api.getWebrtcConfig).mockImplementationOnce((_id, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        requestAborted = true;
        reject(new Error('request cancelled'));
      }, { once: true });
    }));
    const starting = session.start();
    await vi.waitFor(() => expect(api.getWebrtcConfig).toHaveBeenCalled());
    owner.abort();
    await expect(starting).rejects.toThrow();
    expect(requestAborted).toBe(true);
    expect(transport.connect).not.toHaveBeenCalled();
  });

  test('rejects malformed access credentials without echoing sensitive values', async () => {
    const { session, api, transport } = fixture();
    vi.mocked(api.createWebrtcAccessConfig).mockResolvedValueOnce('{"password":"private-marker"}');
    const error = await session.start().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('private-marker');
    expect(transport.connect).not.toHaveBeenCalled();
  });

  test('bounds incoming payload, SDP, candidate, and candidate queue', async () => {
    const { session, transport, peer, receive } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    receive('candidate', { candidate: 'a=' + 'x'.repeat(5000) });
    await expect(starting).rejects.toThrow();
    expect(peer.close).toHaveBeenCalled();
  });

  test('owner abort closes an otherwise idle ready session immediately', async () => {
    const { session, transport, peer, owner, receive } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    receive('answer', { sdp: 'v=0\r\n' });
    await starting;
    owner.abort();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(1));
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  test('rejects an oversized incoming message before it can fill the processing queue', async () => {
    const { session, transport, peer } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    const handler = vi.mocked(transport.subscribe).mock.calls[0]![1];
    handler('x'.repeat(65537));
    await expect(starting).rejects.toThrow();
    expect(peer.close).toHaveBeenCalled();
  });

  test('caps queued incoming messages before async parsing can catch up', async () => {
    const { session, transport } = fixture();
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    const handler = vi.mocked(transport.subscribe).mock.calls[0]![1];
    const unrelated = JSON.stringify({ data: { header: { type: 'candidate', sessionid: 'other' }, msg: {} } });
    for (let i = 0; i < 65; i++) {
      handler(unrelated);
    }
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled(), { timeout: 300 });
    await rejected;
  });

  test('caps unique remote candidates before an answer', async () => {
    const { session, transport, peer, receive } = fixture();
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 33; i++) {
      receive('candidate', { candidate: `a=candidate:remote-${i}` });
    }
    await rejected;
    expect(peer.addCandidate).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });

  test('abort releases a peer answer that never settles', async () => {
    const { session, transport, peer, owner, receive } = fixture();
    vi.mocked(peer.setAnswer).mockImplementationOnce(() => new Promise<void>(() => undefined));
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    receive('answer', { sdp: 'v=0\r\n' });
    await vi.waitFor(() => expect(peer.setAnswer).toHaveBeenCalled());
    owner.abort();
    await rejected;
    expect(peer.close).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });

  test('late offer completion after cancellation closes the peer again', async () => {
    const { session, peer, transport, owner } = fixture();
    let release!: (value: string) => void;
    vi.mocked(peer.createOffer).mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    owner.abort();
    await rejected;
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    release('v=0\r\n');
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(2));
  });

  test('rejects unbounded ICE lists before transport connection', async () => {
    const { session, api, transport } = fixture();
    vi.mocked(api.getWebrtcConfig).mockResolvedValueOnce({ moto_id: 'moto-1', auth: 'offer-auth',
      p2p_config: { ices: Array.from({ length: 17 }, () => ({ urls: 'stun:stun.example.test' })) } });
    await expect(session.start()).rejects.toThrow();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  test('deadline during a slow publish closes transport again after late completion', async () => {
    const { session, transport } = fixture({ deadlineMs: 30 });
    let release!: () => void;
    vi.mocked(transport.publish).mockImplementationOnce(async () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await expect(session.start()).rejects.toThrow();
    expect(release).toBeTypeOf('function');
    expect(transport.close).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(2));
  });

  test('close continues resource cleanup when the disconnect publish never settles', async () => {
    const { session, transport, peer, receive } = fixture();
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    receive('answer', { sdp: 'v=0\r\n' });
    await starting;
    vi.mocked(transport.publish).mockImplementationOnce(() => new Promise<void>(() => undefined));
    const closed = await Promise.race([
      session.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200)),
    ]);
    expect(closed).toBe(true);
    expect(peer.close).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });

  test('rejects a burst of local candidates beyond the session limit', async () => {
    const { session, transport, localCandidate } = fixture();
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 33; i++) {
      localCandidate(`candidate:local-${i}`);
    }
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled(), { timeout: 300 });
    await rejected;
    const candidates = vi.mocked(transport.publish).mock.calls
      .map(([, raw]) => JSON.parse(raw) as { data: { header: { type: string } } })
      .filter((message) => message.data.header.type === 'candidate');
    expect(candidates.length).toBeLessThanOrEqual(32);
  });

  test('publishes local ICE candidates serially and drops queued work after close', async () => {
    const { session, transport, receive, localCandidate } = fixture();
    let active = 0;
    let maximumActive = 0;
    let candidatePublishes = 0;
    vi.mocked(transport.publish).mockImplementation(async (_topic, raw) => {
      const message = JSON.parse(raw) as { data: { header: { type: string } } };
      if (message.data.header.type !== 'candidate') {
        return;
      }
      candidatePublishes++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    const starting = session.start();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 12; i++) {
      localCandidate(`candidate:burst-${i}`);
    }
    await vi.waitFor(() => expect(candidatePublishes).toBe(12));
    expect(maximumActive).toBe(1);
    receive('answer', { sdp: 'v=0\r\n' });
    await starting;
    await session.close();
  });

  test('owner cancellation drops local candidates waiting behind a stalled publish', async () => {
    const { session, transport, owner, localCandidate } = fixture();
    let release!: () => void;
    let candidateCalls = 0;
    vi.mocked(transport.publish).mockImplementation(async (_topic, raw) => {
      const message = JSON.parse(raw) as { data: { header: { type: string } } };
      if (message.data.header.type !== 'candidate') {
        return;
      }
      candidateCalls++;
      if (candidateCalls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const starting = session.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) {
      localCandidate(`candidate:queued-${i}`);
    }
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    owner.abort();
    await rejected;
    release();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(2));
    expect(candidateCalls).toBe(1);
  });
});
