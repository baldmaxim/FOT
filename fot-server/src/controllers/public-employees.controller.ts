// Справочник сотрудников для 1С (GET /api/public/v1/employees): ID_FOT, код физлица 1С, ФИО, дата рождения и поля
// для сверки — 1С по нему сама проставляет ID_FOT. Доступ — как у обмена табелями: ключу открыта таблица employees.
// Состав и правила — services/employees-1c-directory.service.ts.

import type { Request, Response } from 'express';
import {
  DIRECTORY_MAX_LIMIT,
  listDirectoryEmployees,
  type DirectoryStatus,
  type IDirectoryFilters,
} from '../services/employees-1c-directory.service.js';
import { ensureEmployeesAccess, fail } from './public-data-api.helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[1-9]\d{0,9}$/;
const DEFAULT_LIMIT = 500;

class DirectoryFilterError extends Error {}

const stringParam = (req: Request, name: string): string | null => {
  const value = req.query[name];
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new DirectoryFilterError(`${name} передан несколько раз`);
  return value;
};

const idParam = (req: Request, name: string): number | null => {
  const raw = stringParam(req, name);
  if (raw === null) return null;
  if (!ID_RE.test(raw)) throw new DirectoryFilterError(`${name} — положительное целое`);
  return Number(raw);
};

export const parseDirectoryFilters = (req: Request): IDirectoryFilters => {
  const idAll = stringParam(req, 'id_all');
  if (idAll !== null && !UUID_RE.test(idAll)) throw new DirectoryFilterError('id_all — UUID физлица 1С');
  const status = stringParam(req, 'status');
  if (status !== null && status !== 'active' && status !== 'fired') throw new DirectoryFilterError('status — active или fired');
  const limitRaw = stringParam(req, 'limit');
  const limit = limitRaw === null ? DEFAULT_LIMIT : (/^\d+$/.test(limitRaw) ? Number(limitRaw) : Number.NaN);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIRECTORY_MAX_LIMIT) {
    throw new DirectoryFilterError(`limit должен быть целым от 1 до ${DIRECTORY_MAX_LIMIT}`);
  }
  return {
    idAll: idAll === null ? null : idAll.toLowerCase(),
    employeeId: idParam(req, 'employee_id'),
    status: status as DirectoryStatus | null,
    afterId: idParam(req, 'after_id'),
    limit,
  };
};

export const publicEmployeesController = {
  /** GET /api/public/v1/employees — справочник сотрудников: ID_FOT ↔ код физлица 1С, ФИО, дата рождения. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureEmployeesAccess(req, res))) return;
      const filters = parseDirectoryFilters(req);
      const page = await listDirectoryEmployees(filters);
      res.json({
        success: true,
        data: page.rows,
        meta: { count: page.rows.length, with_id_all: page.rows.filter(row => row.id_all !== null).length },
        next_after_id: page.nextAfterId,
      });
    } catch (err) {
      if (err instanceof DirectoryFilterError) {
        fail(res, 400, err.message, 'invalid_filter', { retryable: false });
        return;
      }
      console.error('publicEmployees.list error:', err);
      fail(res, 500, 'Ошибка сервера', 'internal_error', { retryable: true });
    }
  },
};
