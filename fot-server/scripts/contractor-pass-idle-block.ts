/**
 * Ручной запуск автоблокировки пропусков подрядчиков, которые не ходят больше 5 дней — тот же сервис,
 * что у ночного планировщика (src/services/contractor-pass-idle-block.service.ts, там же тесты);
 * здесь только разбор аргументов, lease и печать отчёта. Работает независимо от выключателя ночного прогона.
 *
 * По умолчанию — проверочный прогон: блокировок нет. Начальная очередь — партиями до 300.
 *
 * Запуск:
 *   npx tsx scripts/contractor-pass-idle-block.ts                       (отчёт и список)
 *   npx tsx scripts/contractor-pass-idle-block.ts --apply --limit 20    (пробный прогон)
 *   npx tsx scripts/contractor-pass-idle-block.ts --apply --limit 300   (партия)
 *   npx tsx scripts/contractor-pass-idle-block.ts --apply --force       (только аварийно: снять предел 300)
 *   npx tsx scripts/contractor-pass-idle-block.ts --rollback-run <runId>          (что будет снято)
 *   npx tsx scripts/contractor-pass-idle-block.ts --rollback-run <runId> --apply  (снять партию)
 *   npx tsx scripts/contractor-pass-idle-block.ts --nightly on|off      (ночной прогон)
 *
 * Сервер держит сотрудников Sigur в кэше до 5 минут: карточка покажет блокировку не сразу.
 *
 * Коды возврата: 0 — готово, 1 — остановка или сбои (смотреть отчёт), 2 — ошибка запуска.
 */
import {
  runContractorPassIdleBlock,
  setIdleBlockNightlyEnabled,
  type IIdleBlockResult,
} from '../src/services/contractor-pass-idle-block.service.js';
import {
  rollbackContractorPassIdleRun,
  type IIdleRollbackResult,
} from '../src/services/contractor-pass-idle-rollback.service.js';
import {
  IDLE_BLOCK_DAILY_STATE_KEY,
  IDLE_BLOCK_LEASE_TTL_SECONDS,
} from '../src/services/contractor-pass-idle-block.scheduler.js';
import {
  getSigurRuntimeOwner,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  tryAcquireSigurRuntimeLease,
} from '../src/services/sigur-runtime-state.service.js';

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const flagValue = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const MAX_LISTED = 50;

const listNumbers = (numbers: string[]): string =>
  numbers.slice(0, MAX_LISTED).join(', ') + (numbers.length > MAX_LISTED ? ` … (+${numbers.length - MAX_LISTED})` : '');

/** Тот же lease, что у ночного прогона: две записи одновременно не пойдут. */
async function withLease<T>(work: (isLost: () => boolean) => Promise<T>): Promise<T> {
  const owner = getSigurRuntimeOwner('contractor-pass-idle-block-cli');
  const lease = await tryAcquireSigurRuntimeLease({
    key: IDLE_BLOCK_DAILY_STATE_KEY,
    owner,
    ttlSeconds: IDLE_BLOCK_LEASE_TTL_SECONDS,
  });
  if (!lease.acquired) throw new Error('Идёт другой прогон автоблокировки: lease занят');

  let lost = false;
  const stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
    key: IDLE_BLOCK_DAILY_STATE_KEY,
    owner,
    ttlSeconds: IDLE_BLOCK_LEASE_TTL_SECONDS,
    onLost: () => { lost = true; },
    onError: () => { lost = true; },
  });
  try {
    return await work(() => lost);
  } finally {
    stopHeartbeat();
    await releaseSigurRuntimeLease({ key: IDLE_BLOCK_DAILY_STATE_KEY, owner });
  }
}

