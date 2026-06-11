/**
 * Sigur live admin — операции с картами и точками/правилами доступа сотрудников.
 *
 * Извлечено из sigur-live-admin.service.ts (Волна 3 декомпозиции).
 * Содержит 4 публичных операции, изменяющих карточные привязки и
 * списки точек/правил доступа в Sigur API.
 *
 * Helpers (toCardSummary, toAccessRuleBinding, enrichAccessPointBinding)
 * используются и в основном sigur-live-admin (Profile/CardStatuses) — поэтому
 * остаются там и импортируются как public exports.
 */
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  loadAccessPointObjectMetaMap,
} from './sigur-access-point-meta.service.js';
import { replaceEmployeeAccessPointBindings, type ICardConflict } from './sigur-linked-employees.service.js';
import {
  enrichAccessPointBinding,
  toAccessRuleBinding,
  toCardSummary,
  type IAccessPointBinding,
} from './sigur-live-admin.service.js';
import { resolveField } from './sigur-sync-shared.js';
import { deriveCardW26 } from './sigur-card-w26.util.js';

export { deriveCardW26, type ICardW26 } from './sigur-card-w26.util.js';

interface ISigurCardSummary {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

const normalizeIntLocal = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const getBindingEmployeeIdLocal = (raw: Record<string, unknown>): number | null => {
  const direct = normalizeIntLocal(resolveField(raw, 'employeeId', 'employee_id'));
  if (direct) return direct;
  const holder = raw.holder;
  if (holder && typeof holder === 'object') {
    const holderObj = holder as Record<string, unknown>;
    const type = typeof holderObj.type === 'string' ? holderObj.type.toUpperCase() : '';
    if (!type || type === 'EMP' || type === 'EMPLOYEE') {
      const holderId = normalizeIntLocal(resolveField(holderObj, 'holderId', 'holder_id', 'id'));
      if (holderId) return holderId;
    }
  }
  return null;
};

export async function updateSigurEmployeeCardExpiration(
  sigurEmployeeId: number,
  cardId: number,
  expirationDate: string,
  connection?: ConnectionType,
): Promise<{
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}> {
  const parsedExpirationDate = new Date(expirationDate);
  if (Number.isNaN(parsedExpirationDate.getTime())) {
    throw new Error('Некорректная дата срока действия');
  }

  await sigurService.updateEmployeeCardBindingExpiration(
    sigurEmployeeId,
    cardId,
    parsedExpirationDate.toISOString(),
    connection,
  );

  const cardsRaw = await sigurService.getCardBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const card = cardsRaw
    .map(rawCard => toCardSummary(rawCard))
    .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
    .find(rawCard => rawCard.cardId === cardId);

  return card || {
    cardId,
    cardNumber: null,
    status: null,
    format: null,
    startDate: null,
    expirationDate: parsedExpirationDate.toISOString(),
  };
}

export async function updateSigurEmployeeCardBinding(
  sigurEmployeeId: number,
  cardId: number,
  startDate: string,
  expirationDate: string,
  connection?: ConnectionType,
  format?: string | null,
): Promise<{
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}> {
  const parsedStartDate = new Date(startDate);
  if (Number.isNaN(parsedStartDate.getTime())) {
    throw new Error('Некорректная дата начала доступа');
  }
  const parsedExpirationDate = new Date(expirationDate);
  if (Number.isNaN(parsedExpirationDate.getTime())) {
    throw new Error('Некорректная дата срока действия');
  }

  const existingBindings = await sigurService.getCardBindings({ employeeId: sigurEmployeeId, cardId }, connection) as Record<string, unknown>[];
  console.log('[Sigur binding BEFORE patch] raw=', JSON.stringify(existingBindings));

  await sigurService.patchEmployeeCardBinding(
    sigurEmployeeId,
    cardId,
    parsedStartDate.toISOString(),
    parsedExpirationDate.toISOString(),
    connection,
    format ?? undefined,
  );

  const cardsRaw = await sigurService.getCardBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const card = cardsRaw
    .map(rawCard => toCardSummary(rawCard))
    .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
    .find(rawCard => rawCard.cardId === cardId);

  return card || {
    cardId,
    cardNumber: null,
    status: null,
    format: format ?? null,
    startDate: parsedStartDate.toISOString(),
    expirationDate: parsedExpirationDate.toISOString(),
  };
}

export async function replaceSigurEmployeeAccessPoints(
  sigurEmployeeId: number,
  accessPointIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: IAccessPointBinding[];
  restoredCardIds: number[];
  cardConflicts: ICardConflict[];
}> {
  const accessPointObjectMeta = await loadAccessPointObjectMetaMap();
  const result = await replaceEmployeeAccessPointBindings(sigurEmployeeId, accessPointIds, connection);

  return {
    addedIds: result.addedIds,
    removedIds: result.removedIds,
    bindings: result.bindings.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta)),
    restoredCardIds: result.restoredCardIds,
    cardConflicts: result.cardConflicts,
  };
}

