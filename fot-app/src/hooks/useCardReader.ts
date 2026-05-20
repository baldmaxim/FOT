import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Список адресов локального WS-агента (Sigur Reader EH или Sphinx Reader Agent).
 * Пробуем по очереди (round-robin при close): на Windows браузер может резолвить
 * `localhost` в IPv6 `::1`, тогда как часть инсталляций агента слушает только
 * IPv4 `127.0.0.1`. Перебор покрывает оба варианта без правок агента.
 */
export const SKUD_AGENT_WS_URLS = [
  'ws://127.0.0.1:8765',
  'ws://localhost:8765',
] as const;

export interface ICardEvent {
  w26: string;
  sigurCard: string;
  hexUid: string;
  decBe: string;
  decLe: string;
  rawHex: string;
}

export interface ICardReaderState {
  connected: boolean;
  message: string;
  lastCard: ICardEvent | null;
  cardSeq: number;
}

interface IReaderControls extends ICardReaderState {
  clearLastCard: () => void;
}

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 5000;

export const useCardReader = (): IReaderControls => {
  const [state, setState] = useState<ICardReaderState>({
    connected: false,
    message: 'Подключение к агенту…',
    lastCard: null,
    cardSeq: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef<number>(MIN_BACKOFF);
  const urlIdxRef = useRef<number>(0);
  const stoppedRef = useRef<boolean>(false);

  const clearLastCard = useCallback(() => {
    setState(prev => ({ ...prev, lastCard: null }));
  }, []);

  useEffect(() => {
    stoppedRef.current = false;

    const connect = (): void => {
      if (stoppedRef.current) return;

      const url = SKUD_AGENT_WS_URLS[urlIdxRef.current % SKUD_AGENT_WS_URLS.length];

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          backoffRef.current = MIN_BACKOFF;
          setState(prev => ({ ...prev, connected: true, message: 'Агент подключён' }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
            if (data?.type === 'status') {
              setState(prev => ({
                ...prev,
                connected: !!data.connected,
                message: typeof data.message === 'string' ? data.message : prev.message,
              }));
            } else if (data?.type === 'card') {
              const card: ICardEvent = {
                w26: String(data.w26 || ''),
                sigurCard: String(data.sigurCard || ''),
                hexUid: String(data.hexUid || ''),
                decBe: String(data.decBe || ''),
                decLe: String(data.decLe || ''),
                rawHex: String(data.rawHex || ''),
              };
              setState(prev => ({ ...prev, lastCard: card, cardSeq: prev.cardSeq + 1 }));
            }
          } catch {
            /* ignore malformed payloads */
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (stoppedRef.current) return;
          urlIdxRef.current = (urlIdxRef.current + 1) % SKUD_AGENT_WS_URLS.length;
          setState(prev => ({ ...prev, connected: false, message: 'Агент не запущен' }));
          reconnectTimerRef.current = setTimeout(connect, backoffRef.current);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
        };

        ws.onerror = () => {
          try { ws.close(); } catch { /* noop */ }
        };
      } catch {
        if (stoppedRef.current) return;
        urlIdxRef.current = (urlIdxRef.current + 1) % SKUD_AGENT_WS_URLS.length;
        reconnectTimerRef.current = setTimeout(connect, backoffRef.current);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
      }
    };

    connect();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* noop */ }
        wsRef.current = null;
      }
    };
  }, []);

  return { ...state, clearLastCard };
};
