/**
 * Одноразовый скрипт: заполняет в .xls-таблице сотрудников три колонки —
 * «Номер пропуска», «Время выдачи», «срок действия» — данными из Sigur (СКУД).
 * Матч сотрудников строго по нормализованному ФИО (Sigur employee.name ↔ колонка «Сотрудник»).
 * Запись результата идёт рядом в .xlsx с сохранением форматирования (желтых заливок шапки):
 *   xlsx читает .xls (cellStyles) → конвертирует в .xlsx (xlsx writeFile bookType=xlsx),
 *   затем exceljs дозаполняет три колонки и сохраняет финальный .xlsx.
 *
 * Несколько активных карт — берётся одна с максимальным expirationDate.
 * Не нашли сотрудника / нет активной карты — во все три ячейки пишем «—».
 *
 * Запуск: cd fot-server && npx tsx scripts/fill-sigur-passes-xls.ts [path/to/file.xls]
 *   default path: ../Мосфильмовска.xls
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { sigurService } from '../src/services/sigur.service.js';
import { toCardSummary } from '../src/services/sigur-live-admin.service.js';
import { normalizeFullName } from '../src/utils/fio.utils.js';

const DEFAULT_INPUT = path.resolve(process.cwd(), '..', 'Мосфильмовска.xls');
const CARD_FETCH_CONCURRENCY = 8;
const DASH = '—';

const HEADER_PASS = 'Номер пропуска';
const HEADER_ISSUE = 'Время выдачи';
const HEADER_VALID = 'срок действия';
const HEADER_NAME_CANDIDATES = ['Сотрудник', 'ФИО', 'Ф.И.О.'];
const HEADER_TAB_CANDIDATES = ['Таб. №', 'Таб.№', 'Табельный', 'Таб №'];

interface IRowToFill {
  /** 1-based индекс строки в исходном листе (= в выходном .xlsx). */
  rowIdx: number;
  fullName: string;
  tabNumber: string;
}

interface IResult extends IRowToFill {
  status: 'filled' | 'no-employee' | 'no-active-card' | 'ambiguous-name';
  cardNumber: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

const cleanCell = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
};

const findHeaderRow = (rows: unknown[][]): { rowIdx: number; cols: { name: number; tab: number; pass: number; issue: number; valid: number } } => {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const headerCells = row.map(cell => cleanCell(cell));

    const passCol = headerCells.findIndex(text => text === HEADER_PASS);
    const issueCol = headerCells.findIndex(text => text === HEADER_ISSUE);
    const validCol = headerCells.findIndex(text => text === HEADER_VALID);
    if (passCol < 0 || issueCol < 0 || validCol < 0) continue;

    const nameCol = headerCells.findIndex(text => HEADER_NAME_CANDIDATES.includes(text));
    const tabCol = headerCells.findIndex(text => HEADER_TAB_CANDIDATES.includes(text));
    if (nameCol < 0) {
      throw new Error(`[parser] Шапка найдена на строке ${r + 1}, но колонка ФИО (${HEADER_NAME_CANDIDATES.join(' / ')}) отсутствует.`);
    }
    return {
      rowIdx: r,
      cols: {
        name: nameCol,
        tab: tabCol >= 0 ? tabCol : -1,
        pass: passCol,
        issue: issueCol,
        valid: validCol,
      },
    };
  }
  throw new Error(`[parser] Не найдена шапка с заголовками «${HEADER_PASS}», «${HEADER_ISSUE}», «${HEADER_VALID}».`);
};

const formatDateRu = (raw: string | null): string => {
  if (!raw) return '';
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
};

const pickActiveCard = (cards: ReturnType<typeof toCardSummary>[]): NonNullable<ReturnType<typeof toCardSummary>> | null => {
  const valid = cards.filter((c): c is NonNullable<ReturnType<typeof toCardSummary>> => !!c);
  if (valid.length === 0) return null;

  const now = Date.now();
  const isActive = (c: NonNullable<ReturnType<typeof toCardSummary>>): boolean => {
    if (!c.expirationDate) return false;
    const exp = new Date(c.expirationDate).getTime();
    if (Number.isNaN(exp) || exp < now) return false;
    if (c.startDate) {
      const start = new Date(c.startDate).getTime();
      if (!Number.isNaN(start) && start > now) return false;
    }
    return true;
  };

  const active = valid.filter(isActive);
  if (active.length === 0) return null;

  active.sort((a, b) => {
    const ea = new Date(a.expirationDate || 0).getTime();
    const eb = new Date(b.expirationDate || 0).getTime();
    return eb - ea;
  });
  return active[0];
};

