/**
 * Табель ФОТ = табель 1С (ЗУП): правки «ЗУП» по плану сверки — одной транзакцией, всё или ничего.
 * Подробности — src/services/timesheet-zup-align.{types,snapshot,apply,revert,verify}.ts.
 *
 * Запуск на сервере — рабочий каталог папка сайта (там production .env):
 *   cd /srv/sites/fot.su10.ru/fot-server
 *   NODE_ENV=production /opt/fot-build/fot-server/node_modules/.bin/tsx \
 *     /opt/fot-build/fot-server/scripts/zup-timesheet-align.ts --plan <plan.json> --actor-email <почта админа>
 *
 *   без --apply           — пробный прогон: всё считается в транзакции, печатается и откатывается;
 *   --apply               — записать; резервная копия пишется рядом с планом ДО фиксации;
 *   --source <xlsx 1С>    — сверить SHA-256 файла 1С с планом;
 *   --revert <backup.json> [--apply] — откат по резервной копии (сначала пробно);
 *   --verify <backup.json>           — проверка после записи (только чтение): пересборка, основа, живой табель.
 *
 * Локально — только с NODE_ENV=test: иначе dotenv с override подставит прод-DATABASE_URL из .env.
 */
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

import { closeDb, withReadOnlySnapshot, withTransaction } from '../src/config/postgres.js';
import { resolveCorrectionActor } from '../src/services/object-kpi-zos-correction.service.js';
import { applyZupPlan, ZupPlanStaleError, type IZupActor } from '../src/services/timesheet-zup-align.apply.js';
import { parseZupBackup, revertZupBackup, ZupRevertConflictError } from '../src/services/timesheet-zup-align.revert.js';
import { loadZupDaySnapshots } from '../src/services/timesheet-zup-align.snapshot.js';
import { parseZupPlan, type IZupBackup } from '../src/services/timesheet-zup-align.types.js';
import { verifyZupRun } from '../src/services/timesheet-zup-align.verify.js';

const args = process.argv.slice(2);
const argValue = (name: string): string | null => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const APPLY = args.includes('--apply');
const PLAN = argValue('--plan');
const SOURCE = argValue('--source');
const REVERT = argValue('--revert');
const VERIFY = argValue('--verify');
const ACTOR_EMAIL = argValue('--actor-email');

class DryRunRollback extends Error {}

const deps = { loadSnapshots: loadZupDaySnapshots };
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Резервная копия: временный файл → fsync → переименование → перечитать и сверить хэш. Сбой — исключение (ROLLBACK). */
const writeBackupAtomic = (file: string, backup: IZupBackup): string => {
  const body = JSON.stringify(backup);
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const digest = sha256(readFileSync(file));
  if (digest !== sha256(body)) throw new Error('Резервная копия записалась не полностью');
  return digest;
};

const printList = (title: string, rows: Array<Record<string, unknown>>, limit = 40): void => {
  console.log(`${title}: ${rows.length}`);
  for (const row of rows.slice(0, limit)) console.log(`  ${Object.values(row).join(' | ')}`);
  if (rows.length > limit) console.log(`  … ещё ${rows.length - limit}`);
};

const resolveActor = async (client: Parameters<typeof resolveCorrectionActor>[0]): Promise<IZupActor> => {
  if (!ACTOR_EMAIL) throw new Error('Укажите --actor-email <почта администратора>');
  const actor = await resolveCorrectionActor(client, ACTOR_EMAIL);
  if (!actor.userId) throw new Error(`Учётная запись ${ACTOR_EMAIL} без id`);
  console.log(`Ответственный: ${actor.userName ?? actor.userId}`);
  return { userId: actor.userId, email: ACTOR_EMAIL.trim() };
};

const runApply = async (): Promise<void> => {
  if (!PLAN) throw new Error('Укажите --plan <plan.json>');
  const plan = parseZupPlan(readJson(PLAN));
  if (SOURCE) {
    const digest = sha256(readFileSync(SOURCE));
    if (digest !== plan.source.sha256) throw new Error(`Файл 1С ${SOURCE}: SHA-256 ${digest} ≠ ${plan.source.sha256} из плана`);
  }
  console.log(`План ${plan.run_id}: ${plan.items.length} дн., месяц ${plan.month}, файл 1С ${plan.source.file} (${plan.source.sha256.slice(0, 12)}…)`);
  const backupFile = path.join(path.dirname(path.resolve(PLAN)), `zup-backup-${plan.run_id}.json`);

  await withTransaction(async (client) => {
    const actor = await resolveActor(client);
    const { report, backup } = await applyZupPlan(client, plan, actor, deps);
    console.log(`Записать: ${report.written} дн. (${Object.entries(report.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}); уже как в 1С: ${report.alreadyApplied}`);
    console.log(`Снимается строк: ${report.removedRows}; переносится вложений: ${report.movedLinks}; подач на пересборку: ${report.approvalIds.length}`);
    if (!APPLY) throw new DryRunRollback();
    const digest = writeBackupAtomic(backupFile, backup);
    console.log(`Резервная копия: ${backupFile} (SHA-256 ${digest})`);
  });
  console.log(`\nЗаписано. Проверка через ~5 мин: --verify ${backupFile}. Откат: --revert ${backupFile} (сначала без --apply).`);
};

const runRevert = async (file: string): Promise<void> => {
  const backup = parseZupBackup(readJson(file));
  console.log(`Откат прогона ${backup.run_id}: ${backup.days.length} дн.`);
  await withTransaction(async (client) => {
    const actor = await resolveActor(client);
    const report = await revertZupBackup(client, backup, actor);
    console.log(`Вернуть строк: ${report.restoredRows}, вложений: ${report.restoredLinks}; снять перенесённых ссылок: ${report.removedMovedLinks}; подач на пересборку: ${report.approvalIds.length}`);
    if (!APPLY) throw new DryRunRollback();
  });
  console.log('\nОткат записан.');
};

const runVerify = async (file: string): Promise<void> => {
  const backup = parseZupBackup(readJson(file));
  const issues = await withReadOnlySnapshot(client => verifyZupRun(client, backup, deps));
  console.log(`Проверка прогона ${backup.run_id}: ${backup.days.length} дн., подач ${backup.approval_ids.length}`);
  if (issues.length === 0) {
    console.log('ОК: подачи пересобраны, основа зарплаты и живой табель — как в 1С.');
    return;
  }
  printList('Расхождения', issues as unknown as Array<Record<string, unknown>>);
  process.exitCode = 2;
};

const main = async (): Promise<void> => {
  try {
    if (VERIFY) await runVerify(VERIFY);
    else if (REVERT) await runRevert(REVERT);
    else await runApply();
  } catch (error) {
    if (error instanceof DryRunRollback) {
      console.log('\nПробный прогон: в БД ничего не записано. Записать — тот же запуск с --apply.');
      return;
    }
    if (error instanceof ZupPlanStaleError || error instanceof ZupRevertConflictError) {
      printList(error.message, error.days as unknown as Array<Record<string, unknown>>);
    }
    throw error;
  }
};

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(`\nОТКАЗ, в БД ничего не записано: ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
