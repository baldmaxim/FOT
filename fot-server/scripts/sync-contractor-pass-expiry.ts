/**
 * Ручной прогон синхронизации «Срока» подрядных пропусков с Sigur — тот же сервис, что
 * у ночного планировщика (src/services/contractor-pass-expiry-sync.service.ts, там же тесты);
 * здесь только разбор аргументов и печать отчёта.
 *
 * По умолчанию — dry-run: ничего не пишется. Первый боевой прогон — только после
 * просмотра dry-run: все 31.12.2026 без изменений, нет сдвига дат на ±1 день.
 *
 * Запуск:
 *   npx tsx scripts/sync-contractor-pass-expiry.ts
 *   npx tsx scripts/sync-contractor-pass-expiry.ts --apply
 *   npx tsx scripts/sync-contractor-pass-expiry.ts --apply --force   (снять предохранитель массового сдвига)
 *
 * Коды возврата: 0 — прогон завершён (в том числе с безопасными пропусками),
 * 1 — предохранитель или partial (временные сбои), 2 — ошибка запуска.
 */
import {
  runContractorPassExpirySync,
  type PassExpirySkipReason,
  type PassExpiryWriteIssue,
} from '../src/services/contractor-pass-expiry-sync.service.js';

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Сколько номеров пропусков печатать по одной причине. */
const MAX_LISTED = 50;

const SKIP_LABELS: Record<PassExpirySkipReason, string> = {
  invalid_card_uid: 'W26 из card_uid не выводится',
  ambiguous_w26: 'W26 у нескольких карт каталога',
  card_multi_pass: 'Карта на нескольких пропусках',
  no_binding: 'Карта не привязана к профилю пропуска',
  duplicate_binding: 'Повторная привязка карты',
  invalid_date: 'Срок в Sigur не распознан',
  unreadable: 'Профиль Sigur не прочитан (временно)',
};

const ISSUE_LABELS: Record<PassExpiryWriteIssue, string> = {
  reread_failed: 'Перечитывание карты не удалось',
  changed_during_run: 'Привязка изменилась во время прогона',
  conflict: 'Пропуск изменён параллельно (CAS)',
  db_error: 'Ошибка записи в БД',
  aborted: 'Остановлено: потерян lock',
};

const listNumbers = (numbers: string[]): string =>
  numbers.slice(0, MAX_LISTED).join(', ') + (numbers.length > MAX_LISTED ? ` … (+${numbers.length - MAX_LISTED})` : '');

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const force = hasFlag('force');
  if (force && !apply) {
    console.error('--force допустим только вместе с --apply');
    process.exit(2);
  }

  console.log(`[pass-expiry] режим: ${apply ? 'APPLY' : 'DRY-RUN'}${force ? ' + FORCE' : ''}`);
  const result = await runContractorPassExpirySync({ dryRun: !apply, force, triggeredBy: 'cli' });

  console.log('--- Итог ---');
  console.log(`Статус:                 ${result.status}`);
  console.log(`Пропусков в скоупе:     ${result.eligible}`);
  console.log(`Совпадает с Sigur:      ${result.unchanged}`);
  console.log(`Правок по плану:        ${result.changes.length}`);
  console.log(`Записано:               ${result.updated}${apply ? '' : ' (dry-run)'}`);
  if (result.massChange) {
    console.log(
      `ВНИМАНИЕ: предохранитель — меняется больше половины пропусков.${force ? ' Снят --force.' : ' Запись не выполняется.'}`,
    );
  }

  const skipped = (Object.keys(SKIP_LABELS) as PassExpirySkipReason[]).filter(key => result.skipped[key].length > 0);
  if (skipped.length > 0) {
    console.log('--- Не синхронизированы ---');
    skipped.forEach(key => {
      console.log(`${SKIP_LABELS[key]}: ${result.skipped[key].length} — ${listNumbers(result.skipped[key])}`);
    });
  }

  const issues = (Object.keys(ISSUE_LABELS) as PassExpiryWriteIssue[]).filter(key => result.writeIssues[key].length > 0);
  if (issues.length > 0) {
    console.log('--- Сбои записи ---');
    issues.forEach(key => {
      console.log(`${ISSUE_LABELS[key]}: ${result.writeIssues[key].length} — ${listNumbers(result.writeIssues[key])}`);
    });
  }

  if (result.changes.length > 0) {
    console.log('--- Правки: № пропуска: было → станет (срок в Sigur) ---');
    result.changes.forEach(change => {
      const outcome = change.outcome === 'planned' ? '' : ` [${change.outcome}]`;
      console.log(
        `№ ${change.passNumber}: ${change.oldExpiresAt ?? '—'} → ${change.newExpiresAt ?? 'бессрочно'} `
        + `(${change.sigurExpiration ?? 'без срока'})${outcome}`,
      );
    });
  }

  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch(error => {
  console.error('[pass-expiry] fatal:', error);
  process.exit(2);
});
