/**
 * Диагностика привязок карт у пропусков подрядчиков (READ-ONLY).
 *
 * Проверяет гипотезу: одобренные пропуска (status='applied', is_active=true) висят
 * в Sigur как «Нет пропуска» (state='no_card'), потому что карта так и не привязалась
 * к профилю — связано с нулевым/битым W26 у карты в Sigur.
 *
 * Запуск (локально, БД и Sigur — прод):
 *   cd fot-server && npx tsx scripts/diagnose-contractor-card-bindings.ts
 *
 * Ничего не пишет. Подключение к прод-БД — по приёму из
 * [[reference_prod_db_local_diagnostics]]: чистим ssl-параметры из DATABASE_URL и
 * передаём локальный CA, NODE_ENV=test чтобы dotenv не перетёр override'ом.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1) Готовим env ДО импорта app-модулей (они тянут env.ts с dotenv).
// ВАЖНО: в fot-server/.env DATABASE_URL продублирован — первой строкой устаревший
// supabase-архив, ниже актуальный Yandex. Рабочий бэк грузит dotenv с override:true
// (последняя строка побеждает). Здесь нам нужен NODE_ENV=test (override:false), чтобы
// наши явные process.env пережили загрузку env.ts — поэтому парсим .env сами с
// last-wins семантикой и подставляем актуальный URL явно. См.
// [[reference_prod_db_local_diagnostics]].
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

{
  const dbg = new URL(process.env.DATABASE_URL);
  console.error('[debug] db host:', dbg.hostname, 'db:', dbg.pathname);
}

interface IPassRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  sigur_employee_id: number | null;
  card_uid: string | null;
  status: string;
  approval_status: string;
  is_active: boolean;
  org_department_id: string | null;
  org_name: string | null;
}

// Категория размещения карты относительно контрагентского профиля (детерминированная,
// без рекомендаций — это Фаза 1/2 плана).
type Category =
  | 'on_contractor'            // карта на контрагентском профиле (ок)
  | 'other_profile_same_name'  // карта на другом профиле того же ФИО (кандидат на перенос)
  | 'other_person'             // карта на профиле с другим ФИО (конфликт — стоп)
  | 'unbound'                  // карта найдена, но ни к кому не привязана
  | 'card_not_found'           // карты по card_uid в Sigur нет
  | 'no_uid'                   // у пропуска нет card_uid в БД
  | 'multi_record'             // несколько card-записей на один UID/W26
  | 'error';

async function main() {
  console.log('=== Диагностика карт подрядных пропусков: cardId → owner → отдел (read-only) ===\n');

  // Динамический импорт app-модулей ПОСЛЕ настройки env выше.
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { deriveCardW26 } = await import('../src/services/sigur-card-w26.util.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');

  const connection = await sigurService.getBackgroundConnectionType();

  // Фильтр по подрядной организации: env CONTRACTOR_ORG_ID (uuid) или 'all'.
  // По умолчанию — СТРОЙРЕСУРС ООО (фокус разбора).
  const ORG_ENV = (process.env.CONTRACTOR_ORG_ID ?? '8c191626-53ba-4679-83ca-4ce987c75574').trim();
  const orgFilter = ORG_ENV.toLowerCase() === 'all' ? null : ORG_ENV;

  const passes = await query<IPassRow>(
    `SELECT p.id, p.pass_number, p.holder_name, p.sigur_employee_id, p.card_uid,
            p.status, p.approval_status, p.is_active, p.org_department_id,
            od.name AS org_name
       FROM contractor_passes p
       LEFT JOIN org_departments od ON od.id = p.org_department_id
      WHERE p.status = 'applied' AND p.is_active = true
        AND ($1::uuid IS NULL OR p.org_department_id = $1::uuid)
      ORDER BY p.pass_number::int ASC`,
    [orgFilter],
  );
  console.log(`Подрядных пропусков applied/active${orgFilter ? ` (орг ${orgFilter})` : ' (все орг)'}: ${passes.length}\n`);

  // Карта отделов Sigur (id → имя) для резолва владельца.
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

  // Кэш резолва владельца профиля (id → {name, dept, blocked}).
  const ownerCache = new Map<number, { name: string; dept: string | null; blocked: boolean | null }>();
  const resolveOwner = async (id: number) => {
    if (ownerCache.has(id)) return ownerCache.get(id)!;
    let info = { name: '?', dept: null as string | null, blocked: null as boolean | null };
    try {
      const raw = await sigurService.getEmployeeById(id, connection) as Record<string, unknown>;
      const name = String(resolveField(raw, 'name', 'fullName', 'FullName', 'Name') ?? '').trim() || '?';
      const deptId = normInt(resolveField(raw, 'departmentId', 'department_id', 'depId'));
      const blockedRaw = resolveField(raw, 'blocked', 'Blocked', 'isBlocked');
      info = {
        name,
        dept: deptId != null ? (deptMap.get(deptId) ?? `dept#${deptId}`) : null,
        blocked: typeof blockedRaw === 'boolean' ? blockedRaw : (blockedRaw == null ? null : String(blockedRaw) === 'true'),
      };
    } catch { /* профиль мог быть удалён */ }
    ownerCache.set(id, info);
    return info;
  };

  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  const rows: Array<{ p: IPassRow; w26: string; cardIds: number[]; ownerId: number | null;
    ownerStr: string; format: string | null; category: Category; note: string }> = [];

  for (const p of passes) {
    if (!p.card_uid) {
      rows.push({ p, w26: '—', cardIds: [], ownerId: null, ownerStr: '—', format: null, category: 'no_uid', note: '' });
      continue;
    }
    // ВАЖНО: в Sigur карта лежит по W26-value (напр. '2337B2'), а не по сырому UID.
    // findCardByCandidates из сырого UID такой ключ не выводит — поэтому передаём
    // явно decoded.value и W26-строку, сырой UID оставляем запасным.
    let w26 = '?';
    const candidates: string[] = [];
    try {
      const dec = deriveCardW26(p.card_uid);
      w26 = dec.w26;
      candidates.push(dec.value, dec.w26);
    } catch { /* нечитаемый uid */ }
    candidates.push(p.card_uid);
    try {
      const { matches } = await sigurService.findCardByCandidates(candidates, connection);
      const cards = matches as Record<string, unknown>[];
      if (cards.length === 0) {
        rows.push({ p, w26, cardIds: [], ownerId: null, ownerStr: '—', format: null, category: 'card_not_found', note: '' });
        continue;
      }
      const cardIds = [...new Set(cards.map(cardIdOf).filter((x): x is number => !!x))];
      const format = String(resolveField(cards[0], 'format', 'Format', 'cardFormat') ?? '').trim() || null;

      // Владельцы по всем найденным cardId.
      const owners = new Set<number>();
      for (const cid of cardIds) {
        const binds = await sigurService.getCardBindings({ cardId: cid }, connection) as Record<string, unknown>[];
        for (const b of binds) { const o = bindingOwnerOf(b); if (o) owners.add(o); }
      }
      const ownerList = [...owners];
      const multi = cardIds.length > 1;

      if (ownerList.length === 0) {
        rows.push({ p, w26, cardIds, ownerId: null, ownerStr: '— (не привязана)', format,
          category: multi ? 'multi_record' : 'unbound', note: multi ? `cardIds=${cardIds.join(',')}` : '' });
        continue;
      }
      const ownerId = ownerList[0];
      const oi = await resolveOwner(ownerId);
      const ownerStr = `${ownerId} «${oi.name}»${oi.dept ? ` / ${oi.dept}` : ''}${oi.blocked ? ' [blocked]' : ''}`;
      let category: Category;
      if (ownerId === Number(p.sigur_employee_id)) category = 'on_contractor';
      else if (norm(oi.name) && norm(oi.name) === norm(p.holder_name)) category = 'other_profile_same_name';
      else category = 'other_person';
      const extra: string[] = [];
      if (multi) extra.push(`cardIds=${cardIds.join(',')}`);
      if (ownerList.length > 1) extra.push(`owners=${ownerList.join(',')}`);
      rows.push({ p, w26, cardIds, ownerId, ownerStr, format, category: multi ? 'multi_record' : category, note: extra.join(' ') });
    } catch (e) {
      rows.push({ p, w26, cardIds: [], ownerId: null, ownerStr: '—', format: null, category: 'error',
        note: e instanceof Error ? e.message : String(e) });
    }
  }

  // Таблица.
  console.log('пропуск | holder | contractorId | card_uid | W26 | cardIds | owner | формат | категория | прим.');
  console.log('─'.repeat(170));
  for (const r of rows) {
    console.log([
      r.p.pass_number,
      r.p.holder_name ?? '—',
      r.p.sigur_employee_id ?? '—',
      r.p.card_uid ?? '—',
      r.w26,
      r.cardIds.length ? r.cardIds.join(',') : '—',
      r.ownerStr,
      r.format ?? '—',
      r.category,
      r.note,
    ].join(' | '));
  }

  // Сводка по категориям.
  const byCat = new Map<Category, number>();
  for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
  console.log('\n--- Сводка по категориям ---');
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);

  // apply_error по заявкам затронутых (не on_contractor) пропусков.
  const affected = rows.filter(r => r.category !== 'on_contractor').map(r => r.p.id);
  if (affected.length > 0) {
    const subs = await query<{ id: string; status: string; apply_error: string | null; pass_number: string }>(
      `SELECT s.id, s.status, s.apply_error, p.pass_number
         FROM contractor_passes p JOIN contractor_submissions s ON s.id = p.submission_id
        WHERE p.id = ANY($1::uuid[]) AND s.apply_error IS NOT NULL`,
      [affected],
    );
    if (subs.length > 0) {
      console.log('\n--- apply_error по заявкам затронутых пропусков ---');
      for (const s of subs) console.log(`  пропуск ${s.pass_number} → заявка ${s.id} [${s.status}]: ${s.apply_error}`);
    }
  }

  console.log('\n=== готово (read-only, ничего не записано) ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
