export const formatFioShort = (fullName: string | null | undefined): string | null => {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const [last, first, middle] = parts;
  const fi = first ? ` ${first[0].toUpperCase()}.` : '';
  const mi = middle ? ` ${middle[0].toUpperCase()}.` : '';
  return `${last}${fi}${mi}`;
};
