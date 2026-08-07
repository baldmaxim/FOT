/**
 * Разбор истории физически удалённых строк contractor_passes (READ-ONLY).
 *
 * Зачем: приложение удаляет строки пропусков физически (в т.ч. назначенных/поданных),
 * а подчистка профиля в Sigur идёт best-effort. Значит отсутствие строки в БД НЕ
 * доказывает, что карта не проходила через модуль — а именно на этом строится критерий
 * «вне модуля ⇒ не красная». Аудит сохраняет только номер пропуска
 * (contractor-pool.controller.ts:374), поэтому связь с картой восстанавливается адресно.
 *
 * Скрипт собирает все пути удаления и для каждого номера ищет живые следы в Sigur.
 * Результат — JSON с чёрным списком карт и сотрудников, который обязателен для
 * build-white-confirmation.ts и block-contractor-old-cards.ts.
 *
 * Ошибка любого запроса = аварийное завершение: недоказуемость трактуется как запрет.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/diagnose-deleted-passes.ts
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
    const url = new URL(rawUrl);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(key);
    process.env.DATABASE_URL = url.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

const OUT_DIR = path.resolve(__dirname, '../temp');

/** Имя пулового плейсхолдера в Sigur — та же маска, что в contractor-pool.service.ts:414. */
const POOL_PLACEHOLDER_RE = /^\s*Пропуск\s/i;

type Verdict =
  | 'reused'              // номер снова в модуле → покрыт employee-level запретом
  | 'trace_found'         // в Sigur есть живой след → карты в чёрный список
  | 'unresolved_no_trace'; // следов нет: профиль удалён успешно, риска нет

interface IDeletedNumber {
  passNumber: string;
  sources: string[];
  firstSeen: string;
  verdict: Verdict;
  traceEmployeeIds: number[];
  traceCardIds: number[];
  note: string;
}

