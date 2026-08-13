/**
 * Откат массового продления карт (страница SIGUR) по operationId.
 *
 * Вся логика — в src/services/sigur-bulk-cards-rollback.service.ts (там же тесты);
 * здесь только разбор аргументов и печать отчёта.
 *
 * По умолчанию — dry-run: ничего не пишется ни в Sigur, ни в БД.
 *
 * Запуск:
 *   npx tsx scripts/rollback-bulk-card-extend.ts --operation=<uuid>
 *   npx tsx scripts/rollback-bulk-card-extend.ts --operation=<uuid> --apply
 *
 * Коды возврата: 0 — чисто, 1 — есть неподтверждённые/неудачные исходы, 2 — ошибка запуска.
 */
import { rollbackBulkExtendOperation } from '../src/services/sigur-bulk-cards-rollback.service.js';

const readArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const operationId = readArg('operation');
  if (!operationId) {
    console.error('Укажите --operation=<uuid> (operationId из отчёта или журнала аудита)');
    process.exit(2);
  }

  const apply = hasFlag('apply');
  console.log(`[rollback] операция ${operationId}, режим: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const result = await rollbackBulkExtendOperation({ operationId, apply });

  console.log('--- Итог ---');
  console.log(`Кандидатов на возврат:      ${result.candidates}`);
  console.log(`Возвращено карт:            ${result.restoredCards}${apply ? '' : ' (план)'}`);
  console.log(`Не удалось:                 ${result.failedCards}`);
  console.log(`Результат не подтверждён:   ${result.unknownCards}`);
  console.log(`Изменены после операции:    ${result.changedAfterOperation}`);
  console.log(`Возвращено сроков пропусков: ${result.restoredPasses}`);
  if (result.missingCompleted) {
    console.log('ВНИМАНИЕ: у операции нет итоговой записи — она могла оборваться на середине.');
  }
  result.warnings.forEach(warning => console.log(`! ${warning}`));

  const problems = result.items.filter(item =>
    item.status === 'rollback_failed' || item.status === 'rollback_unknown');
  if (problems.length > 0) {
    console.log('--- Требуют внимания ---');
    problems.forEach(item => {
      console.log(
        `employee=${item.employeeId} card=${item.cardId} status=${item.status} `
        + `observed=${item.observedExpiration ?? '—'} error=${item.error ?? '—'}`,
      );
    });
  }

  process.exit(problems.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('[rollback] fatal:', error);
  process.exit(2);
});
