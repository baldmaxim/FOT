/**
 * Парсинг ФИО на отдельные части: Фамилия, Имя, Отчество.
 * Формат: "Фамилия Имя Отчество"
 */

export interface IParsedFIO {
  lastName: string;
  firstName: string | null;
  middleName: string | null;
}

/**
 * Каноническая форма ФИО для сравнения/матчинга:
 * trim → lowercase → схлопывание пробелов.
 * При `collapseYo: true` дополнительно заменяет «ё» на «е» —
 * нужно при матчинге Sigur ↔ FOT, где написания «Алексеев/Алексёев» расходятся.
 */
export const normalizeFullName = (
  name: string,
  options: { collapseYo?: boolean } = {},
): string => {
  const base = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return options.collapseYo ? base.replace(/ё/g, 'е') : base;
};

export const parseFIO = (fullName: string): IParsedFIO => {
  const parts = fullName.trim().split(/\s+/);
  return {
    lastName: parts[0] || fullName.trim(),
    firstName: parts[1] || null,
    middleName: parts.length > 2 ? parts.slice(2).join(' ') : null,
  };
};

/**
 * Формат "Фамилия И. О." — возвращает фамилию и инициалы имени/отчества с точками.
 * Порт из fot-app/src/utils/timesheetDisplay.ts::formatTimesheetEmployeeName.
 */
export const formatNameWithInitials = (fullName: string): string => {
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

/** Имя папки-архива "Уч. Фамилия И. О." для назначенного сотрудника. */
export const formatAssignedFolderName = (fullName: string): string => {
  const formatted = formatNameWithInitials(fullName);
  return formatted ? `Уч. ${formatted}` : 'Уч. ?';
};