const fetchInChunks = async <T, R>(items: T[], size: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += size) {
    const slice = items.slice(start, start + size);
    const results = await Promise.all(slice.map((item, j) => worker(item, start + j)));
    for (let j = 0; j < results.length; j++) out[start + j] = results[j];
  }
  return out;
};

async function main(): Promise<void> {
  const inputArg = process.argv[2];
  const inputPath = inputArg ? path.resolve(inputArg) : DEFAULT_INPUT;
  if (!fs.existsSync(inputPath)) {
    console.error(`[fill-passes] Файл не найден: ${inputPath}`);
    process.exit(1);
  }
  console.log(`[fill-passes] input:  ${inputPath}`);

  const wbXlsx = XLSX.readFile(inputPath, { cellStyles: true, cellDates: true });
  const sheetName = wbXlsx.SheetNames[0];
  if (!sheetName) {
    console.error('[fill-passes] В книге нет ни одного листа.');
    process.exit(1);
  }
  const ws = wbXlsx.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
  const { rowIdx: headerRowIdx, cols } = findHeaderRow(grid);
  console.log(
    `[fill-passes] header row=${headerRowIdx + 1}, columns: name=${cols.name + 1}, tab=${cols.tab >= 0 ? cols.tab + 1 : '-'}, pass=${cols.pass + 1}, issue=${cols.issue + 1}, valid=${cols.valid + 1}`,
  );

  const rowsToFill: IRowToFill[] = [];
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const fullName = cleanCell(row[cols.name]);
    if (!fullName) break;
    rowsToFill.push({
      rowIdx: r + 1,
      fullName,
      tabNumber: cols.tab >= 0 ? cleanCell(row[cols.tab]) : '',
    });
  }
  console.log(`[fill-passes] rows to fill: ${rowsToFill.length}`);
  if (rowsToFill.length === 0) {
    console.log('[fill-passes] Нечего заполнять, выхожу.');
    process.exit(0);
  }

  console.log('[fill-passes] Загружаю сотрудников Sigur (может занять до минуты)...');
  const sigurEmployees = await sigurService.getEmployeesCached();
  console.log(`[fill-passes] Sigur employees: ${sigurEmployees.length}`);

  console.log('[fill-passes] Загружаю карты Sigur для lookup номера пропуска...');
  const allCards = await sigurService.getCardsCached();
  const cardNumberById = new Map<number, string>();
  for (const raw of allCards) {
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    // Sigur /api/v1/cards: value=HEX UID, formattedValue=decimal W26 (печатается на пропуске).
    // Берём formattedValue (формат на пластиковой карте), fallback на value.
    const formatted = typeof raw.formattedValue === 'string' ? raw.formattedValue.trim() : '';
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    const num = formatted || value;
    if (num) cardNumberById.set(id, num);
  }
  console.log(`[fill-passes] cards indexed: ${cardNumberById.size}`);

  const fioMap = new Map<string, Array<Record<string, unknown>>>();
  for (const emp of sigurEmployees) {
    const name = typeof emp.name === 'string' ? emp.name : '';
    if (!name) continue;
    const key = normalizeFullName(name, { collapseYo: true });
    if (!key) continue;
    const list = fioMap.get(key);
    if (list) list.push(emp); else fioMap.set(key, [emp]);
  }

  const results = await fetchInChunks(rowsToFill, CARD_FETCH_CONCURRENCY, async (row): Promise<IResult> => {
    const key = normalizeFullName(row.fullName, { collapseYo: true });
    const matches = fioMap.get(key) || [];
    if (matches.length === 0) {
      return { ...row, status: 'no-employee', cardNumber: null, startDate: null, expirationDate: null };
    }
    if (matches.length > 1) {
      return { ...row, status: 'ambiguous-name', cardNumber: null, startDate: null, expirationDate: null };
    }
    const employeeId = typeof matches[0].id === 'number' ? matches[0].id : Number(matches[0].id);
    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      return { ...row, status: 'no-employee', cardNumber: null, startDate: null, expirationDate: null };
    }

    let bindings: Record<string, unknown>[] = [];
    try {
      bindings = await sigurService.getCardBindings({ employeeId }) as Record<string, unknown>[];
    } catch (err) {
      console.warn(`[fill-passes] getCardBindings failed for ${row.fullName} (id=${employeeId}):`, (err as Error).message);
    }
    const cards = bindings.map(b => toCardSummary(b));
    const card = pickActiveCard(cards);
    if (!card) {
      return { ...row, status: 'no-active-card', cardNumber: null, startDate: null, expirationDate: null };
    }
    const cardNumber = card.cardNumber || cardNumberById.get(card.cardId) || null;
    return {
      ...row,
      status: 'filled',
      cardNumber,
      startDate: card.startDate,
      expirationDate: card.expirationDate,
    };
  });

  console.log('\n[fill-passes] Результат:');
  console.log('№   статус            Таб.№      ФИО');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const cardInfo = r.status === 'filled'
      ? `${r.cardNumber || DASH} (${formatDateRu(r.startDate)} → ${formatDateRu(r.expirationDate)})`
      : '';
    console.log(
      `${String(i + 1).padStart(3, ' ')}  ${r.status.padEnd(17, ' ')} ${r.tabNumber.padEnd(10, ' ')} ${r.fullName} ${cardInfo}`,
    );
  }
  const summary = {
    filled: results.filter(r => r.status === 'filled').length,
    noEmployee: results.filter(r => r.status === 'no-employee').length,
    noCard: results.filter(r => r.status === 'no-active-card').length,
    ambiguous: results.filter(r => r.status === 'ambiguous-name').length,
  };
  console.log(`\n[fill-passes] summary: filled=${summary.filled}, no-employee=${summary.noEmployee}, no-active-card=${summary.noCard}, ambiguous=${summary.ambiguous}`);

  const outputPath = path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.xlsx`);
  const tempPath = path.join(path.dirname(inputPath), `.tmp-${Date.now()}-${path.basename(inputPath, path.extname(inputPath))}.xlsx`);
  console.log(`[fill-passes] output: ${outputPath}`);

  XLSX.writeFile(wbXlsx, tempPath, { bookType: 'xlsx', cellStyles: true });

  const wbFinal = new ExcelJS.Workbook();
  await wbFinal.xlsx.readFile(tempPath);
  const wsFinal = wbFinal.getWorksheet(sheetName) || wbFinal.worksheets[0];
  if (!wsFinal) throw new Error('[fill-passes] Не удалось открыть лист в сконвертированном .xlsx');

  for (const r of results) {
    const passCellValue = r.status === 'filled' ? (r.cardNumber || DASH) : DASH;
    const issueCellValue = r.status === 'filled' ? (formatDateRu(r.startDate) || DASH) : DASH;
    const validCellValue = r.status === 'filled' ? (formatDateRu(r.expirationDate) || DASH) : DASH;
    wsFinal.getCell(r.rowIdx, cols.pass + 1).value = passCellValue;
    wsFinal.getCell(r.rowIdx, cols.issue + 1).value = issueCellValue;
    wsFinal.getCell(r.rowIdx, cols.valid + 1).value = validCellValue;
  }

  // Копируем заливки из исходного .xls (xlsx community при .xls→.xlsx конвертации стили теряет).
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  let fillsCopied = 0;
  for (let rr = range.s.r; rr <= range.e.r; rr++) {
    for (let cc = range.s.c; cc <= range.e.c; cc++) {
      const addr = XLSX.utils.encode_cell({ r: rr, c: cc });
      const cell = ws[addr];
      const style = cell?.s as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
      const rgb = style?.fgColor?.rgb;
      if (!rgb || style?.patternType !== 'solid') continue;
      if (rgb.toUpperCase() === 'FFFFFF') continue;
      wsFinal.getCell(rr + 1, cc + 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${rgb}` },
      };
      fillsCopied++;
    }
  }
  console.log(`[fill-passes] copied fills: ${fillsCopied}`);

  await wbFinal.xlsx.writeFile(outputPath);
  fs.unlinkSync(tempPath);
  console.log(`[fill-passes] Готово: ${outputPath}`);
}

main().catch(err => {
  console.error('[fill-passes] FATAL:', err);
  process.exit(1);
});
