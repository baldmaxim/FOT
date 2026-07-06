/**
 * Бэкфилл ФИО и account_id для номеров МТС Бизнес в mts_business_number_map.
 *
 * Проблема: номера, попавшие в number_map через детализацию звонков (CDR), а не
 * через HierarchyStructure, остаются БЕЗ account_id — и потому не обогащаются
 * ежедневным/еженедельным синком (баланс/тариф/ФИО) и не резолвятся в карточке.
 * Плюс у многих номеров нет mts_fio (список показывает «цифры без ФИО»).
 *
 * Что делает:
 *   A) account_id: number_map.account_id ← из mts_business_cdr (по msisdn_hash),
 *      где он NULL.
 *   B) ФИО: для номеров без сотрудника и без mts_fio (но с определимым account_id)
 *      дёргает PersonalData/PersonalDataInfo и сохраняет через syncMtsNames
 *      (то же, что делает планировщик: mts_fio + автопривязка при точном ФИО).
 *
 * По умолчанию — DRY-RUN (только чтение БД + чтение МТС, ничего не пишет).
 * Запись — только с флагом --apply.
 *
 * Запуск на проде (env корректен, БД на запись):
 *   cd /opt/fot-build && npx tsx fot-server/scripts/backfill-mts-business-number-fio.ts          # preview
 *   cd /opt/fot-build && npx tsx fot-server/scripts/backfill-mts-business-number-fio.ts --apply   # запись
 *
 * ПДн (ФИО/полный номер) в вывод не печатаются. Read-only из локальной сессии
 * НЕ пройдёт (--apply требует записи) — запускать в прод-контексте.
 */
import { query, execute } from '../src/config/postgres.js';
import { encryptionService } from '../src/services/encryption.service.js';
import { mtsBusinessCatalogService } from '../src/services/mts-business-catalog.service.js';
import { mtsBusinessMappingService } from '../src/services/mts-business-mapping.service.js';

const APPLY = process.argv.includes('--apply');
const maskMsisdn = (m: string): string => (m.length >= 6 ? `${m.slice(0, 4)}***${m.slice(-2)}` : '***');

interface ICandidate {
  msisdn_hash: string;
  msisdn_enc: string | null;
  account_id: string | null;
}

const main = async (): Promise<void> => {
  console.log(`Бэкфилл ФИО/account_id номеров МТС Бизнес — режим: ${APPLY ? 'APPLY (запись)' : 'DRY-RUN (только чтение)'}`);

  // --- A) account_id из CDR ---
  const [{ missing }] = await query<{ missing: number }>(
    `SELECT count(*)::int AS missing FROM mts_business_number_map WHERE account_id IS NULL`,
  );
  const [{ fillable }] = await query<{ fillable: number }>(
    `SELECT count(*)::int AS fillable
       FROM mts_business_number_map nm
      WHERE nm.account_id IS NULL
        AND EXISTS (SELECT 1 FROM mts_business_cdr c WHERE c.msisdn_hash = nm.msisdn_hash AND c.account_id IS NOT NULL)`,
  );
  console.log(`[A] account_id NULL: ${missing}, из них восстановимо из CDR: ${fillable}`);
  if (APPLY && fillable > 0) {
    const upd = await execute(
      `UPDATE mts_business_number_map nm
          SET account_id = c.account_id
         FROM (SELECT DISTINCT ON (msisdn_hash) msisdn_hash, account_id
                 FROM mts_business_cdr WHERE account_id IS NOT NULL
                ORDER BY msisdn_hash, started_at DESC) c
        WHERE nm.msisdn_hash = c.msisdn_hash AND nm.account_id IS NULL`,
    );
    console.log(`[A] account_id проставлен строкам: ${upd}`);
  }

  // --- B) ФИО через PersonalDataInfo ---
  // account_id резолвим COALESCE'ом (number_map → CDR), чтобы dry-run и apply
  // обрабатывали один и тот же набор кандидатов.
  const candidates = await query<ICandidate>(
    `SELECT nm.msisdn_hash, nm.msisdn_enc,
            COALESCE(nm.account_id,
              (SELECT c.account_id FROM mts_business_cdr c
                WHERE c.msisdn_hash = nm.msisdn_hash AND c.account_id IS NOT NULL
                ORDER BY c.started_at DESC LIMIT 1)) AS account_id
       FROM mts_business_number_map nm
      WHERE nm.employee_id IS NULL AND (nm.mts_fio IS NULL OR nm.mts_fio = '')`,
  );
  const withAccount = candidates.filter(c => c.account_id && c.msisdn_enc);
  console.log(`[B] Кандидатов без ФИО: ${candidates.length}, из них с определимым account_id: ${withAccount.length}`);

  let found = 0;
  let empty = 0;
  let failed = 0;
  let linked = 0;
  for (const c of withAccount) {
    const msisdn = encryptionService.decryptField(c.msisdn_enc);
    if (!msisdn) {
      failed++;
      continue;
    }
    try {
      const fio = await mtsBusinessCatalogService.getPersonalDataFio(c.account_id as string, msisdn);
      if (!fio) {
        empty++;
        continue;
      }
      found++;
      if (APPLY) {
        const res = await mtsBusinessMappingService.syncMtsNames([{ msisdn, fio }], null);
        linked += res.autoLinked;
      }
      console.log(`  ${maskMsisdn(msisdn)} → ФИО получено${APPLY ? ' (сохранено)' : ''}`);
    } catch {
      // Без ПДн в лог: только факт неудачи.
      failed++;
    }
  }

  console.log(`[B] Итог: ФИО получено ${found}, пусто ${empty}, ошибок ${failed}, автопривязано к сотрудникам ${linked}`);
  if (!APPLY) console.log('DRY-RUN: в БД ничего не записано. Повтори с --apply для записи.');
  process.exit(0);
};

void main().catch(err => {
  console.error('Бэкфилл упал:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
