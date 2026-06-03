/**
 * Где сейчас находятся «секретарские» сотрудники в Sigur (READ-ONLY).
 *
 * Берёт 10 сотрудников (FOT id), которых миграции 166/167 вернули в
 * Секретариат/Секретариат-Объекты, и показывает их ФАКТИЧЕСКИЙ отдел в Sigur
 * (по sigur_employee_id → departmentId из /api/v1/employees).
 *
 * Запуск:
 *   cd /opt/fot-build/fot-server && npx tsx scripts/diagnose-secretariat-employees-in-sigur.ts
 *
 * Ничего не пишет.
 */
import { sigurService } from '../src/services/sigur.service.js';
import { query } from '../src/config/postgres.js';
import { normalizeDepartment, normalizeEmployee } from '../src/services/sigur-sync-shared.js';

const TARGET_FOT_IDS = [567, 8781, 1462, 110, 984, 1093, 1392, 1665, 2346, 2393];

async function main() {
  console.log('=== Где «секретарские» сотрудники в Sigur (read-only) ===\n');

  // FOT: сопоставление
  const fotEmps = await query<{ id: number; full_name: string | null; sigur_employee_id: number | null; org_department_id: string | null }>(
    `SELECT e.id, e.full_name, e.sigur_employee_id, e.org_department_id
       FROM employees e WHERE e.id = ANY($1::int[])`,
    [TARGET_FOT_IDS],
  );
  const fotDeptName = new Map<string, string>();
  for (const r of await query<{ id: string; name: string | null }>('SELECT id, name FROM org_departments')) {
    fotDeptName.set(r.id, r.name || '—');
  }

  // Sigur: отделы (id → имя, набор существующих)
  const depts = ((await sigurService.getDepartments()) as Record<string, unknown>[]).map(normalizeDepartment);
  const sigurDeptName = new Map<number, string>();
  const feedIds = new Set<number>();
  for (const d of depts) { if (d.id) { feedIds.add(d.id); sigurDeptName.set(d.id, d.name || '—'); } }

  // Sigur: сотрудники (sigur_employee_id → departmentId)
  const emps = ((await sigurService.getEmployees()) as Record<string, unknown>[]).map(normalizeEmployee);
  const sigurEmpDept = new Map<number, number | undefined>();
  for (const e of emps) { if (typeof e.id === 'number') sigurEmpDept.set(e.id, e.departmentId); }

  console.log('FOT id | ФИО | отдел в FOT | sigurEmpId | departmentId в Sigur | отдел в Sigur | есть в фиде');
  console.log('─'.repeat(120));
  for (const fe of fotEmps) {
    const sId = fe.sigur_employee_id;
    const sigurDeptId = sId != null ? sigurEmpDept.get(sId) : undefined;
    const inSigur = sId != null && sigurEmpDept.has(sId);
    const sigurDept = sigurDeptId != null ? `${sigurDeptId} ${sigurDeptName.get(sigurDeptId) ?? '(нет в фиде)'}` : (inSigur ? '— (без отдела)' : 'сотрудник не найден в Sigur');
    console.log(
      `${fe.id} | ${fe.full_name} | ${fe.org_department_id ? fotDeptName.get(fe.org_department_id) : '—'} | ${sId ?? '—'} | ${sigurDeptId ?? '—'} | ${sigurDept} | ${sigurDeptId != null ? feedIds.has(sigurDeptId) : '—'}`,
    );
  }

  console.log('\n=== готово ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.message ?? err);
  process.exit(1);
});
