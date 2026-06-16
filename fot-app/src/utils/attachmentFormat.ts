/** 'YYYY-MM-DD' → 'DD.MM'. */
const formatDay = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : iso;
};

const dayIndex = (iso: string): number => {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 86_400_000);
};

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

/**
 * Список дат → компактные группы: смежные дни сворачиваются в диапазон, разрывы
 * выводятся отдельно. ['2026-06-01','2026-06-02','2026-06-03','2026-06-07'] →
 * '01.06–03.06, 07.06'. Несмежные даты НЕ сливаются в один диапазон.
 */
export const formatDateRanges = (dates: string[] | null | undefined): string => {
  if (!dates || dates.length === 0) return '';
  const sorted = [...new Set(dates)].sort();
  const groups: Array<[string, string]> = [];
  for (const iso of sorted) {
    const last = groups[groups.length - 1];
    if (last && dayIndex(iso) - dayIndex(last[1]) === 1) {
      last[1] = iso;
    } else {
      groups.push([iso, iso]);
    }
  }
  return groups.map(([a, b]) => (a === b ? formatDay(a) : `${formatDay(a)}–${formatDay(b)}`)).join(', ');
};
