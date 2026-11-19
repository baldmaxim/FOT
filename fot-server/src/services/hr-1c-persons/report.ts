/**
 * Отчёт предпросмотра = файл решений для записи. Один лист по людям, ключ — Физлицо_id_all.
 * Человек вписывает только «Карточка — вручную (№)»; запись сверяет SHA-256 исходника, дату
 * среза, версию и заголовки и отказывается работать, если что-то не совпало.
 * Номера документов в расхождениях маскируются (последние 4 знака).
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { maskValue } from '../hr-crypto.service.js';
import { fieldLabel, type IDiff, type IFillPlan } from './fill.js';
import { signalLabel, type IDecision } from './match.js';
import type { IPerson1c } from './parse.js';

export const REPORT_VERSION = 'hr-1c-persons/v1';
export const REPORT_SHEET = 'Сверка';
export const REPORT_COLUMNS = [
  'Код 1С (id_all)', 'ФИО (1С)', 'Отдел (1С)', 'Решение', 'Сотрудник FOT №', 'ФИО (FOT)', 'Отдел (FOT)',
  'Как найден', 'Будет заполнено', 'Расхождения (FOT не меняется)', 'Замечания', 'Карточка — вручную (№)',
] as const;
const COL = Object.fromEntries(REPORT_COLUMNS.map((c, i) => [c, i + 1])) as Record<typeof REPORT_COLUMNS[number], number>;
/** Сводка и параметры — справа от таблицы. */
const META_LABEL_COL = REPORT_COLUMNS.length + 2;
const META = { version: 'Версия отчёта', sha: 'SHA-256 исходника', asOf: 'Дата среза', run: 'Предпросмотр' } as const;

export const DECISION_APPLY = 'Заносим';
export const DECISION_MANUAL = 'Проверить вручную';

export interface IReportItem {
  person: IPerson1c;
  decision: IDecision;
  card: { id: number; fullName: string; department: string | null } | null;
  plan: IFillPlan | null;
  needIdAll: boolean;
  remarks: string[];
}

export interface IReportMeta {
  sourceSha256: string;
  asOf: string;
  previewRun: string;
}

const SENSITIVE_DIFF = new Set(['snils', 'inn', 'passport_number', 'kig', 'patent_number', 'phone']);

const maskDiffValue = (field: string, value: string): string => {
  if (SENSITIVE_DIFF.has(field)) return maskValue(value) ?? '';
  if (field === 'registration_address') return value.length > 25 ? `${value.slice(0, 25)}…` : value;
  return value;
};

export const formatDiff = (d: IDiff): string =>
  `${fieldLabel(d.field)}: 1С — ${maskDiffValue(d.field, d.value1c)}; FOT — ${maskDiffValue(d.field, d.valueFot)}${d.note ? ` (${d.note})` : ''}`;

export const howFound = (d: IDecision): string => {
  if (d.kind !== 'apply') return '';
  if (d.tier === 'manual') return 'выбрано вручную';
  if (d.tier === 'name_dept') return 'по ФИО и отделу (ФИО в FOT одно, оба работают)';
  return `по ${d.signals.map(signalLabel).join(', ')}`;
};

const ROW_CONFLICT_LABEL: Record<string, string> = {
  passport: 'паспорт', patent: 'патент', kig: 'КИГ', citizenship: 'гражданство', registration_address: 'адрес', phone: 'телефон',
};

/** Замечания по человеку словами (без значений ПДн). */
export const buildRemarks = (person: IPerson1c, decision: IDecision, plan: IFillPlan | null): string[] => {
  const out = [...decision.reasons];
  const conflicts = person.rowConflicts.filter(c => ROW_CONFLICT_LABEL[c]).map(c => ROW_CONFLICT_LABEL[c]);
  if (conflicts.length > 0) out.push(`в 1С ${person.activeRows} активные записи с разными значениями: ${conflicts.join(', ')} — не заносится`);
  out.push(...person.problems);
  if (plan) {
    out.push(...plan.notes);
    const blockLabel = { passport: 'паспорт', patent: 'патент', kig: 'КИГ' } as const;
    for (const b of plan.skippedBlocks) out.push(`${blockLabel[b]} не заносится целиком — расхождение в блоке`);
  }
  return out;
};

