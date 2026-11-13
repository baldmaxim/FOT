/**
 * Выравнивание табеля ФОТ по табелю 1С (ЗУП): план, резервная копия и их проверка.
 *
 * План строит сверка (scratchpad, `build_zup_plan.py`) только на чтение: по каждому дню (сотрудник, дата), где ФОТ
 * отдаёт в 1С не то, что в табеле 1С, — что поставить и отпечаток дня ФОТ на момент сверки
 * (`timesheet-zup-align.snapshot.ts`). Скрипт `scripts/zup-timesheet-align.ts` применяет план одной транзакцией.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';

/** Комментарий правки — его видно в окне дня. */
export const ZUP_REASON = 'ЗУП';

export type ZupStatusTarget = 'unpaid' | 'remote' | 'vacation' | 'sick';

export type ZupTarget =
  /** Явка N ч на объект дня — корректировка по объекту (`manual_object`). */
  | { kind: 'object'; hours: number; object: { key: string; id: string | null; name: string } }
  /** Явка N ч без объектов СКУД — дневная «Корректировка табеля» (`manual`). */
  | { kind: 'day'; hours: number }
  /** В 1С часов нет — «Обнулить день» (`manual`, 0 ч). */
  | { kind: 'zero' }
  /** Отметка 1С — дневная отметка; у удалёнки — часы 1С (без них удалёнка в выходной даёт 0 ч и не идёт в основу). */
  | { kind: 'status'; status: ZupStatusTarget; hours?: number };

export interface IZupPlanItem {
  employee_id: number;
  /** YYYY-MM-DD. */
  date: string;
  /** Номера строк файла 1С — источник дня. */
  rows: number[];
  target: ZupTarget;
  /** Отпечаток дня ФОТ на момент сверки (zupDayFingerprint). */
  expected_fingerprint: string;
  /** id строк attendance_adjustments дня на момент сверки — снимаются все. */
  remove_adjustment_ids: number[];
}

export interface IZupPlan {
  run_id: string;
  /** YYYY-MM. */
  month: string;
  created_at: string;
  source: { file: string; sha256: string; sheet: string };
  plan_sha256: string;
  items: IZupPlanItem[];
}

/** Метаданные ЗУП-строки: откуда правка (полный прежний день — только в резервной копии). */
export interface IZupAlignMetadata {
  run_id: string;
  actor: string;
  file_sha256: string;
  plan_sha256: string;
  rows: number[];
}

/** Строка таблицы как есть (row_to_json) — для отката один в один. */
export type JsonRow = Record<string, unknown>;

export interface IZupBackupDay {
  employee_id: number;
  date: string;
  /** Снятые строки дня целиком. */
  removed_rows: JsonRow[];
  /** Их собственные document_links (удалены вместе со строками). */
  removed_links: JsonRow[];
  /** Созданная ЗУП-строка, как записана. */
  zup_row: JsonRow;
  /** Ссылки, перенесённые на ЗУП-строку (с прежних строк и из заявлений), — удаляются при откате. */
  moved_links: JsonRow[];
}

export interface IZupBackup {
  kind: 'zup-timesheet-align-backup';
  run_id: string;
  plan_sha256: string;
  file_sha256: string;
  month: string;
  actor: { user_id: string; email: string };
  created_at: string;
  days: IZupBackupDay[];
  /** Закрытые подачи, помеченные на пересборку. */
  approval_ids: number[];
}

const STATUS_TARGETS: readonly ZupStatusTarget[] = ['unpaid', 'remote', 'vacation', 'sick'];

/** Хэш состава плана: канонический JSON пунктов (так же считает сборщик плана). */
export const computeZupPlanSha = (items: readonly IZupPlanItem[]): string => crypto
  .createHash('sha256')
  .update(canonicalJson(items))
  .digest('hex');

const fail = (message: string): never => {
  throw new Error(message);
};

const isHours = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24;

