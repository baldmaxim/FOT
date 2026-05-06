/**
 * Sigur live admin — list + CRUD должностей (positions).
 *
 * Извлечено из sigur-live-admin.service.ts (Волна 3 декомпозиции).
 * 4 публичные функции: listSigurPositions, createSigurPosition,
 * updateSigurPosition, deleteSigurPosition. Самостоятельный домен —
 * не зависит от department-tree, employees, card-bindings.
 */
import { sigurService } from './sigur.service.js';
import { resolveField } from './sigur-sync-shared.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  normalizeInt,
  type ISigurPositionSummary,
} from './sigur-live-admin.service.js';

export async function listSigurPositions(connection?: ConnectionType): Promise<ISigurPositionSummary[]> {
  const positions = await sigurService.getPositionOptionsCached(connection);
  return positions.map(position => ({
    id: position.id,
    name: position.name,
  }));
}

export async function createSigurPosition(
  name: string,
  connection?: ConnectionType,
): Promise<ISigurPositionSummary> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Название должности обязательно');
  }

  const existingPositions = await sigurService.getPositionOptionsCached(connection);
  const existing = existingPositions.find(position => position.name.toLocaleLowerCase('ru') === normalizedName.toLocaleLowerCase('ru'));
  if (existing) {
    return existing;
  }

  const created = await sigurService.createPosition({ name: normalizedName }, connection);
  sigurService.invalidatePositionCache();
  const positionId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  const positionName = String(resolveField<string>(created, 'name', 'Name', 'title') || normalizedName).trim();

  if (!positionId || !positionName) {
    throw new Error('Sigur не вернул созданную должность');
  }

  return {
    id: positionId,
    name: positionName,
  };
}

export async function updateSigurPosition(
  id: number,
  name: string,
  connection?: ConnectionType,
): Promise<ISigurPositionSummary> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Некорректный ID должности');
  }
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Название должности обязательно');
  }

  const existingPositions = await sigurService.getPositionOptionsCached(connection);
  const duplicate = existingPositions.find(
    position => position.id !== id
      && position.name.toLocaleLowerCase('ru') === normalizedName.toLocaleLowerCase('ru'),
  );
  if (duplicate) {
    throw new Error('Должность с таким названием уже существует');
  }

  const updated = await sigurService.updatePosition(id, { name: normalizedName }, connection);
  sigurService.invalidatePositionCache();
  const positionId = normalizeInt(resolveField(updated, 'id', 'ID', 'Id')) || id;
  const positionName = String(resolveField<string>(updated, 'name', 'Name', 'title') || normalizedName).trim();

  return {
    id: positionId,
    name: positionName,
  };
}

export async function deleteSigurPosition(
  id: number,
  connection?: ConnectionType,
): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Некорректный ID должности');
  }

  await sigurService.deletePosition(id, connection);
  sigurService.invalidatePositionCache();
}
