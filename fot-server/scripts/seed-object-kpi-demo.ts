/**
 * Синтетические данные KPI для одного объекта — чтобы прогнать модуль целиком до того,
 * как экономист начнёт вводить настоящие договоры.
 *
 * Сценарий (объект «База Химки»):
 *   договор с 01.01.2025, срок 3 года → плановая ЗОС 31.12.2027, стоимость 5 млрд ₽ с НДС;
 *   выполнено 2,5 млрд — 20 подписанных КС-2 по 125 млн, с января 2025 по август 2026;
 *   объект закреплён за руководителем строительства с 01.01.2025, бессрочно.
 *
 * Контрольные числа на августе 2026: остаток 2 625 млн, расчётных месяцев 20,
 * план 131 250 000 ₽, факт 125 000 000 ₽ → 95,24 %.
 *
 * Запуск (dry-run, ничего не пишет):
 *   cd fot-server && npx tsx scripts/seed-object-kpi-demo.ts
 * Запись:
 *   cd fot-server && npx tsx scripts/seed-object-kpi-demo.ts --manager=<employee_id> --apply
 * Удаление всего, что скрипт создал:
 *   cd fot-server && npx tsx scripts/seed-object-kpi-demo.ts --remove
 *
 * Всё созданное помечено DEMO_MARKER в notes и префиксом в номерах — удаление ищет
 * ровно эти записи и чужие данные не трогает.
 */
import { query, withTransaction } from '../src/config/postgres.js';

const OBJECT_NAME = 'База Химки';
const DEMO_MARKER = 'KPI-DEMO';
const ACT_PREFIX = 'ДЕМО-КС2-';

const CONTRACT = {
  number: 'ДЕМО-2025/01',
  date: '2025-01-01',
  customer: 'ООО «Демо-Заказчик»',
  baseAmount: '5000000000.00',
  plannedZos: '2027-12-31',
  planStartMonth: '2025-01-01',
};

const ACT_AMOUNT = '125000000.00';
const FIRST_ACT_MONTH = '2025-01';
const LAST_ACT_MONTH = '2026-08';
const ASSIGNMENT_FROM = '2025-01-01';

const parseArg = (name: string): string | null => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

/** Список месяцев включительно: «2025-01» … «2026-08». */
const monthsBetween = (from: string, to: string): string[] => {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  const months: string[] = [];
  for (let cursor = fromYear * 12 + fromMonth - 1; cursor <= toYear * 12 + toMonth - 1; cursor += 1) {
    months.push(`${Math.floor(cursor / 12)}-${String((cursor % 12) + 1).padStart(2, '0')}`);
  }
  return months;
};

async function resolveObjectId(): Promise<string> {
  const rows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM skud_objects WHERE name = $1',
    [OBJECT_NAME],
  );
  if (rows.length !== 1) {
    throw new Error(`Объект «${OBJECT_NAME}» не найден или найден не один (${rows.length})`);
  }
  return rows[0].id;
}

async function remove(objectId: string, apply: boolean): Promise<void> {
  const [contract] = await query<{ id: string; notes: string | null }>(
    'SELECT id, notes FROM object_contracts WHERE skud_object_id = $1',
    [objectId],
  );

  if (contract && !contract.notes?.includes(DEMO_MARKER)) {
    throw new Error('У объекта договор, созданный НЕ этим скриптом — удаление отменено');
  }

  console.log(`\nБудет удалено по объекту «${OBJECT_NAME}»:`);
  console.log(`  договор: ${contract ? 'да' : 'нет'}`);
  console.log(`  акты КС-2 с префиксом ${ACT_PREFIX} и снимки планов`);
  console.log(`  закрепления с пометкой ${DEMO_MARKER}`);

  if (!apply) {
    console.log('\nDry-run. Для удаления повторите с флагом --remove --apply\n');
    return;
  }

  await withTransaction(async (client) => {
    // Порядок обязателен: FK стоят RESTRICT, договор удаляется последним.
    await client.query(
      'DELETE FROM object_ks2_entries WHERE skud_object_id = $1 AND act_number LIKE $2',
      [objectId, `${ACT_PREFIX}%`],
    );
    if (contract) {
      await client.query(
        'DELETE FROM object_contract_addenda WHERE contract_id = $1 AND notes LIKE $2',
        [contract.id, `%${DEMO_MARKER}%`],
      );
    }
    await client.query('DELETE FROM object_kpi_month_plans WHERE skud_object_id = $1', [objectId]);
    await client.query(
      'DELETE FROM object_kpi_assignments WHERE skud_object_id = $1 AND notes LIKE $2',
      [objectId, `%${DEMO_MARKER}%`],
    );
    if (contract) {
      await client.query('DELETE FROM object_contracts WHERE id = $1', [contract.id]);
    }
    // История остаётся: она переживает удаление записей и показывает, что демо было.
  });

  console.log('\nДемо-данные удалены.\n');
}

