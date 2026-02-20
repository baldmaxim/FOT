export const formatElapsed = (since: string | null): string => {
  if (!since) return '';

  const now = new Date();
  let sinceDate: Date;

  if (/^\d{2}:\d{2}:\d{2}$/.test(since)) {
    const today = now.toISOString().slice(0, 10);
    sinceDate = new Date(`${today}T${since}`);
  } else {
    sinceDate = new Date(since);
  }

  const diffMs = now.getTime() - sinceDate.getTime();
  if (diffMs < 0) return '0м';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
};