const printRun = (result: IIdleBlockResult): void => {
  console.log('--- Итог ---');
  console.log(`Запуск (runId для отката): ${result.runId}`);
  console.log(`Статус:                    ${result.status}`);
  console.log(`Всего в очереди:           ${result.totalCandidates}`);
  console.log(`Взято:                     ${result.selected}`);
  console.log(`Заблокировано:             ${result.blocked}`);
  console.log(`Дописана причина:          ${result.reasonAdded}`);
  console.log(`Уже заблокированы вручную: ${result.alreadyManual}`);
  console.log(`Снова активны (сверка):    ${result.restored}`);
  console.log(`Профиль удалён:            ${result.skipped.length}`);
  console.log(`Изменились за прогон:      ${result.changed.length}`);
  console.log(`Сбои:                      ${result.failed.length}`);
  if (result.status === 'mass_stop') {
    console.log('ВНИМАНИЕ: взято больше 300, блокировок нет. Брать партиями: --limit 300.');
  }
  if (result.status === 'events_gap') {
    console.log('ВНИМАНИЕ: мало проходов за день, блокировок нет. Флаги это не снимают:');
    result.eventGaps.forEach(day => console.log(`  ${day.day}: ${day.events}`));
  }
  if (result.stoppedOnFailures) console.log('ВНИМАНИЕ: 20 ошибок подряд, прогон остановлен.');
  if (result.aborted) console.log('ВНИМАНИЕ: потерян lease, прогон остановлен.');
  if (result.skipped.length > 0) console.log(`Профиль удалён: ${listNumbers(result.skipped)}`);
  if (result.changed.length > 0) console.log(`Изменились за прогон: ${listNumbers(result.changed)}`);
  result.failed.slice(0, MAX_LISTED).forEach(item => console.log(`Сбой № ${item.passNumber}: ${item.error}`));
  if (result.dryRun) {
    console.log('--- Список: № пропуска, подрядчик, ФИО, последний проход, дней ---');
    result.candidates.forEach(row => {
      console.log(
        `№ ${row.pass_number} | ${row.org_name} | ${row.holder_name} | ${row.last_event_date ?? 'не было'} | ${row.days_idle}`,
      );
    });
  }
};

const printRollback = (result: IIdleRollbackResult): void => {
  console.log('--- Откат ---');
  console.log(`Запуск:                 ${result.runId}`);
  console.log(`Режим:                  ${result.dryRun ? 'проверка, ничего не снято' : 'снятие'}`);
  console.log(`Записей партии:         ${result.total}`);
  console.log(`${result.dryRun ? 'Будет снято:          ' : 'Снято:                '}  ${result.unblocked}`);
  console.log(`Только дописана причина: ${result.reasonOnly}`);
  console.log(`Сменился держатель:     ${result.skipped.holder_changed.length} ${listNumbers(result.skipped.holder_changed)}`);
  console.log(`Были действия после:    ${result.skipped.later_action.length} ${listNumbers(result.skipped.later_action)}`);
  console.log(`В чёрном списке:        ${result.skipped.blacklisted.length} ${listNumbers(result.skipped.blacklisted)}`);
  console.log(`Сбои:                   ${result.failed.length}`);
  result.failed.slice(0, MAX_LISTED).forEach(item => console.log(`Сбой № ${item.passNumber}: ${item.error}`));
};

async function main(): Promise<void> {
  const nightly = flagValue('nightly');
  if (hasFlag('nightly')) {
    if (nightly !== 'on' && nightly !== 'off') throw new Error('--nightly принимает on или off');
    await setIdleBlockNightlyEnabled(nightly === 'on');
    console.log(`Ночной прогон: ${nightly === 'on' ? 'включён' : 'выключен'}`);
    process.exit(0);
  }

  const apply = hasFlag('apply');

  if (hasFlag('rollback-run')) {
    const runId = flagValue('rollback-run');
    if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('--rollback-run: нужен runId из отчёта партии');
    const result = apply
      ? await withLease(isLost => rollbackContractorPassIdleRun({ runId, dryRun: false, shouldAbort: isLost }))
      : await rollbackContractorPassIdleRun({ runId, dryRun: true });
    printRollback(result);
    process.exit(result.failed.length === 0 ? 0 : 1);
  }

  const force = hasFlag('force');
  if (force && !apply) throw new Error('--force допустим только вместе с --apply');
  let limit: number | null = null;
  if (hasFlag('limit')) {
    limit = Number(flagValue('limit'));
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit: нужно целое число больше нуля');
  }

  console.log(`[pass-idle-block] режим: ${apply ? 'APPLY' : 'DRY-RUN'}${force ? ' + FORCE' : ''}${limit ? ` + LIMIT ${limit}` : ''}`);
  const result = apply
    ? await withLease(isLost => runContractorPassIdleBlock({
      dryRun: false, force, limit, triggeredBy: 'cli', shouldAbort: isLost,
    }))
    : await runContractorPassIdleBlock({ dryRun: true, force: false, limit, triggeredBy: 'cli' });
  printRun(result);
  process.exit(result.status === 'completed' && result.failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('[pass-idle-block] fatal:', error instanceof Error ? error.message : error);
  process.exit(2);
});
