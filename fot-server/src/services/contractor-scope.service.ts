/**
 * Скоуп подрядчиков: список подрядных организаций (прямые дети корня
 * «подрядные организации») и резолвинг организации для пользователя-подрядчика.
 */
import { query, queryOne } from '../config/postgres.js';
import { getContractorRootId } from '../config/contractor.js';

export interface IContractorOrg {
  id: string;
  name: string;
  sigur_department_id: number | null;
}

/** Прямые дети корня «подрядные организации». Пусто, если корень не синхронизирован. */
export const getContractorOrgs = async (): Promise<IContractorOrg[]> => {
  const rootId = await getContractorRootId();
  if (!rootId) return [];
  return query<IContractorOrg>(
    `SELECT id, name, sigur_department_id
       FROM org_departments
      WHERE parent_id = $1::uuid AND is_active = true
      ORDER BY name ASC`,
    [rootId],
  );
};

/** Организация, к которой привязан пользователь-подрядчик, или null. */
export const resolveContractorOrgForUser = async (
  userId: string,
): Promise<string | null> => {
  const row = await queryOne<{ org_department_id: string }>(
    'SELECT org_department_id FROM contractor_org_access WHERE user_id = $1::uuid',
    [userId],
  );
  return row?.org_department_id ?? null;
};

/** Sigur-id отдела организации. throws — если организации нет или она не синхронизирована. */
export const getOrgSigurDepartmentId = async (
  orgDepartmentId: string,
): Promise<number> => {
  const row = await queryOne<{ sigur_department_id: number | null }>(
    'SELECT sigur_department_id FROM org_departments WHERE id = $1::uuid',
    [orgDepartmentId],
  );
  if (!row) {
    throw new ContractorScopeError(404, 'Подрядная организация не найдена');
  }
  if (row.sigur_department_id == null) {
    throw new ContractorScopeError(409, 'Организация не синхронизирована с Sigur');
  }
  return row.sigur_department_id;
};

/** Ошибка скоупа с HTTP-статусом для прямого ответа из контроллера. */
export class ContractorScopeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ContractorScopeError';
  }
}
