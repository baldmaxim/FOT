/**
 * Разовое исправление плановой ЗОС четырёх объектов KPI по сверке с договорами ДГП от 06.11.2026
 * (temp/pz/Сводка_даты_ЗОС_по_объектам_2026_11_06.xlsx) — как ошибки исходных данных, во всех
 * месяцах, включая зафиксированные (п. 2.8 и 8.2 приказа). Решение пользователя 06.11.2026.
 *
 * Ожидаемое состояние прода зашито ниже (UUID, номера и версии договоров, старые даты, id
 * снимков сентября–ноября): любое расхождение — отказ до первой записи.
 * Подробности — src/services/object-kpi-zos-correction.service.ts.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/object-kpi-zos-correction-2026-11.ts --actor-email <почта>
 *
 * Без --apply — пробный прогон: всё считается в транзакции, печатается и откатывается.
 * --apply — записать. --revert <id операции> — откатить исправление следующей ревизией
 * (тоже пробно, пока нет --apply). Повтор после записи — отказ: даты уже другие.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { closeDb, withTransaction } from '../src/config/postgres.js';
import { computeManagerPremium } from '../src/services/object-kpi-premium.service.js';
import { OBJECT_KPI_REPORT_SQL, type ObjectKpiReportRow } from '../src/services/object-kpi-report.service.js';
import {
  buildRevertTargets,
  correctPlannedZos,
  resolveCorrectionActor,
  type IZosCorrectionTarget,
} from '../src/services/object-kpi-zos-correction.service.js';

const args = process.argv.slice(2);
const argValue = (name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const APPLY = args.includes('--apply');
const ACTOR_EMAIL = argValue('--actor-email');
const REVERT_OF = argValue('--revert');

const MONTH_FROM = '2026-07-01';
const MONTH_TO = '2026-11-01';
const BASIS = 'Сверка с договорами ДГП 06.11.2026 — ошибка исходных данных (п. 2.8, 8.2 приказа)';

const fixedMonths = (ids: [string, string, string]) =>
  ['2026-09-01', '2026-10-01', '2026-11-01'].map((month, index) => ({ month, planId: ids[index], revision: 1 }));

const TARGETS: IZosCorrectionTarget[] = [
  {
    objectId: '505b7090-27cf-44e9-9bd1-556d373b422d',
    objectName: 'ЖК Инжой',
    contractId: '2293c1ca-218b-4252-86f1-6cde6ea35003',
    contractNumber: 'ИРД-240626-3',
    contractVersion: 2,
    fromDate: '2027-07-31',
    toDate: '2026-12-26',
    fixedMonths: fixedMonths([
      '64a01b74-9294-4255-ae0f-f51773bfc5d3',
      '9548855d-4bb6-4409-aba8-8055a3a97f59',
      '62bd6730-fad2-4d98-8698-8a22745452c7',
    ]),
    reason: `${BASIS}: договор № ИРД-240626-3, п. 4.1.2 — ЗОС 26.12.2026`,
  },
  {
    objectId: 'b141b7a4-ab8b-426b-86c0-46e9ea66b3d3',
    objectName: 'ЖК Марк (лот 33)',
    contractId: '29ffe774-7d15-4c6d-88a5-baaa21500e06',
    contractNumber: 'ЗИЛ-33-РД-0527/24',
    contractVersion: 2,
    fromDate: '2026-04-30',
    toDate: '2026-11-30',
    fixedMonths: fixedMonths([
      'ebee0838-ef9e-4f5d-993a-b852bfd6f087',
      '1abfa096-5e07-49af-acb1-4b0cf4d76b1f',
      'b0ea56cc-ec37-4c51-83cb-cb4c35cf3f10',
    ]),
    reason: `${BASIS}: ДС № 14 и № 18 к договору ЗИЛ-33-0669/24 (тот же объект, подтверждено 06.11.2026) — ЗОС 30.11.2026`,
  },
  {
    objectId: 'fefa18d1-6d2e-42ca-ae4b-9698e28a0b3e',
    objectName: 'ЖК Примавера К14',
    contractId: 'b0a969ff-5676-4ca0-8d43-7d987ebad2e4',
    contractNumber: 'К14',
    contractVersion: 8,
    fromDate: '2028-02-01',
    toDate: '2028-03-01',
    fixedMonths: fixedMonths([
      '9338e4b7-c99a-4a8e-ac9f-969ce13a5daf',
      '858f8cf1-7fba-4d4b-825f-9c6fa3da4d3a',
      'd0806135-f2d0-40db-b52b-32ba033a6c67',
    ]),
    reason: `${BASIS}: договор № К14 — ЗОС 01.03.2028; 01.02.2028 есть только в неподписанном проекте ДС № 7`,
  },
  {
    objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8',
    objectName: 'ЖК King and Sons',
    contractId: '12767557-43c4-49a4-a407-ced4ced339f9',
    contractNumber: '05/2024-КС',
    contractVersion: 2,
    fromDate: '2026-11-15',
    toDate: '2026-04-01',
    fixedMonths: fixedMonths([
      '7c83d07a-de02-40e3-a89e-62c13a83f5d6',
      '4344e700-ea0e-4974-be59-2a75a4e17b96',
      'bb9ee72e-a90c-47e7-8de9-592a44788c63',
    ]),
    reason: `${BASIS}: договор № 05/2024-КС и график, этап «Получение ЗОС» — 01.04.2026`,
  },
];

/** Премии после исправления по плану от 06.11.2026 — для сверки глазами, запуск не останавливают. */
const EXPECTED_PREMIUM_AFTER: Record<string, ReadonlyArray<string | null>> = {
  'Родак Валерий': ['0', '296000', '0', '0', '0'],
  'Кривов Алексей Сергеевич': ['0', '272000', '0', '0', '0'],
  'Савченко Максим': ['114000', '10000', '118000', '188000', '0'],
  'Баранский Сергей Сергеевич': [null, '0', '0', '0', '0'],
};

