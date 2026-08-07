/**
 * Кто пользовался пропусками старого образца за последние N дней (READ-ONLY).
 *
 * Ничего не пишет — ни в Sigur, ни в БД. Отвечает на вопрос «сколько людей останется
 * без прохода, если погасить белый пластик» перед запуском block-contractor-old-cards.ts.
 *
 * Два пути, потому что номер карты в журнале проходов ФОТ не сохраняется
 * (skud_events.card_number пуст: маппер берёт cardKey только если это строка):
 *   A) по БД — сотрудник со старой картой имел проходы за период;
 *   B) по сырым событиям Sigur — raw.cardKey в любом виде, точный ответ «кто какой картой».
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/usage-contractor-old-cards.ts --days=7
 *   ... --no-sigur-events   — пропустить путь B (только БД, секунды вместо минут)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import type { ICardRow } from '../src/services/old-card-block.collect.js';

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
const PASS_DETECTED_TYPE_ID = 6;

type Category =
  | 'old_only_active'
  | 'old_only_idle'
  | 'mixed_active'
  | 'new_only_active'
  | 'disputed_active'
  | 'other';

const CATEGORY_TITLE: Record<Category, string> = {
  old_only_active: 'Не подтверждённо новая карта + проходы (кандидаты)',
  old_only_idle: 'Не подтверждённо новая карта, проходов нет',
  mixed_active: 'Есть и модульная, и неподтверждённая карта, есть проходы',
  new_only_active: 'Только карты, связанные с модулем, есть проходы',
  disputed_active: 'Нераспознанные карты, есть проходы',
  other: 'Прочее (без карт / без проходов)',
};

interface IExactStats {
  attempted: boolean;
  rawEvents: number;
  passEvents: number;
  withCardKey: number;
  resolved: number;
  interpretation: string;
  samples: string[];
  /** Сколько разных сотрудников встретилось в событиях Sigur (включая корневых). */
  employeesSeen: number;
  /** Ключи первого сырого события — чтобы видеть, какие поля Sigur вообще отдаёт. */
  rawKeys: string[];
}

interface IPersonRow {
  sigurEmployeeId: number;
  name: string | null;
  org: string | null;
  scopeBucket: string;
  cards: ICardRow[];
  passes: number;
  lastAt: string | null;
  category: Category;
  oldCardW26: string | null;
  oldCardFacility: number | null;
  passNumber: string | null;
  /** Проходы, подтверждённые cardKey из сырых событий Sigur (путь B). */
  exactOldPasses: number | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const days = Number(getArg('days') ?? 7);
  if (!Number.isFinite(days) || days <= 0 || days > 180) throw new Error('--days должен быть 1..180');
  const skipSigurEvents = argv.includes('--no-sigur-events');

  console.log(`=== Использование пропусков старого образца за ${days} дн. (READ-ONLY) ===\n`);

  const collect = await import('../src/services/old-card-block.collect.js');
  const { query } = await import('../src/config/postgres.js');
  const { sigurService } = await import('../src/services/sigur.service.js');

  const state = await collect.collectLiveState({ requireRootless: false });

  // ── Путь A: активность по БД ─────────────────────────────────────────────────────
  const activity = await query<{ sigur_employee_id: string; passes: string; last_at: string }>(
    `SELECT e.sigur_employee_id::text AS sigur_employee_id,
            count(*)::text          AS passes,
            max(s.event_at)::text   AS last_at
       FROM skud_events s
       JOIN employees e ON e.id = s.employee_id
      WHERE s.event_date >= current_date - $1::int
        AND e.sigur_employee_id IS NOT NULL
      GROUP BY 1`,
    [days],
  );
  const activityBySigurId = new Map<number, { passes: number; lastAt: string }>();
  for (const row of activity) {
    activityBySigurId.set(Number(row.sigur_employee_id), {
      passes: Number(row.passes),
      lastAt: row.last_at,
    });
  }
  console.log(`[БД] сотрудников с проходами за ${days} дн.: ${activityBySigurId.size}`);