/**
 * Привязать карту к sigur-сотруднику по UID кандидатам (Sigur card / W26 / HEX / DEC).
 * Если карта уже у того же сотрудника — продлевает срок (PATCH).
 * Если карта у другого — снимает с него (DELETE) и создаёт привязку (POST).
 *
 * Если карта не найдена в Sigur:
 *  - при `createIfMissing=true` — создаёт её из UID/W26 (POST /cards, format W26) и привязывает;
 *  - иначе — бросает ошибку с понятным текстом.
 */
export async function assignSigurEmployeeCardBinding(
  sigurEmployeeId: number,
  candidates: string[],
  expirationDate?: string,
  connection?: ConnectionType,
  createIfMissing = false,
): Promise<{ card: ISigurCardSummary; previousSigurEmployeeId: number | null; reassigned: boolean }> {
  if (candidates.length === 0) {
    throw new Error('UID карты обязателен');
  }

  const { matches } = await sigurService.findCardByCandidates(candidates, connection);
  const cards = matches.map(toCardSummary).filter((c): c is NonNullable<ReturnType<typeof toCardSummary>> => !!c);
  let card: NonNullable<ReturnType<typeof toCardSummary>> | undefined = cards[0];

  if (!card) {
    if (!createIfMissing) {
      throw new Error('Карта не найдена в Sigur. Создайте карту в Sigur Manager перед привязкой.');
    }
    // Вывести value из первого кандидата, который удаётся декодировать (UID или W26).
    let decoded: ReturnType<typeof deriveCardW26> | null = null;
    for (const candidate of candidates) {
      try {
        decoded = deriveCardW26(candidate);
        break;
      } catch {
        /* пробуем следующий кандидат */
      }
    }
    if (!decoded) {
      throw new Error(`Не удалось вывести значение карты из UID/W26: ${candidates.join(', ')}`);
    }
    const createdRaw = await sigurService.createCard(decoded.value, 'W26', connection);
    card = toCardSummary(createdRaw) ?? undefined;
    if (!card) {
      // Ответ POST /cards без распознаваемого id — перечитываем по value.
      const refetched = await sigurService.findCardByCandidates([decoded.value], connection);
      card = refetched.matches.map(toCardSummary).find((c): c is NonNullable<ReturnType<typeof toCardSummary>> => !!c);
    }
    if (!card) {
      throw new Error(`Карта создана, но не найдена в Sigur: value ${decoded.value}`);
    }
  }

  const startIso = new Date().toISOString();
  let expiresIso: string;
  if (typeof expirationDate === 'string' && expirationDate.trim()) {
    const parsed = new Date(expirationDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Некорректная дата срока действия');
    }
    expiresIso = parsed.toISOString();
  } else {
    const inFiveYears = new Date();
    inFiveYears.setFullYear(inFiveYears.getFullYear() + 5);
    expiresIso = inFiveYears.toISOString();
  }

  const existingBindings = await sigurService.getCardBindings({ cardId: card.cardId }, connection) as Record<string, unknown>[];
  const existingEmployeeId = existingBindings.map(getBindingEmployeeIdLocal).find((id): id is number => !!id) || null;
  const cardFormat = card.format || 'W26';

  if (existingEmployeeId === sigurEmployeeId) {
    await sigurService.patchEmployeeCardBinding(
      sigurEmployeeId,
      card.cardId,
      startIso,
      expiresIso,
      connection,
      cardFormat,
    );
  } else {
    if (existingEmployeeId) {
      await sigurService.deleteEmployeeCardBinding(existingEmployeeId, card.cardId, cardFormat, connection);
    }
    await sigurService.createEmployeeCardBinding(
      sigurEmployeeId,
      card.cardId,
      startIso,
      expiresIso,
      connection,
      cardFormat,
    );
  }

  sigurService.invalidateCardListCache();

  return {
    card: { ...card, startDate: startIso, expirationDate: expiresIso },
    previousSigurEmployeeId: existingEmployeeId && existingEmployeeId !== sigurEmployeeId ? existingEmployeeId : null,
    reassigned: existingEmployeeId !== null && existingEmployeeId !== sigurEmployeeId,
  };
}