class DryRunRollback extends Error {}

interface IManager {
  employeeId: number;
  name: string;
  objectIds: string[];
}

interface ISnapshot {
  report: Map<string, ObjectKpiReportRow>;
  premium: Map<number, Map<string, string | null>>;
  othersHash: string;
}

const money = (value: string | null | undefined): string => (
  value === null || value === undefined
    ? '—'
    : Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
);
const date = (value: string | null | undefined): string => (value ? value.split('-').reverse().join('.') : '—');
const arrow = (before: string, after: string): string => (before === after ? before : `${before} → ${after}`);

const loadManagers = async (client: PoolClient, objectIds: string[]): Promise<IManager[]> => {
  // Премия считается по всем объектам руководителя (п. 3.5), а не только по исправляемому.
  const result = await client.query<{ employee_id: number; full_name: string | null; object_ids: string[] }>(
    `SELECT a.employee_id, e.full_name,
            array_agg(DISTINCT all_a.skud_object_id::text) AS object_ids
       FROM object_kpi_assignments a
       LEFT JOIN employees e ON e.id = a.employee_id
       JOIN object_kpi_assignments all_a
         ON all_a.employee_id = a.employee_id AND all_a.role_kind = 'construction_manager'
      WHERE a.role_kind = 'construction_manager' AND a.skud_object_id = ANY($1::uuid[])
      GROUP BY a.employee_id, e.full_name
      ORDER BY e.full_name`,
    [objectIds],
  );
  return result.rows.map(row => ({ employeeId: row.employee_id, name: row.full_name ?? String(row.employee_id), objectIds: row.object_ids }));
};

const takeSnapshot = async (client: PoolClient, objectIds: string[], managers: IManager[]): Promise<ISnapshot> => {
  const rows = await client.query<ObjectKpiReportRow>(OBJECT_KPI_REPORT_SQL, [MONTH_FROM, MONTH_TO, objectIds]);
  const report = new Map(rows.rows.map(row => [`${row.skud_object_id}|${row.period_month}`, row]));

  const premium = new Map<number, Map<string, string | null>>();
  for (const manager of managers) {
    const result = await computeManagerPremium(client, {
      employeeId: manager.employeeId,
      objectIds: manager.objectIds,
      monthFrom: MONTH_FROM,
      monthTo: MONTH_TO,
    });
    premium.set(manager.employeeId, new Map(result.premium.map(month => [month.period_month, month.premium_amount])));
  }

  // Отпечаток всех договоров и текущих снимков ДРУГИХ объектов: правка не должна их задеть.
  const others = await client.query<{ part: string }>(
    `SELECT 'c:' || id || ':' || version || ':' || COALESCE(planned_zos_date::text, '-') AS part
       FROM object_contracts WHERE NOT (skud_object_id = ANY($1::uuid[]))
     UNION ALL
     SELECT 'p:' || id || ':' || revision || ':' || status
       FROM object_kpi_month_plans WHERE is_current AND NOT (skud_object_id = ANY($1::uuid[]))
     ORDER BY 1`,
    [objectIds],
  );
  const othersHash = createHash('md5').update(others.rows.map(row => row.part).join('\n')).digest('hex');
  return { report, premium, othersHash };
};