  // ── Путь B: сырые события Sigur ──────────────────────────────────────────────────
  let exactByEmployeeCard = new Map<string, number>();
  let exactStats: IExactStats = {
    attempted: false,
    rawEvents: 0,
    passEvents: 0,
    withCardKey: 0,
    resolved: 0,
    interpretation: '—',
    samples: [],
    employeesSeen: 0,
    rawKeys: [],
  };
  /** Активность прямо из Sigur: покрывает корневых и тех, кого режет whitelist синхронизации. */
  let sigurActivity = new Map<number, { passes: number; lastAt: string | null }>();

  if (!skipSigurEvents) {
    const exact = await collectExactUsage(sigurService, state, days);
    const { pairs, activity, ...stats } = exact;
    exactStats = stats;
    exactByEmployeeCard = pairs;
    sigurActivity = activity;
  }

  // ── Категоризация ────────────────────────────────────────────────────────────────
  const cardsByEmployee = new Map<number, ICardRow[]>();
  for (const row of state.rows) {
    const list = cardsByEmployee.get(row.sigurEmployeeId) ?? [];
    list.push(row);
    cardsByEmployee.set(row.sigurEmployeeId, list);
  }

  const people: IPersonRow[] = [];
  for (const employee of state.employees.values()) {
    if (employee.scopeBucket !== 'contractors' && employee.scopeBucket !== 'rootless') continue;

    const cards = cardsByEmployee.get(employee.id) ?? [];
    // Активность Sigur полнее БД: whitelist skud_sync_department_filter режет часть отделов,
    // а корневых сотрудников в employees нет вовсе. Берём максимум из двух источников.
    const dbAct = activityBySigurId.get(employee.id) ?? null;
    const sigAct = sigurActivity.get(employee.id) ?? null;
    const passes = Math.max(dbAct?.passes ?? 0, sigAct?.passes ?? 0);
    const lastAt = [dbAct?.lastAt ?? null, sigAct?.lastAt ?? null]
      .filter((value): value is string => !!value)
      .sort()
      .pop() ?? null;

    const hasNew = cards.some(card => card.generation === 'module_linked');
    const hasOld = cards.some(card => card.generation === 'not_proven_new'
      || card.generation === 'confirmed_white');
    const hasDisputed = cards.some(card => card.generation === 'unknown');
    const active = passes > 0;

    let category: Category = 'other';
    if (hasOld && !hasNew && active) category = 'old_only_active';
    else if (hasOld && !hasNew && !active) category = 'old_only_idle';
    else if (hasOld && hasNew && active) category = 'mixed_active';
    else if (!hasOld && hasNew && active) category = 'new_only_active';
    else if (hasDisputed && active) category = 'disputed_active';

    const oldCard = cards.find(card => card.generation === 'not_proven_new'
      || card.generation === 'confirmed_white') ?? null;
    const exactKey = oldCard ? `${employee.id}:${oldCard.cardId}` : null;

    people.push({
      sigurEmployeeId: employee.id,
      name: employee.name,
      org: employee.departmentName,
      scopeBucket: employee.scopeBucket,
      cards,
      passes,
      lastAt,
      category,
      oldCardW26: oldCard?.w26 ?? null,
      oldCardFacility: oldCard?.facility ?? null,
      passNumber: oldCard?.passNumber ?? null,
      exactOldPasses: exactKey ? exactByEmployeeCard.get(exactKey) ?? 0 : null,
    });
  }

  // ── Сводка ───────────────────────────────────────────────────────────────────────
  const byCategory = new Map<Category, IPersonRow[]>();
  for (const person of people) {
    const list = byCategory.get(person.category) ?? [];
    list.push(person);
    byCategory.set(person.category, list);
  }

