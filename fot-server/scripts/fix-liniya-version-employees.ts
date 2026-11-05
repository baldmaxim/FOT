/**
 * Разовый перенос Приставки (6550) и Стеняева (1700) из закрытых подач ЛИНИЯ-Общестрой
 * в закрытые подачи ЛИНИИ за сентябрь и октябрь 2026.
 *
 * Их часы лежат в редакциях Общестроя, в редакциях ЛИНИИ у них пустые строки: открытое
 * назначение ошибочно оставалось в Общестрое (перевод задним числом 08.07.2026). Назначения
 * правит docs/manual-migrations/pristavka_stenyaev_liniya_2026-11.sql — без него скрипт
 * откажется. Запускать в тот же заход после его COMMIT: «Зарплата» в промежутке не меняется,
 * но дни уже принадлежат ЛИНИИ, а часы лежат в Общестрое, и повторное закрытие ЛИНИИ в этот
 * момент положило бы одни и те же дни в две подачи (тогда скрипт откажется).
 *
 * Строки и основа зарплаты переезжают как есть, остальные сотрудники обеих подач — байт в байт.
 * Подробности — src/services/timesheet-version-employee-move.service.ts.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/fix-liniya-version-employees.ts
 *
 * Без флагов — только отчёт. --yes — перенести. Повтор ничего не делает.
 */
import { closeDb } from '../src/config/postgres.js';
import {
  moveEmployeesBetweenApprovals,
  previewEmployeeMove,
  type IEmployeeMovePlan,
  type IEmployeeMoveRequest,
} from '../src/services/timesheet-version-employee-move.service.js';

const APPLY = process.argv.includes('--yes');

const PRISTAVKA = 6550;
const STENYAEV = 1700;

interface IMove extends IEmployeeMoveRequest {
  /** Итоги, снятые с прода 05.11.2026: что-то изменилось — отказ, разбираться заново. */
  expected: { fromBefore: number; fromAfter: number; toBefore: number; toAfter: number };
}

const MOVES: readonly IMove[] = [
  {
    fromApprovalId: 2512, toApprovalId: 2304, employeeIds: [PRISTAVKA],
    expected: { fromBefore: 2742.30, fromAfter: 2635.52, toBefore: 5998.45, toAfter: 6105.23 },
  },
  {
    fromApprovalId: 2513, toApprovalId: 2305, employeeIds: [PRISTAVKA],
    expected: { fromBefore: 3155.66, fromAfter: 3050.71, toBefore: 6310.33, toAfter: 6415.28 },
  },
  {
    fromApprovalId: 2806, toApprovalId: 2772, employeeIds: [PRISTAVKA, STENYAEV],
    expected: { fromBefore: 7835.08, fromAfter: 7629.20, toBefore: 7871.63, toAfter: 8077.51 },
  },
  {
    fromApprovalId: 2807, toApprovalId: 2773, employeeIds: [PRISTAVKA, STENYAEV],
    expected: { fromBefore: 7790.46, fromAfter: 7585.38, toBefore: 8252.74, toAfter: 8457.82 },
  },
];

const printPlan = (plan: IEmployeeMovePlan): void => {
  console.log(`${plan.startDate}..${plan.endDate}: подача ${plan.from.approvalId} (${plan.from.departmentName}) → ${plan.to.approvalId} (${plan.to.departmentName})`);
  if (plan.moved.length === 0) {
    console.log('  уже перенесены, делать нечего');
    return;
  }
  for (const row of plan.moved) console.log(`  ${row.employeeId} ${row.fullName ?? ''}: ${row.hours} ч, дней ${row.days}`);
  for (const [label, side] of [['откуда', plan.from], ['куда', plan.to]] as const) {
    console.log(`  ${label}: ${side.hoursBefore} → ${side.hoursAfter} ч, людей ${side.employeesBefore} → ${side.employeesAfter}, редакция ${side.revision} → ${side.revision + 1}, подтверждений 1С ${side.acks}`);
  }
};

const assertExpected = (move: IMove, plan: IEmployeeMovePlan): void => {
  if (plan.moved.length === 0) return;
  const actual = {
    fromBefore: plan.from.hoursBefore,
    fromAfter: plan.from.hoursAfter,
    toBefore: plan.to.hoursBefore,
    toAfter: plan.to.hoursAfter,
  };
  if (JSON.stringify(actual) !== JSON.stringify(move.expected)) {
    throw new Error(`подача ${move.fromApprovalId}: итоги не совпали с ожидаемыми: ${JSON.stringify(actual)} вместо ${JSON.stringify(move.expected)}`);
  }
  const moved = new Set(plan.moved.map(row => row.employeeId));
  if (moved.size !== move.employeeIds.length) {
    throw new Error(`подача ${move.fromApprovalId}: перенесётся ${moved.size} из ${move.employeeIds.length} сотрудников`);
  }
};

const main = async (): Promise<void> => {
  // Сначала проверяются все пары: при любом отказе не записано ничего.
  for (const move of MOVES) {
    const plan = await previewEmployeeMove(move);
    printPlan(plan);
    assertExpected(move, plan);
  }
  if (!APPLY) {
    console.log('\nВ БД ничего не записано. Числа сходятся. Перенести — с --yes.');
    return;
  }

  for (const move of MOVES) {
    const result = await moveEmployeesBetweenApprovals(move);
    console.log(result.created
      ? `подача ${move.fromApprovalId} → ${move.toApprovalId}: редакции ${result.fromRevision} и ${result.toRevision}, перенесены ${result.movedIds.join(', ')}`
      : `подача ${move.fromApprovalId} → ${move.toApprovalId}: без изменений`);
  }
  console.log('\nГотово.');
};

main()
  .catch(error => {
    console.error('Перенос не выполнен:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
