import { useState, useCallback, useEffect } from 'react';
import { employeeService } from '../services/employeeService';
import { structureApi } from '../api/structure';
import type { Employee } from '../types';
import type { OrgDepartmentNode } from '../types/organization';

/* ─── module-level cache ─── */
let cachedEmployees: Employee[] | null = null;
let cachedDepartments: OrgDepartmentNode[] | null = null;
let cacheTs = 0;
const CACHE_TTL = 60_000; // 60 сек

export const useStaffData = () => {
  const [employees, setEmployees] = useState<Employee[]>(cachedEmployees ?? []);
  const [departments, setDepartments] = useState<OrgDepartmentNode[]>(cachedDepartments ?? []);
  const [loading, setLoading] = useState(!cachedEmployees);

  const loadData = useCallback(async (force = false) => {
    if (!force && cachedEmployees && Date.now() - cacheTs < CACHE_TTL) {
      setEmployees(cachedEmployees);
      setDepartments(cachedDepartments!);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [emps, tree] = await Promise.all([
      employeeService.getAll(),
      structureApi.getTree(),
    ]);
    const active = emps.filter((e: Employee) => e.employment_status === 'active');
    const deps = tree.data?.departments ?? [];
    cachedEmployees = active;
    cachedDepartments = deps;
    cacheTs = Date.now();
    setEmployees(active);
    setDepartments(deps);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const patchEmployee = useCallback((id: number, patch: Partial<Employee>) => {
    setEmployees(prev => {
      const next = prev.map(e => e.id === id ? { ...e, ...patch } : e);
      cachedEmployees = next;
      return next;
    });
  }, []);

  const refresh = useCallback(() => loadData(true), [loadData]);

  return { employees, departments, loading, refresh, patchEmployee };
};
