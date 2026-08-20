import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Реконнект и resync после рестарта бэкенда (инцидент 20.08: клиенты с
 * reconnectionAttempts=5 оставались без realtime до F5).
 *
 * Проверяем разделение: сокет и вход в комнаты — сразу, тяжёлый REST-resync —
 * один раз, со случайной задержкой и только при живом сокете.
 */

type Handler = (...args: unknown[]) => void;

interface IFakeSocket {
  connected: boolean;
  on: (event: string, cb: Handler) => IFakeSocket;
  once: (event: string, cb: Handler) => IFakeSocket;
  off: (event: string, cb: Handler) => IFakeSocket;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fire: (event: string) => void;
}

const sockets: IFakeSocket[] = [];

const makeSocket = (): IFakeSocket => {
  const handlers = new Map<string, Set<Handler>>();
  const socket: IFakeSocket = {
    connected: false,
    on(event, cb) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(cb);
      handlers.set(event, set);
      return socket;
    },
    once(event, cb) {
      const wrapped: Handler = (...args) => {
        handlers.get(event)?.delete(wrapped);
        cb(...args);
      };
      return socket.on(event, wrapped);
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb);
      return socket;
    },
    emit: vi.fn(),
    connect: vi.fn(() => {
      socket.connected = true;
      socket.fire('connect');
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
      socket.fire('disconnect');
    }),
    fire(event) {
      [...(handlers.get(event) ?? [])].forEach(cb => cb());
    },
  };
  return socket;
};

vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = makeSocket();
    sockets.push(socket);
    return socket;
  },
}));

vi.mock('../api/client', () => ({ API_ORIGIN: 'http://localhost:3001' }));

const loadService = async () => {
  vi.resetModules();
  sockets.length = 0;
  const mod = await import('./websocket');
  return mod.wsService;
};

/** Поднять сокет и дождаться первичного connect (он resync не запускает). */
const connectService = async (service: Awaited<ReturnType<typeof loadService>>) => {
  service.connect('token-1', 'test');
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  const socket = sockets[0];
  socket.connected = true;
  socket.fire('connect');
  return socket;
};

describe('wsService: resync после реконнекта', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // задержка 2500 мс
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('первичный connect не запускает ни rejoin, ни resync', async () => {
    const service = await loadService();
    const rejoin = vi.fn();
    const resync = vi.fn();
    service.onReconnect(rejoin);
    service.onResync(resync);

    await connectService(service);
    vi.advanceTimersByTime(10_000);

    expect(rejoin).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it('переподключение: rejoin сразу, resync — после задержки, по одному разу', async () => {
    const service = await loadService();
    const rejoin = vi.fn();
    const resync = vi.fn();
    service.onReconnect(rejoin);
    service.onResync(resync);

    const socket = await connectService(service);
    socket.disconnect();
    socket.connect();

    expect(rejoin).toHaveBeenCalledTimes(1);
    expect(resync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2499);
    expect(resync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('новый обрыв отменяет отложенный resync', async () => {
    const service = await loadService();
    const resync = vi.fn();
    service.onResync(resync);

    const socket = await connectService(service);
    socket.disconnect();
    socket.connect();

    vi.advanceTimersByTime(1000);
    socket.disconnect();
    vi.advanceTimersByTime(10_000);

    expect(resync).not.toHaveBeenCalled();
  });

  it('после двух подряд переподключений resync выполняется один раз', async () => {
    const service = await loadService();
    const resync = vi.fn();
    service.onResync(resync);

    const socket = await connectService(service);
    socket.disconnect();
    socket.connect();
    vi.advanceTimersByTime(1000);
    socket.disconnect();
    socket.connect();

    vi.advanceTimersByTime(10_000);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('ошибка одного обработчика не мешает остальным', async () => {
    const service = await loadService();
    const failing = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    service.onResync(failing);
    service.onResync(ok);

    const socket = await connectService(service);
    socket.disconnect();
    socket.connect();
    vi.advanceTimersByTime(10_000);

    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('reconnectIfNeeded поднимает отключённый сокет и не трогает подключённый', async () => {
    const service = await loadService();
    const socket = await connectService(service);

    service.reconnectIfNeeded();
    expect(socket.connect).not.toHaveBeenCalled();

    socket.disconnect();
    service.reconnectIfNeeded();
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });
});
