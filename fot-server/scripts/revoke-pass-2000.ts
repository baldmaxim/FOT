/**
 * Одноразовый возврат подрядного пропуска №2000 в общий пул («отвязка от тестового держателя»).
 *
 * Зачем: пропуск назначен и «применён» (status=applied) на тестового держателя
 * «Тестовый сотрудник ПОДР ТЕСТ». В UI кнопка «Отозвать» есть только во вкладке
 * «Отправленные», а она показывает лишь assigned/submitted/blocked — applied туда не попадает.
 * Поэтому возврат в пул делаем разовым скриптом через штатный enqueueRevoke (та же логика,
 * что у кнопки: транзакция + закрытие holders + пересчёт статуса заявки).
 *
 * Что произойдёт: status→in_pool, обнуление org_department_id/holder_name/submission_id/
 * access_point_names, approval_status='not_submitted', is_active=false, sigur_sync_state=
 * 'pending_revoke'. Живой серверный процесс планировщиком contractor-pass-sync (тик 25с)
 * подхватит строку и в Sigur перенесёт профиль 145592 в папку пула + переименует «Пропуск 2000»
 * + заблокирует. Физическая привязка карты 1827C763… к профилю сохраняется (штатный отзыв
 * карту не снимает) — это и есть «вернуть в пул».
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/revoke-pass-2000.ts            # dry-run, только план
 *   npx tsx scripts/revoke-pass-2000.ts --migrate  # применить
 */
import { queryOne } from '../src/config/postgres.js';
import { enqueueRevoke } from '../src/services/contractor-pool.service.js';

const PASS_ID = 'e05e0194-321d-4ca5-a9f0-e150ba82ca12'; // пропуск №2000, card_uid 1827C76300000000
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[revoke-pass-2000]';

interface IPassRow {
  pass_number: string;
  status: string;
  approval_status: string;
  is_active: boolean;
  holder_name: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | null;
  sigur_sync_state: string;
}

const readPass = (): Promise<IPassRow | null> =>
  queryOne<IPassRow>(
    `SELECT pass_number, status, approval_status, is_active,
            holder_name, org_department_id::text AS org_department_id,
            sigur_employee_id, sigur_sync_state
       FROM contractor_passes WHERE id = $1::uuid`,
    [PASS_ID],
  );

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись в БД)' : 'DRY-RUN (только план)'}`);

  const before = await readPass();
  if (!before) {
    console.error(`${LOG} пропуск ${PASS_ID} не найден — выход.`);
    process.exit(1);
  }
  console.log(
    `${LOG} ДО: №${before.pass_number} | status=${before.status} | approval=${before.approval_status} | `
    + `active=${before.is_active} | holder=${before.holder_name ?? 'NULL'} | `
    + `org=${before.org_department_id ?? 'NULL'} | sigur_emp=${before.sigur_employee_id ?? 'NULL'} | `
    + `sync=${before.sigur_sync_state}`,
  );

  if (before.status === 'in_pool') {
    console.log(`${LOG} пропуск уже в пуле — нечего делать.`);
    process.exit(0);
  }
  if (before.status === 'revoked') {
    console.error(`${LOG} пропуск отозван (revoked) и недоступен — выход.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для применения.`);
    process.exit(0);
  }

  const res = await enqueueRevoke({ passId: PASS_ID, userId: 'cli-oneoff' });
  console.log(`${LOG} enqueueRevoke → ${JSON.stringify(res)}`);

  const after = await readPass();
  console.log(
    `${LOG} ПОСЛЕ: status=${after?.status} | active=${after?.is_active} | `
    + `holder=${after?.holder_name ?? 'NULL'} | org=${after?.org_department_id ?? 'NULL'} | `
    + `sync=${after?.sigur_sync_state}`,
  );
  console.log(
    `${LOG} Ожидаемо: status=in_pool, active=false, holder=NULL, org=NULL, sync=pending_revoke.`,
  );
  console.log(`${LOG} Sigur досинхронит профиль ${before.sigur_employee_id} в ≤25с (планировщик живого сервера).`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
