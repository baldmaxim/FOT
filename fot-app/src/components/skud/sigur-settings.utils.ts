import type { ISyncAllStep, ISseMessage, SyncStepName } from './sigur-settings.types';

export const FIELD_LABELS: Record<string, string> = {
  physicalPerson: 'ФИО',
  eventDate: 'Дата',
  eventTime: 'Время',
  direction: 'Направление',
  accessPoint: 'Точка доступа',
  cardNumber: 'Карта',
  department: 'Отдел',
  blocked: 'Заблокирован',
};

export const DIRECTION_LABELS: Record<string, string> = {
  entry: 'Вход',
  exit: 'Выход',
};

export const ALL_SYNC_STEPS: ISyncAllStep[] = [
  { id: 1, name: 'organizations', label: 'Организации', status: 'pending' },
  { id: 2, name: 'clean-duplicates', label: 'Очистка дублей', status: 'pending' },
  { id: 3, name: 'departments', label: 'Отделы (иерархия)', status: 'pending' },
  { id: 4, name: 'positions', label: 'Должности', status: 'pending' },
  { id: 5, name: 'employees', label: 'Сотрудники', status: 'pending' },
];

export const DEFAULT_SYNC_ALL_STEPS: SyncStepName[] = ['departments', 'positions', 'employees'];

export const STRUCTURE_SYNC_STEPS = ALL_SYNC_STEPS;

export const buildStepState = (selectedSteps: SyncStepName[]): ISyncAllStep[] =>
  STRUCTURE_SYNC_STEPS
    .filter(step => selectedSteps.includes(step.name))
    .map(step => ({ ...step, status: 'pending', result: undefined, error: undefined }));

export const getSyncStepLabel = (name: SyncStepName) =>
  STRUCTURE_SYNC_STEPS.find(step => step.name === name)?.label ?? name;

export const formatDuration = (durationMs?: unknown) => {
  if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) return '';
  return durationMs >= 10_000
    ? `${Math.round(durationMs / 1000)}с`
    : `${(durationMs / 1000).toFixed(1)}с`;
};

export const renderStepResult = (name: string, result: Record<string, unknown>) => {
  let text = '';
  switch (name) {
    case 'organizations':
      text = `Импорт: ${result.imported}, пропущено: ${result.skipped}`;
      break;
    case 'clean-duplicates':
      text = `Удалено дублей: ${result.duplicatesRemoved}`;
      break;
    case 'departments':
      text = `Новых: ${result.imported}, обновлено: ${result.updated}, связей: ${result.parentLinksSet}`;
      if (result.filtered) text += `, отфильтровано: ${result.filtered}`;
      break;
    case 'positions':
      text = `Из Sigur: ${result.imported}, обновлено: ${result.updated}, seed: ${result.seeded ?? 0}`;
      break;
    case 'employees':
      text = `Импорт: ${result.imported}, обновлено: ${result.updated}, пропущено: ${result.skipped}`;
      break;
    default:
      text = JSON.stringify(result);
  }
  const errors = result.errors as string[] | undefined;
  if (errors && errors.length > 0) {
    text += ` | Ошибки: ${errors.length}`;
  }
  const duration = formatDuration(result.durationMs);
  if (duration) {
    text += ` | ${duration}`;
  }
  return text;
};

export const readResponseError = async (response: Response) => {
  try {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const payload = await response.json() as { error?: string; message?: string };
      if (payload.error) return payload.error;
      if (payload.message) return payload.message;
    }

    const text = (await response.text()).trim();
    if (text) return text;
  } catch {
    // ignore body parsing issues and fall back to a generic message
  }

  return 'Ошибка синхронизации';
};

export const readSseResponse = async (
  response: Response,
  onData: (data: ISseMessage) => void,
) => {
  if (!response.ok || !response.body) {
    throw new Error(await readResponseError(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processChunk = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        onData(JSON.parse(line.slice(6)) as ISseMessage);
      } catch {
        // ignore malformed SSE payloads
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    processChunk(lines.join('\n'));
  }

  buffer += decoder.decode();
  processChunk(buffer);
};