/**
 * Снять привязку карты с sigur-сотрудника. Формат карты подтягивается из текущей привязки.
 */
export async function removeSigurEmployeeCardBinding(
  sigurEmployeeId: number,
  cardId: number,
  connection?: ConnectionType,
): Promise<{ cardId: number }> {
  const existingBindings = await sigurService.getCardBindings({ employeeId: sigurEmployeeId, cardId }, connection) as Record<string, unknown>[];
  const ownerId = existingBindings.map(getBindingEmployeeIdLocal).find((id): id is number => !!id) || null;
  if (ownerId !== sigurEmployeeId) {
    throw new Error('Карта не привязана к этому сотруднику');
  }
  const cards = existingBindings
    .map(raw => toCardSummary(raw))
    .filter((c): c is NonNullable<ReturnType<typeof toCardSummary>> => !!c);
  const cardFormat = cards[0]?.format || 'W26';

  await sigurService.deleteEmployeeCardBinding(sigurEmployeeId, cardId, cardFormat, connection);
  sigurService.invalidateCardListCache();

  return { cardId };
}

export async function replaceSigurEmployeeAccessRules(
  sigurEmployeeId: number,
  accessRuleIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: Array<{ accessRuleId: number; accessRuleName: string | null }>;
}> {
  const normalizedAccessRuleIds = Array.from(new Set(
    accessRuleIds.filter(accessRuleId => Number.isFinite(accessRuleId) && accessRuleId > 0),
  )).sort((left, right) => left - right);
  const currentBindings = await sigurService.getEmployeeAccessRuleBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const currentIds = currentBindings
    .map(raw => toAccessRuleBinding(raw))
    .filter((binding): binding is NonNullable<ReturnType<typeof toAccessRuleBinding>> => !!binding && binding.employeeId === sigurEmployeeId)
    .map(binding => binding.accessRuleId)
    .sort((left, right) => left - right);
  const currentIdSet = new Set(currentIds);
  const nextIdSet = new Set(normalizedAccessRuleIds);
  const addedIds = normalizedAccessRuleIds.filter(accessRuleId => !currentIdSet.has(accessRuleId));
  const removedIds = currentIds.filter(accessRuleId => !nextIdSet.has(accessRuleId));

  await Promise.all([
    ...addedIds.map(accessRuleId => sigurService.addEmployeeAccessRuleBinding({
      employeeId: sigurEmployeeId,
      accessruleId: accessRuleId,
    }, connection)),
    ...removedIds.map(accessRuleId => sigurService.deleteEmployeeAccessRuleBinding({
      employeeId: sigurEmployeeId,
      accessruleId: accessRuleId,
    }, connection)),
  ]);

  const accessRuleCatalog = await sigurService.getAccessRuleMapCached(connection).catch(() => null);

  return {
    addedIds,
    removedIds,
    bindings: normalizedAccessRuleIds.map(accessRuleId => ({
      accessRuleId,
      accessRuleName: accessRuleCatalog?.get(accessRuleId) || null,
    })),
  };
}
