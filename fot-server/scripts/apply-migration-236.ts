/**
 * Применение миграции 236 (docs/migrations/236_fix_dismissal_sync_race_duplicates.sql)
 * БЕЗ psql — через pg-подключение бэкенда. Для случаев, когда psql на проде недоступен.
 *
 * Режимы:
 *   npx tsx scripts/apply-migration-236.ts --check   — только проверка прав и числа кандидатов (read-only)
 *   npx tsx scripts/apply-migration-236.ts --yes     — применить миграцию (BEGIN/COMMIT внутри файла)
 *
 * Запуск: локально из fot-server (DATABASE_URL из .env + CA .migration/yandex-ca.pem)
 * или на проде из /opt/fot-build/fot-server (env с сайта).
 *
 * ВАЖНО: применять только ПОСЛЕ деплоя бэка с фиксом гонки (aa37a813) — иначе
 * ближайшая ночь с увольнениями создаст новые дубли.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

// Локальный запуск: подставляем CA и DATABASE_URL из fot-server/.env (как в diagnose-скриптах).
const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL не найден в fot-server/.env');
    process.exit(1);
  }
  try {
    const u = new URL(rawUrl);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

const MIGRATION_PATH = path.resolve(__dirname, '../../docs/migrations/236_fix_dismissal_sync_race_duplicates.sql');

async function main() {
  const mode = process.argv.includes('--yes') ? 'apply' : process.argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.log('Укажите режим: --check (проверка) или --yes (применить). Ничего не сделано.');
    process.exit(1);
  }

  const { getPool } = await import('../src/config/postgres.js');
  const client = await getPool().connect();
  client.on('notice', msg => console.log('[NOTICE]', msg.message));

  try {
    const who = await client.query<{ current_user: string; db: string }>(
      'SELECT current_user, current_database() AS db',
    );
    console.log(`Подключение: user=${who.rows[0].current_user}, db=${who.rows[0].db}`);

    const priv = await client.query<{ upd_ea: boolean; del_ea: boolean; crt: boolean }>(
      `SELECT has_table_privilege('employee_assignments', 'UPDATE') AS upd_ea,
              has_table_privilege('employee_assignments', 'DELETE') AS del_ea,
              has_database_privilege(current_database(), 'CREATE') AS crt`,
    );
    console.log(`Права: UPDATE employee_assignments=${priv.rows[0].upd_ea}, DELETE=${priv.rows[0].del_ea}, CREATE в БД=${priv.rows[0].crt}`);

    // Строгий предикат кандидатов — тот же, что в миграции (B2).
    const pattern = await client.query<{ cnt: string }>(
      `SELECT count(*) AS cnt
         FROM employee_assignments dup
         JOIN employees e ON e.id = dup.employee_id
         JOIN employee_assignments nextr ON nextr.employee_id = dup.employee_id
          AND nextr.org_department_id = dup.org_department_id
          AND nextr.effective_from = dup.effective_from + 1
          AND nextr.change_reason = 'Увольнение — перевод в папку "Уволенные"'
         JOIN employee_assignments prevr ON prevr.employee_id = dup.employee_id
          AND prevr.effective_to = dup.effective_from - 1
          AND prevr.org_department_id <> dup.org_department_id
        WHERE dup.effective_from = dup.effective_to
          AND dup.effective_from >= '2026-07-01' AND dup.effective_from < '2026-08-01'
          AND dup.change_reason IN ('Синхронизация Sigur', 'Увольнение — перевод в папку "Уволенные"')
          AND dup.org_department_id = 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'
          AND e.employment_status = 'fired'
          AND e.dismissal_date = dup.effective_from
          AND e.org_department_id = dup.org_department_id
          AND EXISTS (SELECT 1 FROM employee_dismissal_events ede
                       WHERE ede.employee_id = dup.employee_id
                         AND ede.dismissal_date = dup.effective_from
                         AND ede.from_department_id = prevr.org_department_id)`,
    );
    console.log(`Кандидатов миграции (строгий предикат): ${pattern.rows[0].cnt} (до миграции: 54, после: 0)`);

    if (mode === 'check') {
      if (!priv.rows[0].upd_ea || !priv.rows[0].del_ea) {
        console.log('ВНИМАНИЕ: у этого подключения НЕТ прав на запись — применить миграцию отсюда не получится.');
      } else {
        console.log('Права на запись есть — можно применять с --yes (ПОСЛЕ деплоя бэка!).');
      }
      return;
    }

    // apply
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    console.log(`Применяю ${path.basename(MIGRATION_PATH)} (${sql.length} байт), одна транзакция...`);
    const started = Date.now();
    // Файл содержит BEGIN/COMMIT и завершается диагностическим SELECT —
    // multi-statement выполняется simple-протоколом, результаты приходят массивом.
    const results = await client.query(sql) as unknown as Array<{ command: string; rowCount: number | null; rows: unknown[] }> | { command: string; rows: unknown[] };
    const list = Array.isArray(results) ? results : [results];
    const last = list[list.length - 1];
    console.log(`Готово за ${Date.now() - started} мс. Стейтментов выполнено: ${list.length}.`);
    console.log('Диагностический отчёт (оставшиеся строки паттерна, НЕ обязательно ошибки):');
    console.log(JSON.stringify(last.rows ?? [], null, 2));

    const after = await client.query<{ cnt: string }>(
      `SELECT count(*) AS cnt FROM public.migration_236_backup WHERE migration_name = '236'`,
    );
    console.log(`Строк в backup (migration_236_backup, все kind): ${after.rows[0].cnt}`);
  } finally {
    client.release();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  console.error('Транзакция миграции откатывается автоматически при любой ошибке (всё или ничего).');
  process.exit(1);
});
