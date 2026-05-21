/**
 * Конфиг подрядчиков. Корень дерева подрядных организаций в org_departments —
 * папка с этим именем (создаётся в Sigur, синхронизируется через
 * sigur-sync-structure). Sigur sync вешает все свои верхние узлы на синтетический
 * корень «Объект», поэтому ищем по имени без условия parent_id IS NULL.
 */
import { queryOne } from './postgres.js';

export const CONTRACTOR_ROOT_NAME = 'подрядные организации';

/** id узла «подрядные организации» или null, если не синхронизирован. */
export const getContractorRootId = async (): Promise<string | null> => {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM org_departments
      WHERE name = $1 AND is_active = true
      LIMIT 1`,
    [CONTRACTOR_ROOT_NAME],
  );
  return row?.id ?? null;
};

/** Включён ли dry-run Sigur (локальная отладка без реальных вызовов Sigur). */
export const isContractorSigurDryRun = (): boolean =>
  process.env.CONTRACTOR_SIGUR_DRYRUN === 'true';