  const oldActive = byCategory.get('old_only_active') ?? [];
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  Ходят по НЕ подтверждённым как новые картам за ${days} дн.: ${oldActive.length} чел.`);
  console.log('  ВНИМАНИЕ: это НЕ список к блокировке. Право гасить даёт только');
  console.log('  confirmation-файл (scripts/build-white-confirmation.ts).');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('── Разбивка ──');
  for (const category of Object.keys(CATEGORY_TITLE) as Category[]) {
    const list = byCategory.get(category) ?? [];
    if (list.length === 0) continue;
    console.log(`  ${CATEGORY_TITLE[category]}: ${list.length}`);
  }

  const byOrg = new Map<string, number>();
  for (const person of oldActive) {
    const key = person.scopeBucket === 'rootless' ? '(корень, вне папок)' : person.org ?? '—';
    byOrg.set(key, (byOrg.get(key) ?? 0) + 1);
  }
  console.log('\n── Потеряют доступ, по организациям (топ-20) ──');
  for (const [org, count] of [...byOrg.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20)) {
    console.log(`  ${org}: ${count}`);
  }

  console.log('\n── Источники активности ──');
  if (!exactStats.attempted) {
    console.log('  события Sigur пропущены (--no-sigur-events); активность только по БД');
  } else {
    console.log(`  Sigur: ${exactStats.rawEvents} событий, PASS_DETECTED ${exactStats.passEvents}, `
      + `сотрудников ${exactStats.employeesSeen}`);
    console.log(`  БД (skud_events): сотрудников ${activityBySigurId.size}`);
    const onlyInSigur = oldActive.filter(person => !activityBySigurId.has(person.sigurEmployeeId)).length;
    console.log(`  из них найдены только в Sigur (whitelist синхронизации / корень): ${onlyInSigur}`);
    console.log(`  поля сырого события: ${exactStats.rawKeys.join(', ') || '—'}`);
    console.log(`  событий с заполненным cardKey: ${exactStats.withCardKey}`);
    if (exactStats.withCardKey === 0) {
      console.log('  → номер карты Sigur в событиях не отдаёт: какой именно картой прошёл человек,');
      console.log('    установить нельзя. Вывод сделан по принадлежности карт: у этих людей');
      console.log('    нет ни одной новой карты, значит проходили старой.');
    } else {
      console.log(`  распознано карт: ${exactStats.resolved} (интерпретация: ${exactStats.interpretation})`);
      console.log(`  сотрудников с подтверждённым проходом именно по старой карте: ${
        people.filter(person => (person.exactOldPasses ?? 0) > 0).length}`);
      if (exactStats.samples.length > 0) console.log(`  примеры cardKey: ${exactStats.samples.join(', ')}`);
    }
  }

  // ── Excel ────────────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const xlsxPath = path.join(OUT_DIR, `usage-old-cards-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
  await writeWorkbook(xlsxPath, people, byCategory, exactStats, days);
  console.log(`\nExcel: ${xlsxPath}`);
}