async function main(): Promise<void> {
  console.log('=== Разбор удалённых строк contractor_passes (READ-ONLY) ===\n');

  const { query } = await import('../src/config/postgres.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  // ── Все пути удаления ────────────────────────────────────────────────────────────
  const deletedRows = await query<{ pass_number: string; source: string; created_at: string }>(
    `SELECT jsonb_array_elements_text(details->'deleted') AS pass_number,
            'pool_passes_deleted'                        AS source,
            created_at::text                             AS created_at
       FROM audit_logs
      WHERE action = 'CONTRACTOR_POOL_PASSES_DELETED'
        AND jsonb_typeof(details->'deleted') = 'array'`,
  );

  const cancelledRows = await query<{ pass_number: string; source: string; created_at: string }>(
    `SELECT jsonb_array_elements_text(details->'cancelled') AS pass_number,
            'cancel_provisioning'                          AS source,
            created_at::text                               AS created_at
       FROM audit_logs
      WHERE action = 'CONTRACTOR_POOL_PASSES_ADDED'
        AND details->>'action' = 'cancel_provisioning'
        AND jsonb_typeof(details->'cancelled') = 'array'`,
  );

  // Прочие действия над пулом — на случай неучтённых путей удаления.
  const otherPoolActions = await query<{ action: string; cnt: string }>(
    `SELECT action, count(*)::text AS cnt
       FROM audit_logs
      WHERE entity_type IN ('contractor_pool', 'contractor_pass')
        AND action NOT IN ('CONTRACTOR_POOL_PASSES_DELETED', 'CONTRACTOR_POOL_PASSES_ADDED')
      GROUP BY 1 ORDER BY 2 DESC`,
  );

  const all = [...deletedRows, ...cancelledRows].filter(row => row.pass_number);
  const byNumber = new Map<string, IDeletedNumber>();
  for (const row of all) {
    const existing = byNumber.get(row.pass_number);
    if (existing) {
      if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
      if (row.created_at < existing.firstSeen) existing.firstSeen = row.created_at;
      continue;
    }
    byNumber.set(row.pass_number, {
      passNumber: row.pass_number,
      sources: [row.source],
      firstSeen: row.created_at,
      verdict: 'unresolved_no_trace',
      traceEmployeeIds: [],
      traceCardIds: [],
      note: '',
    });
  }

  console.log(`[аудит] событий удаления: ${deletedRows.length}, отмен provisioning: ${cancelledRows.length}`);
  console.log(`[аудит] уникальных номеров: ${byNumber.size}`);
  if (otherPoolActions.length > 0) {
    console.log('[аудит] прочие действия над пулом (проверить, нет ли среди них удалений):');
    for (const row of otherPoolActions) console.log(`    ${row.action}: ${row.cnt}`);
  }

  // ── Переиспользованные номера ────────────────────────────────────────────────────
  const numbers = [...byNumber.keys()];
  const reused = await query<{ pass_number: string }>(
    'SELECT DISTINCT pass_number FROM contractor_passes WHERE pass_number = ANY($1::text[])',
    [numbers],
  );
  const reusedSet = new Set(reused.map(row => row.pass_number));
  for (const entry of byNumber.values()) {
    if (reusedSet.has(entry.passNumber)) {
      entry.verdict = 'reused';
      entry.note = 'номер снова в модуле — покрыт employee-level запретом';
    }
  }
  console.log(`[БД] переиспользовано: ${reusedSet.size}, требуют проверки в Sigur: ${byNumber.size - reusedSet.size}`);

  // ── Прямая связь «номер пропуска → профиль Sigur» из аудита ──────────────────────
  // Надёжнее маски имени: у выданного пропуска профиль переименован в ФИО, и
  // «Пропуск N» его уже не находит. CONTRACTOR_PASS_HOLDER_CHANGED и
  // CONTRACTOR_PASS_ACCESS_POINTS_ADDED хранят pass_number и sigur_employee_id вместе.
  const auditLinks = await query<{ pass_number: string; sigur_employee_id: string }>(
    `SELECT details->>'pass_number'        AS pass_number,
            details->>'sigur_employee_id'  AS sigur_employee_id
       FROM audit_logs
      WHERE details ? 'pass_number' AND details ? 'sigur_employee_id'
        AND details->>'pass_number' IS NOT NULL
        AND details->>'sigur_employee_id' ~ '^[0-9]+$'`,
  );
  const employeeIdsByNumber = new Map<string, Set<number>>();
  for (const link of auditLinks) {
    const set = employeeIdsByNumber.get(link.pass_number) ?? new Set<number>();
    set.add(Number(link.sigur_employee_id));
    employeeIdsByNumber.set(link.pass_number, set);
  }
  console.log(`[аудит] связей «номер → профиль»: ${auditLinks.length} по ${employeeIdsByNumber.size} номерам`);

  // ── Поиск живых следов в Sigur ───────────────────────────────────────────────────
  const pending = [...byNumber.values()].filter(entry => entry.verdict !== 'reused');
  if (pending.length > 0) {
    console.log('\n[sigur] выгрузка сотрудников и привязок…');
    const employees = await sigurService.getEmployees(undefined) as Record<string, unknown>[];
    if (!Array.isArray(employees) || employees.length === 0) {
      throw new Error('Sigur не отдал сотрудников — доказать отсутствие следов нельзя, стоп');
    }
    const bindings = await sigurService.getCardBindings(undefined) as Record<string, unknown>[];

    const cardsByEmployee = new Map<number, number[]>();
    for (const raw of bindings) {
      const holder = raw.holder && typeof raw.holder === 'object' ? raw.holder as Record<string, unknown> : null;
      const employeeId = normalizeInt(
        resolveField(raw, 'employeeId', 'employee_id')
        ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
      );
      const cardId = normalizeInt(resolveField(raw, 'cardId', 'card_id', 'id'));
      if (!employeeId || !cardId) continue;
      const list = cardsByEmployee.get(employeeId) ?? [];
      list.push(cardId);
      cardsByEmployee.set(employeeId, list);
    }

    // Индексы: номер из имени «Пропуск N» и номер из примечания «FOT-POOL:N».
    const byPlaceholderNumber = new Map<string, number[]>();
    const byPoolNote = new Map<string, number[]>();
    for (const raw of employees) {
      const id = normalizeInt(resolveField(raw, 'id', 'ID', 'Id'));
      if (!id) continue;
      const name = String(resolveField<string>(raw, 'name', 'fullName', 'full_name') ?? '').trim();
      const note = String(resolveField<string>(raw, 'description', 'note', 'comment') ?? '').trim();

      if (POOL_PLACEHOLDER_RE.test(name)) {
        const match = name.match(/(\d+)/);
        if (match) {
          const list = byPlaceholderNumber.get(match[1]) ?? [];
          list.push(id);
          byPlaceholderNumber.set(match[1], list);
        }
      }
      const noteMatch = note.match(/FOT-POOL\s*:\s*(\d+)/i);
      if (noteMatch) {
        const list = byPoolNote.get(noteMatch[1]) ?? [];
        list.push(id);
        byPoolNote.set(noteMatch[1], list);
      }
    }

    const livingEmployeeIds = new Set<number>();
    for (const raw of employees) {
      const id = normalizeInt(resolveField(raw, 'id', 'ID', 'Id'));
      if (id) livingEmployeeIds.add(id);
    }

    for (const entry of pending) {
      // Три независимых источника следа; связь из аудита работает даже когда профиль
      // переименован из «Пропуск N» в ФИО после выдачи.
      const fromAudit = [...(employeeIdsByNumber.get(entry.passNumber) ?? [])]
        .filter(id => livingEmployeeIds.has(id));
      const traces = new Set<number>([
        ...(byPlaceholderNumber.get(entry.passNumber) ?? []),
        ...(byPoolNote.get(entry.passNumber) ?? []),
        ...fromAudit,
      ]);
      if (traces.size === 0) {
        const known = employeeIdsByNumber.get(entry.passNumber);
        entry.note = known && known.size > 0
          ? `профиль(и) ${[...known].join(', ')} из аудита в Sigur отсутствуют — удалены`
          : 'следов в Sigur нет и связи в аудите нет';
        continue;
      }
      entry.verdict = 'trace_found';
      entry.traceEmployeeIds = [...traces];
      entry.traceCardIds = [...traces].flatMap(id => cardsByEmployee.get(id) ?? []);
      entry.note = `живой профиль в Sigur (${fromAudit.length > 0 ? 'связь из аудита' : 'маска имени'}): `
        + `профилей ${traces.size}, карт ${entry.traceCardIds.length}`;
    }
  }

  // ── Итог ─────────────────────────────────────────────────────────────────────────
  const entries = [...byNumber.values()];
  const count = (verdict: Verdict): number => entries.filter(entry => entry.verdict === verdict).length;
  const traceFound = entries.filter(entry => entry.verdict === 'trace_found');
  const blockedCardIds = [...new Set(traceFound.flatMap(entry => entry.traceCardIds))].sort((l, r) => l - r);
  const blockedEmployeeIds = [...new Set(traceFound.flatMap(entry => entry.traceEmployeeIds))].sort((l, r) => l - r);

  console.log('\n── Итог ──');
  console.log(`  переиспользованы (покрыты запретом): ${count('reused')}`);
  console.log(`  живой след в Sigur → чёрный список: ${count('trace_found')}`);
  console.log(`  следов нет (профиль удалён успешно): ${count('unresolved_no_trace')}`);
  console.log(`\n  карт в чёрном списке: ${blockedCardIds.length}`);
  console.log(`  сотрудников в чёрном списке: ${blockedEmployeeIds.length}`);

  if (traceFound.length > 0) {
    console.log('\n── Номера с живым следом ──');
    for (const entry of traceFound) {
      console.log(`  Пропуск ${entry.passNumber} [${entry.sources.join(',')}] — ${entry.note}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'deleted-passes-blacklist.json');
  fs.writeFileSync(outPath, JSON.stringify({
    kind: 'deleted-passes-blacklist',
    createdAt: new Date().toISOString(),
    totalNumbers: entries.length,
    counts: {
      reused: count('reused'),
      trace_found: count('trace_found'),
      unresolved_no_trace: count('unresolved_no_trace'),
    },
    blockedCardIds,
    blockedEmployeeIds,
    entries,
  }, null, 2), 'utf8');

  console.log(`\nФайл: ${outPath}`);
  console.log('Он обязателен для build-white-confirmation.ts и block-contractor-old-cards.ts.');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
