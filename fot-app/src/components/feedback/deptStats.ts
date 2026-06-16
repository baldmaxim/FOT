import type { IDepartmentStat } from '../../services/feedbackService';

// ---- Метрика заполнения по отделам: цвет, проценты, статусы, сортировка ----

export type SortKey = 'lagging' | 'pctdesc' | 'alpha';
export type Bucket = 'none' | 'part' | 'done';

// Категориальные цвета статусов (для стэк-бара статусов и групп).
export const STATUS_COLORS: Record<Bucket, string> = {
  none: 'hsl(0, 72%, 50%)',
  part: 'hsl(45, 80%, 52%)',
  done: 'hsl(120, 72%, 45%)',
};

export const pctOf = (s: IDepartmentStat): number =>
  s.total > 0 ? Math.round((s.filled / s.total) * 100) : 0;

// Плавная шкала: 0% — красный, 50% — жёлтый, 100% — зелёный.
export const fillColor = (pct: number): string => {
  const h = Math.max(0, Math.min(120, (pct / 100) * 120));
  return `hsl(${h}, 72%, 50%)`;
};

export const bucketOf = (s: IDepartmentStat): Bucket => {
  const p = pctOf(s);
  if (p <= 0) return 'none';
  if (p >= 100) return 'done';
  return 'part';
};

export interface IKpi {
  deptCount: number;
  sumFilled: number;
  sumTotal: number;
  overallPct: number;
  none: number;
  part: number;
  done: number;
}

export const computeKpi = (rows: IDepartmentStat[]): IKpi => {
  let sumFilled = 0;
  let sumTotal = 0;
  let none = 0;
  let part = 0;
  let done = 0;
  for (const r of rows) {
    sumFilled += r.filled;
    sumTotal += r.total;
    const b = bucketOf(r);
    if (b === 'none') none += 1;
    else if (b === 'done') done += 1;
    else part += 1;
  }
  const overallPct = sumTotal > 0 ? Math.round((sumFilled / sumTotal) * 100) : 0;
  return { deptCount: rows.length, sumFilled, sumTotal, overallPct, none, part, done };
};

export const sortRows = (rows: IDepartmentStat[], key: SortKey): IDepartmentStat[] => {
  const arr = rows.slice();
  if (key === 'alpha') arr.sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru'));
  else if (key === 'pctdesc') arr.sort((a, b) => pctOf(b) - pctOf(a) || b.total - a.total);
  else arr.sort((a, b) => pctOf(a) - pctOf(b) || b.total - a.total); // lagging: меньший % сверху
  return arr;
};

// ---- Период (даты/пресеты) ----

export type PresetKey = 'today' | 'yesterday' | 'week' | 'month' | 'prevmonth';

const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const parseIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const fmtIso = (dt: Date): string =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

// Текущая дата в TZ Москвы (формат YYYY-MM-DD).
export const todayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

export const presetRange = (key: PresetKey, today: string): { from: string; to: string } => {
  const t = parseIso(today);
  if (key === 'today') return { from: today, to: today };
  if (key === 'yesterday') {
    const y = parseIso(today);
    y.setDate(y.getDate() - 1);
    const s = fmtIso(y);
    return { from: s, to: s };
  }
  if (key === 'week') {
    const f = parseIso(today);
    f.setDate(f.getDate() - 6);
    return { from: fmtIso(f), to: today };
  }
  if (key === 'month') {
    return { from: fmtIso(new Date(t.getFullYear(), t.getMonth(), 1)), to: today };
  }
  // prevmonth
  return {
    from: fmtIso(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
    to: fmtIso(new Date(t.getFullYear(), t.getMonth(), 0)),
  };
};

export const isSingleDay = (from: string, to: string): boolean => !!from && from === to;

// Короткая подпись периода: «15 июн · 1 день» / «1–15 июн».
export const periodLabel = (from: string, to: string): string => {
  if (!from || !to) return 'весь период';
  const f = parseIso(from);
  const t = parseIso(to);
  if (from === to) return `${f.getDate()} ${MONTHS_GEN[f.getMonth()]} · 1 день`;
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return `${f.getDate()}–${t.getDate()} ${MONTHS_GEN[t.getMonth()]}`;
  }
  return `${f.getDate()} ${MONTHS_GEN[f.getMonth()]} – ${t.getDate()} ${MONTHS_GEN[t.getMonth()]}`;
};