/** Выгрузка сырых событий Sigur и попытка резолва cardKey в карту каталога. */
async function collectExactUsage(
  sigurService: typeof import('../src/services/sigur.service.js')['sigurService'],
  state: Awaited<ReturnType<typeof import('../src/services/old-card-block.collect.js')['collectLiveState']>>,
  days: number,
): Promise<IExactStats & {
  pairs: Map<string, number>;
  activity: Map<number, { passes: number; lastAt: string | null }>;
}> {
  const pairs = new Map<string, number>();
  const activity = new Map<number, { passes: number; lastAt: string | null }>();
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  console.log(`\n[sigur] выгрузка событий ${start.toISOString()} … ${end.toISOString()} (может занять минуты)`);

  let raw: Record<string, unknown>[];
  try {
    raw = await sigurService.getRawEvents(
      start.toISOString(),
      end.toISOString(),
      state.connection,
    ) as Record<string, unknown>[];
  } catch (error) {
    console.warn(`[sigur] выгрузка событий не удалась: ${(error as Error).message}`);
    return {
      attempted: true,
      rawEvents: 0,
      passEvents: 0,
      withCardKey: 0,
      resolved: 0,
      interpretation: '—',
      samples: [],
      employeesSeen: 0,
      rawKeys: [],
      pairs,
      activity,
    };
  }

  // Индексы каталога карт для резолва cardKey.
  const byCardId = new Set<number>(state.cardFactsById.keys());
  const byValue = new Map<string, number>();
  const byW26 = new Map<string, number>();
  const normValue = (value: string): string => value.toUpperCase().replace(/^0+/, '');
  const normW26 = (value: string): string => {
    const match = value.replace(/\s/g, '').match(/^(\d+),(\d+)$/);
    return match ? `${Number(match[1])},${Number(match[2])}` : '';
  };
  for (const facts of state.cardFactsById.values()) {
    if (facts.value) byValue.set(normValue(facts.value), facts.cardId);
    if (facts.w26) byW26.set(normW26(facts.w26), facts.cardId);
  }

  const hits: Record<string, number> = { cardId: 0, value: 0, w26: 0, decimal: 0 };
  const resolveCardKey = (key: string): number | null => {
    const trimmed = key.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const asId = Number(trimmed);
      if (byCardId.has(asId)) { hits.cardId += 1; return asId; }
      // Десятичное представление 3-байтового value.
      const asHex = normValue(asId.toString(16).toUpperCase());
      const byDecimal = byValue.get(asHex);
      if (byDecimal) { hits.decimal += 1; return byDecimal; }
    }
    const byHex = byValue.get(normValue(trimmed));
    if (byHex) { hits.value += 1; return byHex; }
    const w26Key = normW26(trimmed);
    if (w26Key) {
      const found = byW26.get(w26Key);
      if (found) { hits.w26 += 1; return found; }
    }
    return null;
  };

  let passEvents = 0;
  let withCardKey = 0;
  let resolved = 0;
  const samples: string[] = [];

  for (const event of raw) {
    const typeId = typeof event.eventTypeId === 'number'
      ? event.eventTypeId
      : (typeof event.type === 'number' ? event.type : null);
    if (typeId !== PASS_DETECTED_TYPE_ID) continue;
    passEvents += 1;

    // Активность по sigurEmployeeId — доступна даже без cardKey и покрывает всех,
    // включая корневых сотрудников и отделы вне whitelist синхронизации.
    const eventEmployeeId = typeof event.accessObjectId === 'number' ? event.accessObjectId : null;
    if (eventEmployeeId) {
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : null;
      const acc = activity.get(eventEmployeeId) ?? { passes: 0, lastAt: null };
      acc.passes += 1;
      if (timestamp && (!acc.lastAt || timestamp > acc.lastAt)) acc.lastAt = timestamp;
      activity.set(eventEmployeeId, acc);
    }

    const cardKeyRaw = event.cardKey;
    if (cardKeyRaw === null || cardKeyRaw === undefined || cardKeyRaw === '') continue;
    withCardKey += 1;
    const cardKey = String(cardKeyRaw);
    if (samples.length < 5 && !samples.includes(cardKey)) samples.push(cardKey);

    const cardId = resolveCardKey(cardKey);
    if (!cardId) continue;
    resolved += 1;

    if (!eventEmployeeId) continue;
    const key = `${eventEmployeeId}:${cardId}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  const interpretation = Object.entries(hits)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name} (${count})`)
    .join(', ') || '—';

  return {
    attempted: true,
    rawEvents: raw.length,
    passEvents,
    withCardKey,
    resolved,
    interpretation,
    samples,
    employeesSeen: activity.size,
    rawKeys: raw.length > 0 ? Object.keys(raw[0]) : [],
    pairs,
    activity,
  };
}

