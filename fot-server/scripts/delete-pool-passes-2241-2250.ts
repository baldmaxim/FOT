/**
 * Одноразовое удаление пропусков из общего пула подрядчика: №2241–2250
 * (чтобы последний пропуск в пуле снова стал 2240).
 *
 * Контекст: эти пропуска свободны (status=in_pool, без держателя/заявки/объекта),
 * но каждый — это Sigur-профиль «Пропуск NNNN» (в папке пула, blocked) с привязанной
 * картой. Штатной кнопки удаления из пула в UI нет. Полное удаление = удалить
 * Sigur-профиль (снимает и привязку карты) + строку contractor_passes.
 *
 * Безопасность: правим ТОЛЬКО строки, реально свободные в пуле
 * (status='in_pool' AND org_department_id IS NULL AND submission_id IS NULL
 *  AND holder_name IS NULL AND skud_object_id IS NULL). Любая занятая/несоответствующая
 * строка пропускается с предупреждением. Sigur-удаление best-effort: если профиль
 * уже отсутствует (404/422) — считаем orphan и всё равно чистим БД.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/delete-pool-passes-2241-2250.ts            # dry-run, только план
 *   npx tsx scripts/delete-pool-passes-2241-2250.ts --migrate  # применить
 */
import { query, execute } from '../src/config/postgres.js';
import { sigurService } from '../src/services/sigur.service.js';
import { isContractorSigurDryRun } from '../src/config/contractor.js';

const FROM = 2241;
const TO = 2250;
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[delete-pool-2241-2250]';

interface IPassRow {
  id: string;
  pass_number: string;
  status: string;
  org_department_id: string | null;
  submission_id: string | null;
  holder_name: string | null;
  skud_object_id: string | null;
  card_uid: string | null;
  sigur_employee_id: number | null;
}

const isSigurNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { response?: { status?: number }; status?: number; message?: string };
  const status = e.response?.status ?? e.status;
  if (status === 404 || status === 422) return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('404');
};

const isFreeInPool = (p: IPassRow): boolean =>
  p.status === 'in_pool'
  && p.org_department_id === null
  && p.submission_id === null
  && p.holder_name === null
  && p.skud_object_id === null;

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись)' : 'DRY-RUN (только план)'} | диапазон ${FROM}–${TO}`);

  const rows = await query<IPassRow>(
    `SELECT id, pass_number, status,
            org_department_id::text AS org_department_id,
            submission_id::text AS submission_id,
            holder_name,
            skud_object_id::text AS skud_object_id,
            card_uid, sigur_employee_id
       FROM contractor_passes
      WHERE pass_number::int BETWEEN $1 AND $2
      ORDER BY pass_number::int`,
    [FROM, TO],
  );

  if (rows.length === 0) {
    console.log(`${LOG} в диапазоне ${FROM}–${TO} строк нет — нечего удалять.`);
    process.exit(0);
  }

  const eligible: IPassRow[] = [];
  for (const p of rows) {
    if (isFreeInPool(p)) {
      eligible.push(p);
      console.log(`${LOG}   №${p.pass_number}: УДАЛИТЬ (sigur_emp=${p.sigur_employee_id ?? 'NULL'}, card=${p.card_uid ?? 'NULL'})`);
    } else {
      console.warn(
        `${LOG}   №${p.pass_number}: ПРОПУСК — не свободен `
        + `(status=${p.status}, org=${p.org_department_id ?? 'NULL'}, sub=${p.submission_id ?? 'NULL'}, `
        + `holder=${p.holder_name ?? 'NULL'}, object=${p.skud_object_id ?? 'NULL'})`,
      );
    }
  }

  console.log(`${LOG} к удалению: ${eligible.length} из ${rows.length} найденных.`);

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД и Sigur не изменялись. Запусти с --migrate.`);
    process.exit(0);
  }

  const dryRunSigur = isContractorSigurDryRun();
  const connection = dryRunSigur ? undefined : await sigurService.getBackgroundConnectionType();

  let deleted = 0;
  for (const p of eligible) {
    try {
      // 1) Sigur: удалить профиль (снимает и привязку карты). Best-effort.
      if (!dryRunSigur && p.sigur_employee_id != null) {
        try {
          await sigurService.deleteEmployee(p.sigur_employee_id, connection);
          console.log(`${LOG}   №${p.pass_number}: Sigur-профиль ${p.sigur_employee_id} удалён`);
        } catch (e) {
          if (isSigurNotFound(e)) {
            console.warn(`${LOG}   №${p.pass_number}: Sigur-профиль ${p.sigur_employee_id} уже отсутствует (orphan)`);
          } else {
            // Не чистим БД, если Sigur упал по реальной причине — иначе профиль повиснет orphan.
            throw e;
          }
        }
      }

      // 2) БД: удалить строку пропуска (guard повторно — на случай гонки).
      const res = await execute(
        `DELETE FROM contractor_passes
          WHERE id = $1::uuid
            AND status = 'in_pool' AND org_department_id IS NULL
            AND submission_id IS NULL AND holder_name IS NULL AND skud_object_id IS NULL`,
        [p.id],
      );
      if (res > 0) {
        deleted += 1;
        console.log(`${LOG}   №${p.pass_number}: строка БД удалена`);
      } else {
        console.warn(`${LOG}   №${p.pass_number}: строка БД НЕ удалена (изменилась под нами?)`);
      }
    } catch (e) {
      console.error(`${LOG}   №${p.pass_number}: ОШИБКА — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`${LOG} ИТОГО удалено: ${deleted} из ${eligible.length}.`);

  // Контроль: что осталось в диапазоне.
  const left = await query<{ pass_number: string }>(
    `SELECT pass_number FROM contractor_passes
      WHERE pass_number::int BETWEEN $1 AND $2 ORDER BY pass_number::int`,
    [FROM, TO],
  );
  console.log(`${LOG} осталось в ${FROM}–${TO}: ${left.length ? left.map(r => r.pass_number).join(', ') : 'пусто ✔'}`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
