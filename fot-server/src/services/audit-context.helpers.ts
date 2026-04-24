import { supabase } from '../config/database.js';

export async function loadEmployeeFullName(employeeId: number): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('employees')
      .select('full_name')
      .eq('id', employeeId)
      .maybeSingle();
    return (data?.full_name as string | null) ?? null;
  } catch {
    return null;
  }
}

export async function loadDepartmentName(departmentId: string | null | undefined): Promise<string | null> {
  if (!departmentId) return null;
  try {
    const { data } = await supabase
      .from('org_departments')
      .select('name')
      .eq('id', departmentId)
      .maybeSingle();
    return (data?.name as string | null) ?? null;
  } catch {
    return null;
  }
}

export async function loadEmployeeFullNamesMap(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(ids)].filter(id => Number.isFinite(id));
  if (unique.length === 0) return map;
  try {
    const { data } = await supabase
      .from('employees')
      .select('id, full_name')
      .in('id', unique);
    for (const row of data ?? []) {
      const name = (row as { full_name?: string | null }).full_name;
      if (name) map.set((row as { id: number }).id, name);
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
    const { data } = await supabase
      .from('org_departments')
      .select('id, name')
      .in('id', unique);
    for (const row of data ?? []) {
      const name = (row as { name?: string | null }).name;
      if (name) map.set((row as { id: string }).id, name);
    }
  } catch {
    // ignore
  }
  return map;
}

export async function loadUserFullName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle();
    return (data?.full_name as string | null) ?? null;
  } catch {
    return null;
  }
}