async function listManagerCandidates(): Promise<void> {
  const rows = await query<{ id: number; full_name: string | null }>(
    `SELECT e.id, e.full_name
       FROM employees e
       JOIN user_profiles up ON up.employee_id = e.id
       JOIN system_roles r   ON r.id = up.system_role_id
      WHERE r.code = 'manager_obj' AND e.employment_status = 'active'
      ORDER BY e.full_name
      LIMIT 30`,
  );
  console.log('\nКандидаты в руководители строительства (--manager=<id>):');
  for (const row of rows) console.log(`  ${row.id}  ${row.full_name ?? '—'}`);
}

async function seed(objectId: string, managerId: number | null, apply: boolean): Promise<void> {
  const [existing] = await query<{ id: string; notes: string | null }>(
    'SELECT id, notes FROM object_contracts WHERE skud_object_id = $1',
    [objectId],
  );
  if (existing) {
    throw new Error(
      existing.notes?.includes(DEMO_MARKER)
        ? 'Демо-данные уже залиты. Сначала удалите: --remove --apply'
        : 'У объекта уже есть договор — скрипт не трогает настоящие данные',
    );
  }

  const months = monthsBetween(FIRST_ACT_MONTH, LAST_ACT_MONTH);
  const total = months.length * Number(ACT_AMOUNT);

  console.log(`\nОбъект: ${OBJECT_NAME} (${objectId})`);
  console.log(`Договор: ${CONTRACT.number} от ${CONTRACT.date}, ${CONTRACT.baseAmount} ₽ с НДС`);
  console.log(`Плановая ЗОС: ${CONTRACT.plannedZos} → контрольная дата 2028-03-31`);
  console.log(`Актов КС-2: ${months.length} × ${ACT_AMOUNT} = ${total.toLocaleString('ru-RU')} ₽`);
  console.log(`Период актов: ${months[0]} … ${months[months.length - 1]}, подписание 25-го числа`);
  console.log(`Руководитель: ${managerId ? `employee_id=${managerId}, с ${ASSIGNMENT_FROM}` : 'не указан — закрепление не создаётся'}`);

  if (!apply) {
    console.log('\nDry-run. Для записи повторите с флагом --apply\n');
    return;
  }

  await withTransaction(async (client) => {
    const contractResult = await client.query<{ id: string }>(
      `INSERT INTO object_contracts (
         skud_object_id, contract_number, contract_date, customer_name, base_amount,
         planned_zos_date, plan_start_month, notes
       ) VALUES ($1,$2,$3::date,$4,$5,$6::date,$7::date,$8)
       RETURNING id`,
      [
        objectId, CONTRACT.number, CONTRACT.date, CONTRACT.customer, CONTRACT.baseAmount,
        CONTRACT.plannedZos, CONTRACT.planStartMonth, `${DEMO_MARKER}: синтетические данные для тестирования`,
      ],
    );
    const contractId = contractResult.rows[0].id;

    // Сразу signed: черновики в расчёт не идут, а смысл демо — увидеть цифры.
    for (const [index, month] of months.entries()) {
      await client.query(
        `INSERT INTO object_ks2_entries (
           contract_id, skud_object_id, entry_kind, amount, act_number,
           customer_signed_date, status, notes
         ) VALUES ($1,$2,'act',$3,$4,$5::date,'signed',$6)`,
        [
          contractId, objectId, ACT_AMOUNT,
          `${ACT_PREFIX}${String(index + 1).padStart(2, '0')}`,
          `${month}-25`,
          `${DEMO_MARKER}`,
        ],
      );
    }

    if (managerId) {
      await client.query(
        `INSERT INTO object_kpi_assignments (
           skud_object_id, employee_id, role_kind, valid_from, source, notes
         ) VALUES ($1,$2,'construction_manager',$3::date,'manual',$4)`,
        [objectId, managerId, ASSIGNMENT_FROM, `${DEMO_MARKER}: демо-закрепление`],
      );
    }
  });

  console.log('\nДемо-данные залиты. Проверьте вкладку «KPI объектов» за март–август 2026.\n');
}

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const removeMode = process.argv.includes('--remove');
  const managerRaw = parseArg('manager');
  const managerId = managerRaw ? Number.parseInt(managerRaw, 10) : null;

  const objectId = await resolveObjectId();

  if (removeMode) {
    await remove(objectId, apply);
    return;
  }

  if (!managerId) await listManagerCandidates();
  await seed(objectId, managerId, apply);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed-object-kpi-demo]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
