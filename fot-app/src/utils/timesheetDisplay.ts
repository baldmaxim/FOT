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
