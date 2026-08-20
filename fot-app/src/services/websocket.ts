import type { Socket } from 'socket.io-client';
import { API_ORIGIN } from '../api/client';

type MessageHandler = (payload: unknown) => void;
type SocketModule = typeof import('socket.io-client');

// Разброс тяжёлого resync после переподключения. Рестарт бэкенда возвращает
// все вкладки разом, и синхронный залп /auth/me + presence + чат + refetch
// пришёлся бы на первые секунды жизни холодного процесса. Сам сокет и вход в
// комнату чата не откладываются — задерживается только REST-догрузка.
const RESYNC_MAX_DELAY_MS = 5000;

// Один упавший обработчик не должен отменить остальные: подписчики независимы.
const runSafely = (callback: () => void): void => {
  try {
    callback();
  } catch {
    // Ошибку своего resync каждый подписчик обрабатывает сам.
  }
};

class WebSocketService {
  private socket: Socket | null = null;

  private connectPromise: Promise<void> | null = null;

  private currentToken: string | null = null;

  private connectVersion = 0;

  private listeners = new Map<string, Set<MessageHandler>>();

  private owners = new Map<string, string>();

  private lifecycleBound = false;

  private reconnectListeners = new Set<() => void>();

  private resyncListeners = new Set<() => void>();

  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  connect(token: string, owner = 'default'): void {
    this.owners.set(owner, token);
    this.bindLifecycleListeners();

    if (this.currentToken === token && (this.socket || this.connectPromise)) {
      return;
    }

    void this.establishConnection(token);
  }

  /**
   * Поднять сокет, если он есть, но не подключён. socket.connect() безопасен и
   * когда реконнект уже идёт. Проверять socket.active нельзя: после
   * reconnect_failed он остаётся true, и метод бы ничего не делал.
   */
  reconnectIfNeeded(): void {
    if (this.socket) {
      if (!this.socket.connected) {
        this.socket.connect();
      }
      return;
    }

    if (this.connectPromise) return;

    const token = this.currentToken;
    if (!token || !this.hasOwnerForToken(token)) return;
    void this.establishConnection(token);
  }

  /**
   * Возврат вкладки и восстановление сети — моменты, когда браузер мог усыпить
   * таймеры реконнекта. Слушатели вешаются один раз на сервис, а не на
   * компоненты: иначе поведение зависело бы от того, что смонтировано.
   */
  private bindLifecycleListeners(): void {
    if (this.lifecycleBound || typeof window === 'undefined') return;
    this.lifecycleBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.reconnectIfNeeded();
      }
    });
    window.addEventListener('online', () => {
      this.reconnectIfNeeded();
    });
  }

  private async loadSocketModule(): Promise<SocketModule> {
    return import('socket.io-client');
  }

  private async establishConnection(token: string): Promise<void> {
    if (this.currentToken === token && (this.socket || this.connectPromise)) {
      await this.connectPromise;
      return;
    }

    this.connectVersion += 1;
    const version = this.connectVersion;
    this.currentToken = token;

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.connectPromise = (async () => {
      const { io } = await this.loadSocketModule();

      if (version !== this.connectVersion || !this.hasOwnerForToken(token)) {
        return;
      }

      const nextSocket = io(API_ORIGIN, {
        auth: { token },
        // websocket первым (nginx проксирует Upgrade): без polling-хендшейка
        // и без удержания HTTP-коннекта long-polling'ом. polling — только fallback.
        transports: ['websocket', 'polling'],
        reconnection: true,
        // Бесконечно: с 5 попытками (~15 с) рестарт бэкенда оставлял вкладку
        // без realtime до F5. Потолок паузы 30 с — чтобы на 1500 клиентах
        // долгий простой не превращался в постоянный поток попыток.
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
      });

      // Переподключение существующего сокета (рестарт бэкенда, обрыв сети).
      // Отличаем от первичного connect: подписчикам нужен resync только там,
      // где события могли потеряться, а на старте данные и так загружаются.
      let connectedOnce = false;
      nextSocket.on('connect', () => {
        if (connectedOnce) {
          // Немедленно: вернуть подписки сокета (комнаты чата) — без них
          // сообщения не придут, а ждать джиттер тут нечего.
          this.reconnectListeners.forEach(runSafely);
          this.scheduleResync();
        }
        connectedOnce = true;
      });
      // Новый обрыв отменяет отложенный resync: тянуть данные в мёртвый сокет
      // бессмысленно, следующий connect запланирует новый.
      nextSocket.on('disconnect', () => {
        this.cancelResync();
      });

      this.attachAllListeners(nextSocket);
      this.socket = nextSocket;

      await new Promise<void>(resolve => {
        const finish = () => {
          nextSocket.off('connect', finish);
          nextSocket.off('connect_error', finish);
          resolve();
        };

        nextSocket.once('connect', finish);
        nextSocket.once('connect_error', finish);
      });
    })().finally(() => {
      if (version === this.connectVersion) {
        this.connectPromise = null;
      }
    });

    await this.connectPromise;
  }

  private attachAllListeners(socket: Socket): void {
    for (const [type, callbacks] of this.listeners.entries()) {
      callbacks.forEach(callback => {
        socket.on(type, callback);
      });
    }
  }

  private hasOwnerForToken(token: string): boolean {
    return [...this.owners.values()].some(ownerToken => ownerToken === token);
  }

  send(type: string, payload: unknown, callback?: (response: unknown) => void): void {
    if (!this.socket?.connected) return;
    if (callback) {
      this.socket.emit(type, payload, callback);
    } else {
      this.socket.emit(type, payload);
    }
  }

  /**
   * Подписка на ПЕРЕподключение сокета (не на первичное), вызывается сразу.
   * Только для лёгких действий по самому сокету — вход в комнаты.
   */
  onReconnect(callback: () => void): () => void {
    this.reconnectListeners.add(callback);
    return () => {
      this.reconnectListeners.delete(callback);
    };
  }

  /**
   * Подписка на тяжёлый resync после переподключения: вызывается один раз со
   * случайной задержкой 0–5 с и только если сокет к тому моменту всё ещё
   * подключён. События, отправленные бэкендом за время отключения, не доедут —
   * данные приходится перечитывать, но не всем вкладкам одновременно.
   */
  onResync(callback: () => void): () => void {
    this.resyncListeners.add(callback);
    return () => {
      this.resyncListeners.delete(callback);
    };
  }

  private scheduleResync(): void {
    this.cancelResync();
    const delay = Math.floor(Math.random() * RESYNC_MAX_DELAY_MS);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.socket?.connected) return;
      this.resyncListeners.forEach(runSafely);
    }, delay);
  }

  private cancelResync(): void {
    if (this.resyncTimer === null) return;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }

  on(type: string, callback: MessageHandler): () => void {
    const callbacks = this.listeners.get(type) ?? new Set<MessageHandler>();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);

    if (this.socket) {
      this.socket.on(type, callback);
    }

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.listeners.delete(type);
      }
      this.socket?.off(type, callback);
    };
  }

  disconnect(owner = 'default'): void {
    this.owners.delete(owner);
    if (this.owners.size > 0) {
      return;
    }

    this.connectVersion += 1;
    this.currentToken = null;
    this.connectPromise = null;
    this.cancelResync();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const wsService = new WebSocketService();
