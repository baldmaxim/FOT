/**
 * Ремедиация подрядных пропусков «Нет пропуска»: перенос именной карты на КОНТРАГЕНТСКИЙ
 * профиль, если она сейчас привязана к другому профилю ТОГО ЖЕ человека (старый профиль
 * увольнения / ручной Sigur-профиль без отдела).
 *
 * БЕЗ флага только показывает план (DRY-RUN, read-only). Реальная запись в Sigur — только
 * при REMEDIATE=1.
 *
 * Pre-check на каждую карту (НЕ полагаемся на авто-перепривязку):
 *  - владелец = контрагентский профиль  → уже ок, пропуск;
 *  - карта не привязана                 → привязать к контрагентскому;
 *  - владелец = тот же человек (ФИО)    → перенести (rebind);
 *  - владелец = ДРУГОЙ человек          → СТОП, ручной разбор;
 *  - несколько card-записей на W26       → СТОП (multi_record), ручной разбор.
 *
 * ВАЖНО: ищем карту по W26-value (deriveCardW26(uid).value), а не по сырому UID — иначе
 * Sigur её не находит (findCardByCandidates из сырого UID нужный ключ не выводит).
 *
 * Запуск (локально, БД+Sigur — прод):
 *   cd fot-server && npx tsx scripts/remediate-contractor-card-bindings.ts            # dry-run
 *   cd fot-server && REMEDIATE=1 npx tsx scripts/remediate-contractor-card-bindings.ts # запись
 * Список пропусков: env PASS_NUMBERS (по умолчанию 1628,1636,1644,1642).
 * Срок: contractor_passes.expires_at, иначе env DEFAULT_EXP (по умолчанию 2026-12-31 20:59:59).
 *
 * Подключение к прод-БД — по приёму из [[reference_prod_db_local_diagnostics]].
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = 'test';

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
process.env.DATABASE_SSL_CA_PATH = path.resolve(__dirname, '../../.migration/yandex-ca.pem');

const DRY_RUN = process.env.REMEDIATE !== '1';
const PASS_NUMBERS = (process.env.PASS_NUMBERS ?? '1628,1636,1644,1642')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_EXP = process.env.DEFAULT_EXP ?? '2026-12-31 20:59:59';

interface IPassRow {
  pass_number: string;
  holder_name: string | null;
  sigur_employee_id: number | null;
  card_uid: string | null;
  expires_at: string | null;
}

async function main() {
  console.log(`=== Ремедиация привязок подрядных карт (${DRY_RUN ? 'DRY-RUN, ничего не пишем' : 'ЗАПИСЬ В SIGUR'}) ===`);
  console.log(`Пропуска: ${PASS_NUMBERS.join(', ')}\n`);

  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { deriveCardW26 } = await import('../src/services/sigur-card-w26.util.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { assignSigurEmployeeCardBinding } = await import('../src/services/sigur-live-cards.service.js');

  const connection = await sigurService.getBackgroundConnectionType();
  const deptMap = await sigurService.getDepartmentMapCached(connection).catch(() => new Map<number, string>());

  const normInt = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.trim()); if (Number.isFinite(n)) return n; }
    return null;
  };
  const cardIdOf = (raw: Record<string, unknown>): number | null =>
    normInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));
  const bindingOwnerOf = (raw: Record<string, unknown>): number | null => {
    const direct = normInt(resolveField(raw, 'employeeId', 'employee_id'));
    if (direct) return direct;
    const holder = raw.holder as Record<string, unknown> | undefined;
    if (holder && typeof holder === 'object') {
      const t = typeof holder.type === 'string' ? holder.type.toUpperCase() : '';
      if (!t || t === 'EMP' || t === 'EMPLOYEE') return normInt(resolveField(holder, 'holderId', 'holder_id', 'id'));
    }
    return null;
  };
  const resolveOwner = async (id: number) => {
    try {
      const raw = await sigurService.getEmployeeById(id, connection) as Record<string, unknown>;
      const name = String(resolveField(raw, 'name', 'fullName', 'FullName', 'Name') ?? '').trim() || '?';
      const deptId = normInt(resolveField(raw, 'departmentId', 'department_id', 'depId'));
      return { name, dept: deptId != null ? (deptMap.get(deptId) ?? `dept#${deptId}`) : null };
    } catch { return { name: '?', dept: null }; }
  };
  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Тот же человек: одно ФИО является префиксом другого (учитывает суффиксы-дубли «…Ххх»).
  const samePerson = (a: string, b: string) => {
    const x = norm(a); const y = norm(b);
    return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
  };
  const toIso = (d: string | null): string => {
    const src = d && d.trim() ? d : DEFAULT_EXP;
    const parsed = new Date(src);
    return Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_EXP).toISOString() : parsed.toISOString();
  };

  const passes = await query<IPassRow>(
    `SELECT pass_number, holder_name, sigur_employee_id, card_uid, expires_at::text AS expires_at
       FROM contractor_passes
      WHERE pass_number = ANY($1::text[]) AND status='applied'`,
    [PASS_NUMBERS],
  );

  let planned = 0, skipped = 0, done = 0, failed = 0;

  for (const pn of PASS_NUMBERS) {
    const p = passes.find(x => x.pass_number === pn);
    if (!p) { console.log(`${pn}: НЕ найден applied-пропуск — пропуск`); skipped++; continue; }
    if (!p.sigur_employee_id || !p.card_uid) {
      console.log(`${pn} (${p.holder_name}): нет sigur_employee_id/card_uid — пропуск`); skipped++; continue;
    }
    const target = Number(p.sigur_employee_id);
    let value = '', w26 = '';
    try { const d = deriveCardW26(p.card_uid); value = d.value; w26 = d.w26; }
    catch { console.log(`${pn} (${p.holder_name}): нечитаемый card_uid ${p.card_uid} — пропуск`); skipped++; continue; }

    const { matches } = await sigurService.findCardByCandidates([value, w26, p.card_uid], connection);
    const cards = matches as Record<string, unknown>[];
    const cardIds = [...new Set(cards.map(cardIdOf).filter((x): x is number => !!x))];
    if (cardIds.length === 0) {
      console.log(`${pn} (${p.holder_name}): карта W26 ${w26} в Sigur НЕ найдена — ручной разбор`); skipped++; continue;
    }
    if (cardIds.length > 1) {
      console.log(`${pn} (${p.holder_name}): несколько card-записей (${cardIds.join(',')}) на W26 ${w26} — СТОП, ручной разбор`); skipped++; continue;
    }
    const cardId = cardIds[0];

    const binds = await sigurService.getCardBindings({ cardId }, connection) as Record<string, unknown>[];
    const owner = binds.map(bindingOwnerOf).find((x): x is number => !!x) ?? null;

    if (owner === target) {
      console.log(`${pn} (${p.holder_name}): карта ${cardId} уже на контрагентском профиле ${target} — ок, пропуск`); skipped++; continue;
    }

    let ownerStr = '— (не привязана)';
    if (owner) {
      const oi = await resolveOwner(owner);
      ownerStr = `${owner} «${oi.name}»${oi.dept ? ` / ${oi.dept}` : ''}`;
      if (!samePerson(oi.name, p.holder_name ?? '')) {
        console.log(`${pn} (${p.holder_name}): карта ${cardId} на ДРУГОМ человеке ${ownerStr} — СТОП, ручной разбор`); skipped++; continue;
      }
    }

    const expIso = toIso(p.expires_at);
    console.log(`${pn} (${p.holder_name}): перенос карты ${cardId} (W26 ${w26}) ${owner ? `с ${ownerStr}` : '(свободна)'} → профиль ${target}, срок до ${expIso}`);
    planned++;

    if (!DRY_RUN) {
      try {
        const r = await assignSigurEmployeeCardBinding(target, [value, w26], expIso, connection, false);
        console.log(`   ✓ привязано: cardId ${r.card.cardId}, снято с ${r.previousSigurEmployeeId ?? '—'}, reassigned=${r.reassigned}`);
        done++;
      } catch (e) {
        console.log(`   ✗ ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
        failed++;
      }
    }
  }

  console.log(`\n--- Итог ---`);
  console.log(`  к переносу: ${planned}, пропущено/стоп: ${skipped}` + (DRY_RUN ? '' : `, выполнено: ${done}, ошибок: ${failed}`));
  console.log(DRY_RUN
    ? '\nЭто был DRY-RUN. Для записи: REMEDIATE=1 npx tsx scripts/remediate-contractor-card-bindings.ts'
    : '\n=== запись завершена ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
