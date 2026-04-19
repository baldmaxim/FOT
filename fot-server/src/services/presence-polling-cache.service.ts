export interface EmployeeCache {
  byName: Map<string, { id: number }>;
  bySigurId: Map<number, { id: number }>;
  byUniqueName: Map<string, { id: number }>;
  fetchedAt: number;
}

let cache: EmployeeCache | null = null;

export function getEmployeeCache(): EmployeeCache | null {
  return cache;
}

export function setEmployeeCache(next: EmployeeCache): void {
  cache = next;
}

export function invalidatePresencePollingEmployeeCache(): void {
  if (cache === null) return;
  cache = null;
  console.log('[presence-polling] employee cache invalidated');
}
