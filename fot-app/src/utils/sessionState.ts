/**
 * Состояние экрана на время вкладки браузера («Проживание»: режим, общежитие, поиск и фильтры столбцов) — в
 * sessionStorage, под ключом пользователя: следующая учётка в той же вкладке чужого не получит, при выходе — стирается.
 */

/** Префиксы ключей, которые стираются при выходе. */
export const SESSION_STATE_PREFIXES: ReadonlyArray<string> = ['housing.', 'registry-view:'];

/** Ключ хранилища: «<ключ>:<id пользователя>»; без пользователя — не храним. */
export const sessionStateKey = (key: string | null, userId: string | null | undefined): string | null => (
  key && userId ? `${key}:${userId}` : null
);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

/** Значение по ключу, прошедшее проверку формы; нет, битый JSON или чужая форма — null. */
export const readSessionState = <T,>(
  storage: StorageReader | null,
  fullKey: string | null,
  parse: (raw: unknown) => T | null,
): T | null => {
  if (!storage || !fullKey) return null;
  try {
    const raw = storage.getItem(fullKey);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const writeSessionState = (storage: StorageWriter | null, fullKey: string | null, value: unknown): void => {
  if (!storage || !fullKey) return;
  try {
    storage.setItem(fullKey, JSON.stringify(value));
  } catch {
    // Переполнено или запрещено — состояние просто не переживёт уход со страницы.
  }
};

/** Выход: стереть состояние экранов всех учёток этой вкладки. */
export const clearSessionStates = (storage: Pick<Storage, 'length' | 'key' | 'removeItem'> | null): void => {
  if (!storage) return;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && SESSION_STATE_PREFIXES.some(prefix => key.startsWith(prefix))) keys.push(key);
  }
  keys.forEach(key => storage.removeItem(key));
};

/** sessionStorage браузера; нет (SSR, запрет) — null. */
export const browserSessionStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

/** Проверки формы для parse. */
export const parseOneOf = <T extends string>(values: ReadonlyArray<T>) => (raw: unknown): T | null => (
  typeof raw === 'string' && (values as ReadonlyArray<string>).includes(raw) ? raw as T : null
);
export const parseString = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null);