const printObjects = (targets: IZosCorrectionTarget[], before: ISnapshot, after: ISnapshot): void => {
  for (const target of targets) {
    console.log(`\n${target.objectName} (договор ${target.contractNumber}): плановая ЗОС ${date(target.fromDate)} → ${date(target.toDate)}`);
    const months = [...new Set([...before.report.keys(), ...after.report.keys()])]
      .filter(key => key.startsWith(`${target.objectId}|`))
      .sort();
    for (const key of months) {
      const was = before.report.get(key);
      const now = after.report.get(key);
      const month = key.split('|')[1].slice(0, 7);
      console.log(
        `  ${month} [${arrow(was?.report_status ?? '—', now?.report_status ?? '—')}]`
        + ` контроль ${arrow(date(was?.control_date), date(now?.control_date))}`
        + `, мес. ${arrow(String(was?.months_remaining ?? '—'), String(now?.months_remaining ?? '—'))}`
        + `, план ${arrow(money(was?.plan_amount), money(now?.plan_amount))}`
        + `, % ${arrow(was?.completion_pct ?? '—', now?.completion_pct ?? '—')}`,
      );
    }
  }
};

const printPremiums = (managers: IManager[], before: ISnapshot, after: ISnapshot): void => {
  console.log('\nПремии руководителей (₽), июль–ноябрь 2026:');
  const months = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const manager of managers) {
    // При откате ожидаемые суммы — прежние, сверка с планом исправления неприменима.
    const expected = REVERT_OF ? undefined : EXPECTED_PREMIUM_AFTER[manager.name];
    const cells = months.map((month, index) => {
      const was = before.premium.get(manager.employeeId)?.get(month) ?? null;
      const now = after.premium.get(manager.employeeId)?.get(month) ?? null;
      totalBefore += Number(was ?? 0);
      totalAfter += Number(now ?? 0);
      const mark = expected === undefined ? '' : (expected[index] === now ? ' ✓' : ` ≠ план ${expected[index] ?? '—'}`);
      return `${month.slice(5, 7)}: ${arrow(was ?? '—', now ?? '—')}${mark}`;
    });
    console.log(`  ${manager.name}: ${cells.join('; ')}`);
  }
  console.log(`  Всего: ${totalBefore.toLocaleString('ru-RU')} → ${totalAfter.toLocaleString('ru-RU')}`);
};

const main = async (): Promise<void> => {
  if (!ACTOR_EMAIL) throw new Error('Укажите --actor-email <почта ответственного администратора>');
  if (args.includes('--revert') && !REVERT_OF) throw new Error('Укажите id операции после --revert');
  const operationId = randomUUID();

  try {
    await withTransaction(async (client) => {
      const actor = await resolveCorrectionActor(client, ACTOR_EMAIL);
      const targets = REVERT_OF ? await buildRevertTargets(client, REVERT_OF) : TARGETS;
      const objectIds = targets.map(target => target.objectId);
      const managers = await loadManagers(client, objectIds);

      console.log(`${REVERT_OF ? `Откат операции ${REVERT_OF}` : 'Исправление плановой ЗОС'}; ответственный: ${actor.userName ?? actor.userId}`);
      const before = await takeSnapshot(client, objectIds, managers);
      await correctPlannedZos(client, actor, targets, { operationId, revertsOperationId: REVERT_OF });
      const after = await takeSnapshot(client, objectIds, managers);

      printObjects(targets, before, after);
      printPremiums(managers, before, after);
      if (before.othersHash !== after.othersHash) throw new Error('Изменились договоры или снимки других объектов — откат');
      console.log('\nДругие объекты: договоры и снимки не изменились.');
      if (!APPLY) throw new DryRunRollback();
    });
  } catch (error) {
    if (error instanceof DryRunRollback) {
      console.log(`\nПробный прогон: в БД ничего не записано. Записать — тот же запуск с --apply.`);
      return;
    }
    throw error;
  }
  console.log(REVERT_OF
    ? `\nЗаписано. Операция отката ${operationId}.`
    : `\nЗаписано. Операция ${operationId}. Откат: --revert ${operationId} (сначала без --apply).`);
};

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(`\nОТКАЗ, в БД ничего не записано: ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
