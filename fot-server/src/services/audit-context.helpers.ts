import { query, queryOne } from '../config/postgres.js';

export async function loadEmployeeFullName(employeeId: number): Promise<string | null> {
  try {
    const row = await queryOne<{ full_name: string | null }>(
      'SELECT full_name FROM employees WHERE id = $1',
      [employeeId],
    );
    return row?.full_name ?? null;
  } catch {
    return null;
  }
}

export async function loadDepartmentName(departmentId: string | null | undefined): Promise<string | null> {
  if (!departmentId) return null;
  try {
    const row = await queryOne<{ name: string | null }>(
      'SELECT name FROM org_departments WHERE id = $1::uuid',
      [departmentId],
    );
    return row?.name ?? null;
  } catch {
    return null;
  }
}

export async function loadEmployeeFullNamesMap(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(ids)].filter(id => Number.isFinite(id));
  if (unique.length === 0) return map;
  try {
    const rows = await query<{ id: number; full_name: string | null }>(
      'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
      [unique],
    );
    for (const row of rows) {
      if (row.full_name) map.set(row.id, row.full_name);
    }
  } catch {
    // ignore — вернём то, что успели собрать
  }
  return map;
}

export async function loadDepartmentNamesMap(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  try {
    const rows = await query<{ id: string; name: string | null }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [unique],
    );
    for (const row of rows) {
      if (row.name) map.set(row.id, row.name);
    }
  } catch {
    // ignore
  }
  return map;
}

export async function loadUserFullName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const row = await queryOne<{ full_name: string | null }>(
      'SELECT full_name FROM user_profiles WHERE id = $1::uuid',
      [userId],
    );
    return row?.full_name ?? null;
  } catch {
    return null;
  }
}
