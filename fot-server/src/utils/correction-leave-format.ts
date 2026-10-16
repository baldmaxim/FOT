// Тексты уведомлений об отпусках, поставленных корректировкой табеля (миграция 311).

export const CORRECTION_LEAVE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};

export const correctionLeaveLabel = (status: string): string => CORRECTION_LEAVE_LABELS[status] ?? status;

/** «Тихонович Юрий Викторович» → «Тихонович Ю.В.». */
export const shortFio = (fullName: string | null | undefined): string => {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const [last, ...rest] = parts;
  const initials = rest.map(part => `${part[0]!.toUpperCase()}.`).join('');
  return initials ? `${last} ${initials}` : last!;
};

const ddmm = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

const nextIsoDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Даты дней одной строкой: подряд идущие сливаются в диапазон.
 * ['2026-10-15', …, '2026-10-28'] → «15.10–28.10.2026»; разрывы — через запятую.
 */
export const formatLeaveDays = (days: readonly string[]): string => {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return '';
  const runs: Array<[string, string]> = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextIsoDay(last[1]) === day) last[1] = day;
    else runs.push([day, day]);
  }
  const year = sorted[sorted.length - 1]!.slice(0, 4);
  return `${runs.map(([from, to]) => (from === to ? ddmm(from) : `${ddmm(from)}–${ddmm(to)}`)).join(', ')}.${year}`;
};
