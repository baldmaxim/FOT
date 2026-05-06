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
import { replaceEmployeeAccessPointBindings } from './sigur-linked-employees.service.js';
import {
  enrichAccessPointBinding,
  toAccessRuleBinding,
  toCardSummary,
  type IAccessPointBinding,
} from './sigur-live-admin.service.js';

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
}> {
  const accessPointObjectMeta = await loadAccessPointObjectMetaMap();
  const result = await replaceEmployeeAccessPointBindings(sigurEmployeeId, accessPointIds, connection);

  return {
    addedIds: result.addedIds,
    removedIds: result.removedIds,
    bindings: result.bindings.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta)),
  };
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
