/**
 * Черновик файла сопоставления для переноса из PassDesk.
 *
 *   npx tsx scripts/passdesk-mapping-draft.ts --in temp/passdesk-preview.xlsx [--out temp/mapping.xlsx]
 *
 * Зачем. Автоправила матчинга на проде не срабатывают: в employees СНИЛС и даты
 * рождения пусты у всех, поэтому превью отдаёт 918 человек без привязки. Но в
 * колонке candidates уже лежат id сотрудников FOT с таким же полным ФИО, и у
 * большинства кандидат ровно один — это сопоставление можно проставить машинно,
 * а человеку оставить спорные.
 *
 * Скрипт только читает: PassDesk не трогает вовсе, из FOT берёт карточки
 * кандидатов, чтобы выбор делался прямо в файле, без похода в портал.
 * Результат — тот же отчёт плюс заполненный employee_id и пояснения.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { query, closeDb } from '../src/config/postgres.js';

const argValue = (name: string): string | null => {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
};

const IN = argValue('--in') ?? 'temp/passdesk-preview.xlsx';
const OUT = argValue('--out') ?? 'temp/passdesk-mapping-draft.xlsx';

const log = (...a: unknown[]): void => console.log('[mapping-draft]', ...a);

/**
 * Как получено значение employee_id — видно при проверке, что машинное, а что нет.
 * Реквизиты переносим только действующим сотрудникам, поэтому «не переносим…» —
 * это тоже результат разметки, а не незаполненная строка.
 */
type MatchKind =
  | 'уже сопоставлен'
  | 'один кандидат, активен'
  | 'один активный из нескольких'
  | 'больше истории СКУД'
  | 'не переносим: уволен в FOT'
  | 'не переносим: все кандидаты уволены'
  | 'нет в FOT';

interface IRow {
  values: Record<string, unknown>;
  candidates: number[];
}

interface ICandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  employment_status: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
  tab_number: string | null;
  is_archived: boolean | null;
  /** Проходы СКУД — по ним видно, по какой карточке человек реально работал. */
  skud: number;
}

/** Действующий = не уволен и не в архиве: таким и переносим. */
const isActive = (c: ICandidate | undefined): boolean =>
  !!c && !c.is_archived && c.employment_status !== 'fired';

const readPreview = async (file: string): Promise<{ columns: string[]; rows: IRow[] }> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Сопоставление');
  if (!ws) throw new Error('В отчёте нет листа «Сопоставление»');
  const columns = (ws.getRow(1).values as unknown[]).slice(1).map(v => String(v ?? ''));
  const rows: IRow[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values: Record<string, unknown> = {};
    columns.forEach((c, i) => { values[c] = row.getCell(i + 1).value; });
    const raw = String(values.candidates ?? '').trim();
    const candidates = raw ? raw.split(',').map(s => Number(s.trim())).filter(Number.isInteger) : [];
    rows.push({ values, candidates });
  });
  return { columns, rows };
};

