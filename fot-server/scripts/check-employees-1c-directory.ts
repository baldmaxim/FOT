/**
 * Проверка справочника сотрудников для 1С (GET /api/public/v1/employees) на БД, только чтение: обходит все страницы
 * тем же кодом, что метод, и сверяет:
 *  - страницы без пропусков и повторов (ID_FOT по возрастанию);
 *  - покрытие: с кодом физлица 1С, датой рождения, табельным, организацией — у работающих и уволенных;
 *  - состав ⊇ «сотрудники месяца» (staff-month) за месяцы --months: каждый ID_FOT месяца есть в справочнике;
 *  - --ids 587,1544 — эти ID_FOT есть в справочнике (выводятся статус, наличие кода физлица и даты рождения).
 *
 *   npx tsx scripts/check-employees-1c-directory.ts --months 2026-10,2026-11 --ids 587,1544
 */

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const load = async <T>(path: string): Promise<T> => {
  const module = await import(path) as Record<string, unknown> & { default?: Record<string, unknown> };
  return { ...(module.default ?? {}), ...module } as T;
};

async function main(): Promise<void> {
  const months = (argValue('--months') ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const ids = (argValue('--ids') ?? '').split(',').map(item => Number(item.trim())).filter(Number.isInteger);
  const pg = await load<typeof import('../src/config/postgres.js')>('../src/config/postgres.js');
  const directory = await load<typeof import('../src/services/employees-1c-directory.service.js')>(
    '../src/services/employees-1c-directory.service.js');

  const rows: Awaited<ReturnType<typeof directory.listDirectoryEmployees>>['rows'] = [];
  let afterId: number | null = null;
  let pages = 0;
  for (;;) {
    const page = await directory.listDirectoryEmployees({ idAll: null, employeeId: null, status: null, afterId, limit: 1000 });
    rows.push(...page.rows);
    pages += 1;
    if (page.nextAfterId === null) break;
    afterId = page.nextAfterId;
  }
  const problems: string[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].employee_id <= rows[index - 1].employee_id) problems.push(`порядок: ${rows[index - 1].employee_id} → ${rows[index].employee_id}`);
  }

  const coverage = (status: 'active' | 'fired') => {
    const part = rows.filter(row => row.status === status);
    return {
      total: part.length,
      with_id_all: part.filter(row => row.id_all !== null).length,
      with_birth_date: part.filter(row => row.birth_date !== null).length,
      with_tab_number: part.filter(row => row.tab_number !== null).length,
      without_organization: part.filter(row => row.organization === null).length,
    };
  };
  const byOrganization = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.organization?.name ?? 'нет';
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
  const withoutOrganization = rows.filter(row => row.organization === null).reduce<Record<string, number>>((acc, row) => {
    const key = `${row.status}: ${row.department?.name ?? 'без отдела'}`;
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});

  const inDirectory = new Set(rows.map(row => row.employee_id));
  const monthReport: Record<string, unknown> = {};
  for (const month of months) {
    const present = await pg.query<{ employee_id: number }>(
      `SELECT DISTINCT s.employee_id FROM staff_month_1c_half_states s
         JOIN staff_month_1c_half_revisions r
           ON r.employee_id = s.employee_id AND r.month = s.month AND r.half = s.half AND r.state_revision = s.current_revision
        WHERE s.month = $1::date AND r.present`, [`${month}-01`]);
    const missing = present.map(row => Number(row.employee_id)).filter(id => !inDirectory.has(id));
    monthReport[month] = { staff_month: present.length, missing_in_directory: missing.length, missing_sample: missing.slice(0, 20) };
  }

  const byId = new Map(rows.map(row => [row.employee_id, row]));
  const idsReport = ids.map(id => {
    const row = byId.get(id);
    return row
      ? { id, status: row.status, dismissal_date: row.dismissal_date, id_all: row.id_all !== null, birth_date: row.birth_date !== null, organization: row.organization?.name ?? null }
      : { id, missing: true };
  });

  console.log(JSON.stringify({
    pages,
    total: rows.length,
    active: coverage('active'),
    fired: coverage('fired'),
    by_organization: byOrganization,
    without_organization_by_department: withoutOrganization,
    staff_month: monthReport,
    ids: idsReport,
    problems,
  }, null, 2));
  await pg.closeDb();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
