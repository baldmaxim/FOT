/**
 * Конфиг подрядчиков. Корень дерева подрядных организаций в org_departments —
 * синтетический узел с этим именем (создаётся в Sigur, синхронизируется через
 * sigur-sync-structure). Поиск по имени — прецедент «Объект» в listCompanies.
 */
import { queryOne } from './postgres.js';

export const CONTRACTOR_ROOT_NAME = 'подрядные организации';

/** id корневого узла «подрядные организации» или null, если не синхронизирован. */
export const getContractorRootId = async (): Promise<string | null> => {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM org_departments
      WHERE parent_id IS NULL AND name = $1
      LIMIT 1`,
    [CONTRACTOR_ROOT_NAME],
  );
  return row?.id ?? null;
};

/** Включён ли dry-run Sigur (локальная отладка без реальных вызовов Sigur). */
export const isContractorSigurDryRun = (): boolean =>
  process.env.CONTRACTOR_SIGUR_DRYRUN === 'true';
