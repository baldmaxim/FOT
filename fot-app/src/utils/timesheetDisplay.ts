export const formatTimesheetEmployeeName = (fullName: string): string => {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];

  const [lastName, ...rest] = parts;
  const initials = rest
    .map(part => (part[0] ? `${part[0]}.` : ''))
    .filter(Boolean)
    .join(' ');

  return initials ? `${lastName} ${initials}` : lastName;
};

/**
 * Ключ СТРОКИ сетки табеля. В обычных режимах строка = сотрудник, поэтому ключ — его id.
 * В режиме «По сотруднику» один человек занимает несколько строк (по одной на отдел
 * за период), и они обязаны различаться. Для записи корректировок, графиков и замков
 * по-прежнему используется настоящий employee.id, а не этот ключ.
 */
export const getTimesheetRowKey = (employee: { id: number; row_key?: string }): string => (
  employee.row_key ?? String(employee.id)
);