const checkTarget = (target: unknown, where: string): ZupTarget => {
  const t = target as Record<string, unknown> | null;
  if (!t || typeof t !== 'object') return fail(`${where}: нет target`);
  switch (t.kind) {
    case 'object': {
      const object = t.object as Record<string, unknown> | null;
      if (!isHours(t.hours)) fail(`${where}: часы объекта вне 0–24`);
      if (!object || typeof object.key !== 'string' || !object.key || typeof object.name !== 'string') {
        fail(`${where}: объект без ключа или названия`);
      }
      return t as unknown as ZupTarget;
    }
    case 'day':
      if (!isHours(t.hours)) fail(`${where}: часы дня вне 0–24`);
      return t as unknown as ZupTarget;
    case 'zero':
      return t as unknown as ZupTarget;
    case 'status':
      if (!STATUS_TARGETS.includes(t.status as ZupStatusTarget)) fail(`${where}: отметка ${String(t.status)} не поддержана`);
      if (t.hours !== undefined && (t.status !== 'remote' || !isHours(t.hours))) fail(`${where}: часы бывают только у удалёнки, 0–24`);
      return t as unknown as ZupTarget;
    default:
      return fail(`${where}: неизвестный вид правки ${String(t.kind)}`);
  }
};

/** Разбор и проверка плана: формат, один месяц, без повторов дней, хэш состава. */
export const parseZupPlan = (raw: unknown): IZupPlan => {
  const plan = raw as IZupPlan;
  if (!plan || typeof plan !== 'object') fail('План: не объект');
  if (!/^[0-9a-f-]{36}$/.test(String(plan.run_id))) fail('План: нет run_id');
  if (!/^\d{4}-\d{2}$/.test(String(plan.month))) fail('План: месяц не YYYY-MM');
  if (!/^[0-9a-f]{64}$/.test(String(plan.source?.sha256))) fail('План: нет SHA-256 файла 1С');
  if (!Array.isArray(plan.items) || plan.items.length === 0) fail('План: пуст');
  const seen = new Set<string>();
  for (const item of plan.items) {
    const where = `План, ${item?.employee_id}|${item?.date}`;
    if (!Number.isSafeInteger(item.employee_id) || item.employee_id <= 0) fail(`${where}: нет сотрудника`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date)) || !item.date.startsWith(`${plan.month}-`)) fail(`${where}: дата вне месяца`);
    const key = `${item.employee_id}|${item.date}`;
    if (seen.has(key)) fail(`${where}: день повторяется`);
    seen.add(key);
    if (!/^[0-9a-f]{64}$/.test(String(item.expected_fingerprint))) fail(`${where}: нет отпечатка дня`);
    if (!Array.isArray(item.remove_adjustment_ids)) fail(`${where}: нет списка снимаемых строк`);
    if (!Array.isArray(item.rows)) fail(`${where}: нет строк файла 1С`);
    checkTarget(item.target, where);
  }
  const sha = computeZupPlanSha(plan.items);
  if (sha !== plan.plan_sha256) fail(`План: хэш состава ${sha} ≠ ${plan.plan_sha256} — файл плана изменён`);
  return plan;
};

/** Какой должна стать ЗУП-строка дня. */
export interface IZupRowSpec {
  source_type: 'manual' | 'manual_object';
  source_id: string;
  status: string;
  hours_override: number | null;
  metadata_object: { object_id: string | null; object_name: string } | null;
}

export const zupRowSpec = (target: ZupTarget): IZupRowSpec => {
  switch (target.kind) {
    case 'object':
      return {
        source_type: 'manual_object',
        source_id: target.object.key,
        status: 'manual',
        hours_override: target.hours,
        metadata_object: { object_id: target.object.id, object_name: target.object.name },
      };
    case 'day':
      return { source_type: 'manual', source_id: 'manual', status: 'manual', hours_override: target.hours, metadata_object: null };
    case 'zero':
      return { source_type: 'manual', source_id: 'manual', status: 'manual', hours_override: 0, metadata_object: null };
    case 'status':
      return {
        source_type: 'manual',
        source_id: 'manual',
        status: target.status,
        hours_override: target.status === 'remote' && target.hours ? target.hours : null,
        metadata_object: null,
      };
  }
};