export const writeReport = async (file: string, items: IReportItem[], meta: IReportMeta, summary: Array<[string, number | string]>): Promise<void> => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(REPORT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow([...REPORT_COLUMNS]).font = { bold: true };
  const rank = (it: IReportItem): number => (it.decision.kind === 'manual' ? 0 : (it.plan?.diffs.length ?? 0) > 0 ? 1 : 2);
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || a.person.fullName.localeCompare(b.person.fullName, 'ru'));
  for (const it of sorted) {
    const filled = [...(it.plan?.fields ?? []).map(fieldLabel), ...(it.needIdAll ? ['Код 1С'] : [])];
    const row = ws.addRow([
      it.person.idAll,
      it.person.fullName,
      it.person.departments.join('; '),
      it.decision.kind === 'apply' ? DECISION_APPLY : DECISION_MANUAL,
      it.decision.kind === 'apply' ? it.decision.employeeId : null,
      it.card?.fullName ?? (it.decision.candidates.length > 0 ? `кандидаты: ${it.decision.candidates.map(c => `#${c}`).join(', ')}` : ''),
      it.card?.department ?? '',
      howFound(it.decision),
      filled.join(', '),
      (it.plan?.diffs ?? []).map(formatDiff).join('\n'),
      it.remarks.join('\n'),
      null,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    if (it.decision.kind === 'manual') row.getCell(COL['Решение']).font = { color: { argb: 'FFC00000' }, bold: true };
  }
  const widths = [38, 32, 26, 18, 12, 32, 26, 30, 40, 60, 60, 16];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(META_LABEL_COL).width = 28;
  ws.getColumn(META_LABEL_COL + 1).width = 66;
  const metaRows: Array<[string, string | number]> = [
    [META.version, REPORT_VERSION], [META.sha, meta.sourceSha256], [META.asOf, meta.asOf], [META.run, meta.previewRun],
    ['', ''], ...summary,
  ];
  metaRows.forEach(([label, value], i) => {
    ws.getCell(i + 1, META_LABEL_COL).value = label;
    ws.getCell(i + 1, META_LABEL_COL + 1).value = value;
  });
  ws.getCell(1, META_LABEL_COL).font = { bold: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  fs.chmodSync(file, 0o600);
};

export interface IReportDecision {
  previewKind: 'apply' | 'manual';
  previewEmployeeId: number | null;
  manualEmployeeId: number | null;
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) return cellText((v as { result: ExcelJS.CellValue }).result);
  if (typeof v === 'object' && 'richText' in v) return (v as { richText: Array<{ text: string }> }).richText.map(t => t.text).join('');
  return String(v).trim();
};

const positiveIntOrNull = (v: ExcelJS.CellValue, where: string): number | null => {
  const s = cellText(v);
  if (!s) return null;
  if (!/^\d+$/.test(s) || Number(s) <= 0) throw new Error(`${where}: ожидается номер карточки (целое число)`);
  return Number(s);
};

/** Читает файл решений и сверяет его с исходником. Любое несовпадение — исключение. */
export const readReport = async (file: string, expected: { sourceSha256: string; asOf: string }): Promise<Map<string, IReportDecision>> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(REPORT_SHEET);
  if (!ws) throw new Error(`В отчёте нет листа «${REPORT_SHEET}»`);
  const header = REPORT_COLUMNS.map((_, i) => cellText(ws.getCell(1, i + 1).value));
  if (header.join('|') !== REPORT_COLUMNS.join('|')) throw new Error('Заголовки отчёта изменены — нужен новый предпросмотр');
  const meta = new Map<string, string>();
  for (let r = 1; r <= 6; r += 1) meta.set(cellText(ws.getCell(r, META_LABEL_COL).value), cellText(ws.getCell(r, META_LABEL_COL + 1).value));
  if (meta.get(META.version) !== REPORT_VERSION) throw new Error('Версия отчёта не та — нужен новый предпросмотр');
  if (meta.get(META.sha) !== expected.sourceSha256) throw new Error('Исходный файл 1С изменился после предпросмотра (SHA-256 не совпал)');
  if (meta.get(META.asOf) !== expected.asOf) throw new Error('Дата среза отличается от предпросмотра');

  const out = new Map<string, IReportDecision>();
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const idAll = cellText(ws.getCell(r, COL['Код 1С (id_all)']).value).toLowerCase();
    if (!idAll) continue;
    if (out.has(idAll)) throw new Error(`Строка ${r}: код 1С повторяется`);
    const kind = cellText(ws.getCell(r, COL['Решение']).value);
    if (kind !== DECISION_APPLY && kind !== DECISION_MANUAL) throw new Error(`Строка ${r}: столбец «Решение» изменён`);
    out.set(idAll, {
      previewKind: kind === DECISION_APPLY ? 'apply' : 'manual',
      previewEmployeeId: positiveIntOrNull(ws.getCell(r, COL['Сотрудник FOT №']).value, `Строка ${r}`),
      manualEmployeeId: positiveIntOrNull(ws.getCell(r, COL['Карточка — вручную (№)']).value, `Строка ${r}`),
    });
  }
  return out;
};
