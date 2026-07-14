import type { IMtsUsageRow } from '../../services/mtsBusinessSubscribersService';
import { fmtDur, fmtMoney } from './mtsBusinessFormat';

// Чистая логика сводки детальной выписки (группировка Звонки/Интернет/СМС/Прочее,
// значения плиток, тултипы). Общая для админки («Абоненты» → «Использование»)
// и ЛК сотрудника («Моя SIM») — без JSX и зависимостей от страниц.

export type UsageGroupKey = 'calls' | 'internet' | 'sms' | 'other';

export interface IUsageLabelStat { label: string; count: number; seconds: number; bytes: number; amount: number }
export interface IUsageGroup {
  key: UsageGroupKey;
  count: number;
  seconds: number;
  bytes: number;
  amount: number;
  byLabel: Map<string, IUsageLabelStat>;
  byDir: { in: { count: number; seconds: number }; out: { count: number; seconds: number } };
}

const USAGE_GROUP_OF: Record<string, UsageGroupKey> = {
  calls: 'calls', internet: 'internet', sms: 'sms',
  periodic: 'other', oneTime: 'other', topups: 'other', other: 'other',
};
export const USAGE_GROUP_LABELS: Record<UsageGroupKey, string> = {
  calls: 'Звонки', internet: 'Интернет', sms: 'СМС', other: 'Прочее',
};
export const USAGE_TYPE_WORD: Record<UsageGroupKey, string> = {
  calls: 'связь', internet: 'интернет', sms: 'смс', other: 'прочее',
};
export const USAGE_GROUP_ORDER: UsageGroupKey[] = ['calls', 'internet', 'sms', 'other'];
export const groupOf = (cat: string): UsageGroupKey => USAGE_GROUP_OF[cat] ?? 'other';

/** Число дней в месяце по строке YYYY-MM. */
export const daysInMonth = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

/** Объём события выписки: секунды → длительность, байты → МБ, штуки → как есть. */
export const fmtUnits = (units: number | null, code: string | null): string => {
  if (units == null) return '';
  if (code === 'SECOND') return fmtDur(units);
  if (code === 'BYTE') return `${(units / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  return String(units);
};

/** Раскладывает строки выписки по группам с разбивкой для тултипов плиток. */
export const summarizeUsage = (rows: IMtsUsageRow[]): Map<UsageGroupKey, IUsageGroup> => {
  const groups = new Map<UsageGroupKey, IUsageGroup>();
  const ensure = (k: UsageGroupKey): IUsageGroup => {
    let g = groups.get(k);
    if (!g) {
      g = {
        key: k, count: 0, seconds: 0, bytes: 0, amount: 0, byLabel: new Map(),
        byDir: { in: { count: 0, seconds: 0 }, out: { count: 0, seconds: 0 } },
      };
      groups.set(k, g);
    }
    return g;
  };
  for (const r of rows) {
    const g = ensure(groupOf(r.category));
    const units = r.units ?? 0;
    const sec = r.unitCode === 'SECOND' ? units : 0;
    const byt = r.unitCode === 'BYTE' ? units : 0;
    g.count += 1; g.seconds += sec; g.bytes += byt; g.amount += r.amount;
    if (r.direction === 'in') { g.byDir.in.count += 1; g.byDir.in.seconds += sec; }
    else if (r.direction === 'out') { g.byDir.out.count += 1; g.byDir.out.seconds += sec; }
    const lk = r.label ?? r.networkEvent ?? '—';
    let ls = g.byLabel.get(lk);
    if (!ls) { ls = { label: lk, count: 0, seconds: 0, bytes: 0, amount: 0 }; g.byLabel.set(lk, ls); }
    ls.count += 1; ls.seconds += sec; ls.bytes += byt; ls.amount += r.amount;
  }
  return groups;
};

/** Главное значение плитки: звонки → длительность, интернет → объём, СМС → штуки, прочее → ₽. */
export const usageGroupValue = (g: IUsageGroup): string => {
  if (g.key === 'calls') return fmtDur(g.seconds);
  if (g.key === 'internet') return fmtUnits(g.bytes, 'BYTE');
  if (g.key === 'sms') return `${g.count} шт`;
  return fmtMoney(g.amount);
};

/** Подстрока плитки: число событий + сумма (если есть). */
export const usageGroupSub = (g: IUsageGroup): string =>
  `${g.count} соб.${g.amount > 0 ? ` · ${fmtMoney(g.amount)}` : ''}`;

/** Многострочный текст тултипа с разбивкой группы. */
export const usageTooltip = (g: IUsageGroup): string => {
  if (g.key === 'calls') {
    const lines: string[] = [];
    if (g.byDir.in.count) lines.push(`Входящие: ${g.byDir.in.count} · ${fmtDur(g.byDir.in.seconds)}`);
    if (g.byDir.out.count) lines.push(`Исходящие: ${g.byDir.out.count} · ${fmtDur(g.byDir.out.seconds)}`);
    return lines.join('\n') || 'Нет данных';
  }
  const items = [...g.byLabel.values()];
  const weight = (x: IUsageLabelStat): number => (g.key === 'internet' ? x.bytes : (x.amount || x.count));
  items.sort((a, b) => weight(b) - weight(a));
  const top = items.slice(0, 8);
  const rest = items.length - top.length;
  const line = (x: IUsageLabelStat): string => {
    const vol = g.key === 'internet' ? fmtUnits(x.bytes, 'BYTE') : `${x.count} шт`;
    return `${x.label} — ${vol}${x.amount > 0 ? ` · ${fmtMoney(x.amount)}` : ''}`;
  };
  const lines = top.map(line);
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  return lines.join('\n') || 'Нет данных';
};