/** Карточки кандидатов из FOT одним запросом — для колонки с подсказками. */
const loadCandidates = async (ids: number[]): Promise<Map<number, ICandidate>> => {
  if (ids.length === 0) return new Map();
  const rows = await query<ICandidate>(
    `SELECT e.id, e.full_name, d.name AS department, p.name AS position,
            e.employment_status, e.hire_date::text AS hire_date,
            e.dismissal_date::text AS dismissal_date, e.tab_number, e.is_archived,
            COALESCE(s.cnt, 0)::int AS skud
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
       LEFT JOIN (SELECT employee_id, count(*) AS cnt FROM skud_events
                   WHERE employee_id = ANY($1::int[]) GROUP BY employee_id) s ON s.employee_id = e.id
      WHERE e.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map(r => [Number(r.id), { ...r, skud: Number(r.skud) }]));
};

const describe = (c: ICandidate | undefined, id: number): string => {
  if (!c) return `#${id} — не найден в FOT`;
  const parts = [
    `#${c.id}`,
    c.full_name,
    c.department ?? 'без отдела',
    c.position ?? 'без должности',
    c.is_archived ? 'в архиве' : c.employment_status === 'fired' ? 'уволен' : 'активен',
    c.hire_date ? `принят ${c.hire_date}` : 'без даты найма',
    ...(c.dismissal_date ? [`уволен ${c.dismissal_date}`] : []),
    ...(c.tab_number ? [`табель ${c.tab_number}`] : []),
    `проходов ${c.skud}`,
  ];
  return parts.join(' · ');
};

const main = async (): Promise<void> => {
  if (!fs.existsSync(IN)) throw new Error(`Нет файла отчёта: ${IN}`);
  const { columns, rows } = await readPreview(IN);
  log(`Прочитано строк: ${rows.length}`);

  const allIds = [...new Set(rows.flatMap(r => r.candidates))];
  const cards = await loadCandidates(allIds);
  log(`Кандидатов в FOT запрошено: ${allIds.length}, найдено: ${cards.size}`);

  const stats: Record<MatchKind, number> = {
    'уже сопоставлен': 0,
    'один кандидат, активен': 0,
    'один активный из нескольких': 0,
    'больше истории СКУД': 0,
    'не переносим: уволен в FOT': 0,
    'не переносим: все кандидаты уволены': 0,
    'нет в FOT': 0,
  };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Сопоставление');
  const outColumns = [...columns, 'как_сопоставлено', 'кандидаты_фот'];
  ws.addRow(outColumns).font = { bold: true };

  for (const row of rows) {
    const already = Number(row.values.employee_id);
    const active = row.candidates.filter(id => isActive(cards.get(id)));
    let kind: MatchKind;
    let employeeId: number | '' = '';

    if (Number.isInteger(already) && already > 0) {
      kind = 'уже сопоставлен';
      employeeId = already;
    } else if (row.candidates.length === 0) {
      kind = 'нет в FOT';
    } else if (active.length === 0) {
      // Реквизиты уволенным не нужны: оставляем строку пустой с явной причиной.
      kind = row.candidates.length === 1 ? 'не переносим: уволен в FOT' : 'не переносим: все кандидаты уволены';
    } else if (active.length === 1) {
      kind = row.candidates.length === 1 ? 'один кандидат, активен' : 'один активный из нескольких';
      employeeId = active[0];
    } else {
      // Несколько действующих однофамильцев: берём карточку, по которой человек
      // реально работал, — с наибольшим числом проходов СКУД.
      kind = 'больше истории СКУД';
      employeeId = active.reduce((best, id) =>
        (cards.get(id)?.skud ?? 0) > (cards.get(best)?.skud ?? 0) ? id : best, active[0]);
    }
    stats[kind] += 1;

    const hint = row.candidates.map(id => describe(cards.get(id), id)).join('\n');
    const out = outColumns.map(c => {
      if (c === 'employee_id') return employeeId;
      if (c === 'как_сопоставлено') return kind;
      if (c === 'кандидаты_фот') return hint;
      return row.values[c] ?? '';
    });
    const added = ws.addRow(out);
    // Строки с несколькими кандидатами подсвечиваем: там решение проверяемое.
    if (kind === 'больше истории СКУД' || kind === 'один активный из нескольких') {
      added.getCell(outColumns.indexOf('как_сопоставлено') + 1).font = { bold: true };
      added.alignment = { vertical: 'top', wrapText: true };
    }
  }

  ws.columns.forEach(c => { c.width = 20; });
  ws.getColumn(outColumns.indexOf('кандидаты_фот') + 1).width = 70;
  ws.getColumn(outColumns.indexOf('full_name') + 1).width = 34;

  const ws2 = wb.addWorksheet('Итоги');
  ws2.addRow(['как_сопоставлено', 'строк']).font = { bold: true };
  for (const [k, v] of Object.entries(stats)) ws2.addRow([k, v]);
  ws2.addRow(['всего', rows.length]);
  ws2.columns.forEach(c => { c.width = 24; });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await wb.xlsx.writeFile(OUT);

  const filled = Object.entries(stats)
    .filter(([k]) => !k.startsWith('не переносим') && k !== 'нет в FOT')
    .reduce((s2, [, v]) => s2 + v, 0);
  log('Разметка:', stats);
  log(`Заполнено employee_id: ${filled} из ${rows.length}`);
  log(`Черновик: ${OUT}`);
  log('Проверить строки «больше истории СКУД» и «один активный из нескольких», затем --apply --mapping.');
};

main()
  .catch(err => {
    console.error('[mapping-draft] ошибка:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
