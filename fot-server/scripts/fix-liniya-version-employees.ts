/**
 * Разовый перенос Приставки (6550) и Стеняева (1700) из закрытых подач ЛИНИЯ-Общестрой
 * в закрытые подачи ЛИНИИ за сентябрь и октябрь 2026.
 *
 * Их часы лежат в редакциях Общестроя, в редакциях ЛИНИИ у них пустые строки: открытое
 * назначение ошибочно оставалось в Общестрое (перевод задним числом 08.07.2026). Назначения
 * правит docs/manual-migrations/pristavka_stenyaev_liniya_2026-11.sql — без него скрипт
 * откажется. Запускать в тот же заход после его COMMIT: «Зарплата» в промежутке не меняется,
 * но дни уже принадлежат ЛИНИИ, а часы лежат в Общестрое.
 *
 * Все пары — одна транзакция: при любом отказе не применяется ничего. Строки и основа зарплаты
 * переезжают как есть, остальные сотрудники обеих подач — байт в байт. Суммы здесь не зашиты:
 * кадры переоткрывают табели, сервис сверяет результат по строкам.
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

// Сентябрь Стеняева не переносим: его часы лежат в личной подаче, в подачах Общестроя его нет.
const MOVES: readonly IEmployeeMoveRequest[] = [
  { fromApprovalId: 2512, toApprovalId: 2304, employeeIds: [PRISTAVKA] },
  { fromApprovalId: 2513, toApprovalId: 2305, employeeIds: [PRISTAVKA] },
  { fromApprovalId: 2806, toApprovalId: 2772, employeeIds: [PRISTAVKA, STENYAEV] },
  { fromApprovalId: 2807, toApprovalId: 2773, employeeIds: [PRISTAVKA, STENYAEV] },
];

const round2 = (value: number): number => Math.round(value * 100) / 100;

const printPlan = (plan: IEmployeeMovePlan): void => {
  console.log(`${plan.startDate}..${plan.endDate}: подача ${plan.from.approvalId} (${plan.from.departmentName}) → ${plan.to.approvalId} (${plan.to.departmentName})`);
  console.log(`  состояние: ${plan.state === 'move' ? 'будет перенос' : 'уже перенесены, делать нечего'}`);
  for (const row of plan.employees) console.log(`  ${row.employeeId} ${row.fullName ?? ''}: ${row.hours} ч, дней ${row.days}`);
  for (const [label, side] of [['откуда', plan.from], ['куда', plan.to]] as const) {
    console.log(`  ${label}: версия ${side.versionId}, редакция ${side.revision}, ${side.hoursBefore} → ${side.hoursAfter} ч, людей ${side.employeesBefore} → ${side.employeesAfter}`);
  }
  const before = round2(plan.from.hoursBefore + plan.to.hoursBefore);
  const after = round2(plan.from.hoursAfter + plan.to.hoursAfter);
  console.log(`  сумма двух подач: ${before} → ${after}`);
  if (before !== after) throw new Error(`подача ${plan.from.approvalId}: сумма часов двух подач меняется`);
};

const main = async (): Promise<void> => {
  // Сначала показываем все пары: при любом отказе не записано ничего.
  const plans: IEmployeeMovePlan[] = [];
  for (const move of MOVES) {
    const plan = await previewEmployeeMove(move);
    printPlan(plan);
    plans.push(plan);
  }
  const pending = plans.filter(plan => plan.state === 'move').length;
  if (!APPLY) {
    console.log(`\nВ БД ничего не записано. К переносу пар: ${pending} из ${plans.length}. Перенести — с --yes.`);
    return;
  }

  const result = await moveEmployeesBetweenApprovals(MOVES);
  for (const pair of result.pairs) {
    console.log(`подача ${pair.fromApprovalId} → ${pair.toApprovalId}: редакции ${pair.fromRevision} и ${pair.toRevision}, перенесены ${pair.movedIds.join(', ')}`);
  }
  console.log(`\nГотово. Перенесено пар: ${result.pairs.length} из ${MOVES.length}. Запуск ${result.runId}.`);
};

main()
  .catch(error => {
    console.error('Перенос не выполнен, ничего не записано:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDb(); });
