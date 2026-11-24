import { useCallback, useEffect, useState, type SetStateAction } from 'react';

import { useAuth } from '../contexts/AuthContext';
import {
  browserSessionStorage,
  readSessionState,
  sessionStateKey,
  writeSessionState,
} from '../utils/sessionState';

interface ISessionStateOptions<T> {
  /** Проверка формы сохранённого значения; не прошло — начальное. */
  parse: (raw: unknown) => T | null;
  /** Передано (не null) — важнее сохранённого: состояние из адреса возврата из карточки. */
  override?: T | null;
}

/**
 * useState, который живёт в sessionStorage под ключом пользователя (utils/sessionState): переживает уход в карточку
 * сотрудника и смену вкладок раздела, у каждой учётки свой, при выходе стирается. key null — обычный useState.
 * Сменился ключ — значение читается заново.
 */
export const useSessionState = <T,>(
  key: string | null,
  initial: T | (() => T),
  { parse, override = null }: ISessionStateOptions<T>,
): [T, (next: SetStateAction<T>) => void] => {
  const { user } = useAuth();
  const fullKey = sessionStateKey(key, user?.id);
  const load = (): T => {
    if (override !== null) return override;
    const saved = readSessionState(browserSessionStorage(), fullKey, parse);
    if (saved !== null) return saved;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  };
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key: fullKey, value: load() }));
  // Другой ключ (другая таблица или пользователь) — своё значение, без кадра с чужим.
  const current = state.key === fullKey ? state.value : load();
  if (state.key !== fullKey) setState({ key: fullKey, value: current });

  useEffect(() => {
    writeSessionState(browserSessionStorage(), fullKey, current);
  }, [fullKey, current]);

  const setValue = useCallback((next: SetStateAction<T>) => {
    setState(prev => ({
      key: prev.key,
      value: typeof next === 'function' ? (next as (value: T) => T)(prev.value) : next,
    }));
  }, []);

  return [current, setValue];
};