async function writeWorkbook(
  filePath: string,
  people: readonly IPersonRow[],
  byCategory: ReadonlyMap<Category, IPersonRow[]>,
  exactStats: IExactStats,
  days: number,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Показатель', key: 'metric', width: 52 },
    { header: 'Значение', key: 'value', width: 22 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow({ metric: 'Период, дней', value: days });
  summary.addRow({ metric: 'Сотрудников в скоупе (подрядчики + корень)', value: people.length });
  for (const category of Object.keys(CATEGORY_TITLE) as Category[]) {
    summary.addRow({ metric: CATEGORY_TITLE[category], value: (byCategory.get(category) ?? []).length });
  }
  summary.addRow({ metric: '— источники активности —', value: '' });
  summary.addRow({ metric: 'Сырых событий Sigur', value: exactStats.attempted ? exactStats.rawEvents : 'пропущено' });
  summary.addRow({ metric: 'PASS_DETECTED', value: exactStats.passEvents });
  summary.addRow({ metric: 'Сотрудников в событиях Sigur', value: exactStats.employeesSeen });
  summary.addRow({ metric: 'Событий с заполненным cardKey', value: exactStats.withCardKey });
  summary.addRow({ metric: 'Карт распознано', value: exactStats.resolved });
  summary.addRow({ metric: 'Интерпретация cardKey', value: exactStats.interpretation });
  summary.addRow({ metric: 'Поля сырого события Sigur', value: exactStats.rawKeys.join(', ') || '—' });

  const personColumns: Partial<ExcelJS.Column>[] = [
    { header: 'sigurEmployeeId', key: 'sigurEmployeeId', width: 16 },
    { header: 'ФИО', key: 'name', width: 34 },
    { header: 'Организация', key: 'org', width: 30 },
    { header: 'Скоуп', key: 'scopeBucket', width: 13 },
    { header: 'W26 старой карты', key: 'oldCardW26', width: 17 },
    { header: 'facility', key: 'oldCardFacility', width: 9 },
    { header: 'Пропуск', key: 'passNumber', width: 12 },
    { header: 'Карт всего', key: 'cardsCount', width: 11 },
    { header: 'Проходов (БД)', key: 'passes', width: 14 },
    { header: 'Последний проход', key: 'lastAt', width: 24 },
    { header: 'Проходов по старой (Sigur)', key: 'exactOldPasses', width: 25 },
  ];

  const addPeopleSheet = (title: string, rows: readonly IPersonRow[]): void => {
    const sheet = workbook.addWorksheet(title);
    sheet.columns = personColumns;
    sheet.getRow(1).font = { bold: true };
    for (const person of rows) {
      sheet.addRow({ ...person, cardsCount: person.cards.length });
    }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: personColumns.length } };
  };

  const oldActive = [...(byCategory.get('old_only_active') ?? [])]
    .sort((left, right) => right.passes - left.passes);
  addPeopleSheet('Кандидаты (не подтверждены)', oldActive);

  const orgSheet = workbook.addWorksheet('По организациям');
  orgSheet.columns = [
    { header: 'Организация', key: 'org', width: 36 },
    { header: 'Потеряют доступ', key: 'lose', width: 16 },
    { header: 'Всего проходов', key: 'passes', width: 16 },
  ];
  orgSheet.getRow(1).font = { bold: true };
  const orgAgg = new Map<string, { lose: number; passes: number }>();
  for (const person of oldActive) {
    const key = person.scopeBucket === 'rootless' ? '(корень, вне папок)' : person.org ?? '—';
    const acc = orgAgg.get(key) ?? { lose: 0, passes: 0 };
    acc.lose += 1;
    acc.passes += person.passes;
    orgAgg.set(key, acc);
  }
  for (const [org, acc] of [...orgAgg.entries()].sort((left, right) => right[1].lose - left[1].lose)) {
    orgSheet.addRow({ org, lose: acc.lose, passes: acc.passes });
  }

  addPeopleSheet('Смешанные', byCategory.get('mixed_active') ?? []);
  addPeopleSheet('Спорные', byCategory.get('disputed_active') ?? []);
  addPeopleSheet('Старая карта без проходов', byCategory.get('old_only_idle') ?? []);

  await workbook.xlsx.writeFile(filePath);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
