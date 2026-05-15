/** Synced-компании имеют local UUID. Unsynced = `sigur::ID`, fallback = `__no_company__`. */
export const isSyncedCompanyId = (id: string): boolean =>
  !id.startsWith('sigur::') && id !== '__no_company__';
