import type { Socket } from 'socket.io-client';
import { API_ORIGIN } from '../api/client';

type MessageHandler = (payload: unknown) => void;
type SocketModule = typeof import('socket.io-client');

class WebSocketService {
  private socket: Socket | null = null;

  private connectPromise: Promise<void> | null = null;

  private currentToken: string | null = null;

  private connectVersion = 0;

  private listeners = new Map<string, Set<MessageHandler>>();

  private owners = new Map<string, string>();

  connect(token: string, owner = 'default'): void {
    this.owners.set(owner, token);

    if (this.currentToken === token && (this.socket || this.connectPromise)) {
      return;
    }

    void this.establishConnection(token);
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
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 16000,
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
