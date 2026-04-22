import type { OrgDepartmentKind } from '../types/index.js';

const BRIGADE_PREFIX = 'бр.';
const OBJECT_ROOT_NAME = 'Объект';

export function detectDepartmentKindFromName(
  name: string | null | undefined,
  options: { isRoot?: boolean } = {},
): OrgDepartmentKind {
  const normalized = (name || '').trim().toLowerCase();
  if (!normalized) return 'department';

  if (normalized.startsWith(BRIGADE_PREFIX)) return 'brigade';
  if (options.isRoot && (name || '').trim() === OBJECT_ROOT_NAME) return 'object';

  return 'department';
}
