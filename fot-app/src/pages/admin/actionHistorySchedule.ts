/** Строка «Истории действий» для смены графика сотрудника (EMPLOYEE_SCHEDULE_CHANGED). */

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const ruDate = (iso: string | null): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
};

const scheduleLabel = (name: unknown, isDefault: unknown): string => {
  const label = `«${str(name) ?? 'график не найден'}»`;
  return isDefault === true ? `${label} (по умолчанию)` : label;
};

const findRow = (rows: unknown, id: string | null): Record<string, unknown> | null => {
  if (!id || !Array.isArray(rows)) return null;
  const found = rows.find(row => row !== null && typeof row === 'object' && (row as { id?: unknown }).id === id);
  return (found as Record<string, unknown> | undefined) ?? null;
};

const describeFix = (details: Record<string, unknown>): string => {
  const id = str(details.assignment_id);
  const before = findRow(details.before, id);
  const after = findRow(details.after, id);
  const parts: string[] = [];
  if (before && after && before.effective_from !== after.effective_from) {
    parts.push(`с ${ruDate(str(before.effective_from))} → с ${ruDate(str(after.effective_from))}`);
  }
  if (before && after && before.anchor_date !== after.anchor_date) {
    parts.push(`якорь ${ruDate(str(before.anchor_date)) || '—'} → ${ruDate(str(after.anchor_date)) || '—'}`);
  }
  const schedule = scheduleLabel(details.to_schedule_name, details.to_is_default);
  return `${schedule}: ${parts.length > 0 ? parts.join(', ') : 'даты исправлены'}`;
};

export const formatScheduleChangeDetails = (details: Record<string, unknown>): string => {
  const employeeId = details.employee_id;
  const fio = str(details.employee_full_name)
    ?? (employeeId !== null && employeeId !== undefined ? `сотрудник #${String(employeeId)}` : '');
  const operation = str(details.operation);
  const date = ruDate(str(details.date));
  const from = scheduleLabel(details.from_schedule_name, details.from_is_default);
  const to = scheduleLabel(details.to_schedule_name, details.to_is_default);

  let text: string;
  if (operation === 'fix') {
    text = describeFix(details);
  } else if (operation === 'delete') {
    text = `удалена запись ${from}, с ${date} — ${to}`;
  } else {
    text = `${from} → ${to} с ${date}`;
  }

  const brigades = Array.isArray(details.brigade_names)
    ? details.brigade_names.map(String).filter(Boolean)
    : [];
  if (brigades.length > 0) text += ` (бригада ${brigades.map(name => `«${name.trim()}»`).join(', ')})`;

  return fio ? `${fio}: ${text}` : text;
};
