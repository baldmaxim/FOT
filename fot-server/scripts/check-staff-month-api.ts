/**
 * Проверка API для ЗУП3 «сотрудники месяца» на БД (только чтение): собирает снимок месяца тем же кодом, что метод,
 * и сверяет:
 *  - инварианты в сотых часа: день = Σ объектов дня, сотрудник = Σ дней = Σ объектов, объекты = Σ сотрудников,
 *    бригада = Σ членов, норма = Σ плановых часов дней + квота;
 *  - факт закрытых дней = отработанные дни согласованных редакций (независимый SQL);
 *  - объект и категория = путь «Свода» (loadMonthBreakdown → attributeMonths → resolveSummaryObjects);
 *  - объект бригады = основной объект подач бригады (loadDepartmentMonthBreakdown, без «Не определён»);
 *  - половины месяца (1–15, 16–конец): состав, готовые / не готовые, Σ двух половин = месяц (часы и объекты у каждого
 *    сотрудника), норма половины = Σ плановых часов, объекты половины = Σ строк половины;
 *  - объект табелирования: по режимам и сколько из них по отделу (legacy) — той же функцией разрешения режима
 *    (resolveExportModes с месяцем), что API, на той же выборке сотрудников; где он не совпадает с объектом месяца;
 *  - время сборки, память (снимок с половинами), размер самого большого ответа (days=1, limit=500).
 *
 *   npx tsx scripts/check-staff-month-api.ts --month 2026-10
 */
import { performance } from 'node:perf_hooks';

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const load = async <T>(path: string): Promise<T> => {
  const module = await import(path) as Record<string, unknown> & { default?: Record<string, unknown> };
  return { ...(module.default ?? {}), ...module } as T;
};

const centi = (value: number): number => Math.round(value * 100);

async function main(): Promise<void> {
  const month = argValue('--month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Нужен --month YYYY-MM');

  const pg = await load<typeof import('../src/config/postgres.js')>('../src/config/postgres.js');
  const loader = await load<typeof import('../src/services/staff-month-1c.load.js')>('../src/services/staff-month-1c.load.js');
  const builder = await load<typeof import('../src/services/staff-month-1c.snapshot.js')>('../src/services/staff-month-1c.snapshot.js');
  const attribution = await load<typeof import('../src/services/payroll/payroll-month-attribution.service.js')>(
    '../src/services/payroll/payroll-month-attribution.service.js');
  const summaryObject = await load<typeof import('../src/services/payroll/payroll-summary-object.service.js')>(
    '../src/services/payroll/payroll-summary-object.service.js');
  const category = await load<typeof import('../src/services/payroll/payroll-staff-category.js')>(
    '../src/services/payroll/payroll-staff-category.js');
  const attr = await load<typeof import('../src/services/payroll/payroll-summary.attribution.js')>(
    '../src/services/payroll/payroll-summary.attribution.js');
  const modes = await load<typeof import('../src/services/timesheet-export-mode.service.js')>(
    '../src/services/timesheet-export-mode.service.js');

  const bounds = loader.monthBoundsOf(month);
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const steps: Record<string, number> = {};
  let last = started;
  const timing = { mark: (step: string): void => { const now = performance.now(); steps[step] = Math.round((now - last) / 100) / 10; last = now; } };
  const snapshot = await pg.withReadOnlySnapshot(client => builder.buildStaffMonthSnapshot(client, bounds, new Date(), timing));
  const buildMs = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapWithSnapshot = process.memoryUsage().heapUsed;

  const serializeStarted = performance.now();
  const biggest = JSON.stringify(snapshot.rows.slice(0, 500));
  const serializeMs = performance.now() - serializeStarted;
  const whole = JSON.stringify(snapshot.rows).length;

  const problems: string[] = [];
  const note = (text: string): void => {
    if (problems.length < 40) problems.push(text);
  };

  // 1. Инварианты.
  const objectTotals = new Map<string, number>();
  for (const row of snapshot.rows) {
    let daysSum = 0;
    for (const day of row.days) {
      const parts = day.objects.reduce((sum, item) => sum + centi(item.hours), 0);
      if (parts !== centi(day.hours)) note(`${row.employee_id} ${day.date}: объекты ${parts / 100} ≠ день ${day.hours}`);
      daysSum += centi(day.hours);
    }
    const objectsSum = row.objects.reduce((sum, item) => sum + centi(item.hours), 0);
    if (daysSum !== centi(row.hours) || objectsSum !== centi(row.hours)) {
      note(`${row.employee_id}: дни ${daysSum / 100}, объекты ${objectsSum / 100}, итог ${row.hours}`);
    }
    for (const item of row.objects) objectTotals.set(item.object.key, (objectTotals.get(item.object.key) ?? 0) + centi(item.hours));
    if (row.norm.complete && row.norm.hours !== null) {
      const plan = row.days.reduce((sum, day) => sum + centi(day.plan_hours ?? 0), 0) + centi(row.norm.weekend_quota.hours);
      if (plan !== centi(row.norm.hours)) note(`${row.employee_id}: норма ${row.norm.hours} ≠ дни+квота ${plan / 100}`);
    }
  }
  for (const item of snapshot.objects) {
    if ((objectTotals.get(item.object.key) ?? 0) !== centi(item.hours)) note(`объект ${item.object.name}: ${item.hours} ≠ Σ сотрудников`);
  }
  for (const brigade of snapshot.brigades) {
    const members = brigade.members.reduce((sum, item) => sum + centi(item.hours), 0);
    const objects = brigade.objects.reduce((sum, item) => sum + centi(item.hours), 0);
    if (members !== objects) note(`бригада ${brigade.name}: члены ${members / 100} ≠ объекты ${objects / 100}`);
  }
  const invariantProblems = problems.length;

  // 2. Факт закрытых дней — независимым SQL.
  const closedRows = await pg.query<{ employee_id: number; centi: string }>(`
    WITH latest AS (
      SELECT DISTINCT ON (v.approval_id) v.id, v.created_at, v.payload
        FROM timesheet_versions v
       WHERE date_trunc('month', v.start_date)::date = $1::date
       ORDER BY v.approval_id, v.revision DESC
    ), days AS (
      SELECT (e->'identity'->>'employee_id')::int AS employee_id, d.key AS date, d.value->>'status' AS status,
             round(COALESCE((d.value->>'hours')::numeric, 0) * 100) AS centi,
             row_number() OVER (PARTITION BY (e->'identity'->>'employee_id')::int, d.key ORDER BY l.created_at DESC, l.id DESC) AS rn
        FROM latest l
        JOIN timesheet_approvals a ON a.id = (SELECT approval_id FROM timesheet_versions WHERE id = l.id)
         AND a.status = 'approved' AND a.version_dirty_at IS NULL
       CROSS JOIN LATERAL jsonb_array_elements(l.payload->'employees') e
       CROSS JOIN LATERAL jsonb_each(e->'days') d
    )
    SELECT employee_id, SUM(centi)::text AS centi FROM days
     WHERE rn = 1 AND status IN ('work', 'manual', 'remote', 'sick_worked', 'study_day')
     GROUP BY 1`, [bounds.start]);
  const closedByEmployee = new Map(closedRows.map(row => [Number(row.employee_id), Number(row.centi)]));
  let closedMismatch = 0;
  for (const row of snapshot.rows) {
    const api = row.days.filter(day => day.source === 'closed').reduce((sum, day) => sum + centi(day.hours), 0);
    const expected = closedByEmployee.get(row.employee_id) ?? 0;
    if (api !== expected) {
      closedMismatch += 1;
      note(`${row.employee_id} ${row.full_name}: закрытый факт API ${api / 100} ≠ редакции ${expected / 100}`);
    }
  }

  // 3. Объект и категория — путь «Свода» по закрытым редакциям.
  const ids = snapshot.rows.map(row => row.employee_id);
  const svodBreakdown = await attribution.loadMonthBreakdown([bounds.start], ids);
  const employees = await pg.query<{ id: number; org_department_id: string | null; employment_status: string | null }>(
    'SELECT id, org_department_id::text AS org_department_id, employment_status FROM employees WHERE id = ANY($1::int[])', [ids]);
  const svodAttribution = await attribution.attributeMonths(
    ids.map(id => ({ employeeId: id, month })), svodBreakdown,
    new Map(employees.map(row => [Number(row.id), row])),
  );
  const svodObjects = await summaryObject.resolveSummaryObjects(svodAttribution);
  const svodCategories = await category.resolveMonthStaffCategories(ids.map(id => {
    const key = attribution.monthPairKey(id, month);
    const item = svodAttribution.get(key);
    return {
      employeeId: id, monthStart: bounds.start, mode: item?.mode, departmentId: item?.departmentId ?? null,
      officeObject: (svodObjects.get(key) ?? item?.object)?.key === 'office',
    };
  }));
  const objectDiff = { total: 0, live: 0, inSvod: 0 };
  let categoryDiff = 0;
  snapshot.rows.forEach((row, position) => {
    const key = attribution.monthPairKey(row.employee_id, month);
    const svod = svodObjects.get(key) ?? svodAttribution.get(key)?.object;
    const hasLive = row.days.some(day => day.source === 'live');
    if (svod && svod.key !== row.object.key && !row.object_config_error) {
      objectDiff.total += 1;
      if (hasLive) objectDiff.live += 1;
      else note(`${row.employee_id} ${row.full_name}: объект API ${row.object.name} (${row.object_source}) ≠ «Свод» ${svod.name}`);
      if ((svodBreakdown.get(key) ?? []).length > 0) objectDiff.inSvod += 1;
    }
    if (svodCategories[position] !== row.category && !hasLive) {
      categoryDiff += 1;
      note(`${row.employee_id} ${row.full_name}: категория API ${row.category} ≠ «Свод» ${svodCategories[position]}`);
    }
  });

  // 4. Объект бригады — основной объект подач бригады (с неявками, как «Свод»; справочно).
  const brigadeBreakdown = await attribution.loadDepartmentMonthBreakdown([bounds.start], snapshot.brigades.map(item => item.department_id));
  let brigadeDiff = 0;
  for (const brigade of snapshot.brigades) {
    const expected = attr.pickMainKnownObject(brigadeBreakdown.get(`${brigade.department_id}|${month}`) ?? []);
    if ((expected?.key ?? null) !== (brigade.object?.key ?? null)) {
      brigadeDiff += 1;
      note(`бригада ${brigade.name}: API ${brigade.object?.name ?? '—'} ≠ подачи ${expected?.name ?? '—'}`);
    }
  }
  const sample = snapshot.brigades.find(item => item.name.startsWith('бр.Амонов М.Н'));

  // 5. Половины месяца.
  const halvesReport: Record<string, unknown> = {};
  let halfProblems = 0;
  const halfNote = (text: string): void => { halfProblems += 1; note(text); };
  for (const half of [1, 2] as const) {
    const view = snapshot.halves[half];
    const totals = new Map<string, number>();
    for (const row of view.rows) {
      const days = row.days.reduce((sum, day) => sum + centi(day.hours), 0);
      const objects = row.objects.reduce((sum, item) => sum + centi(item.hours), 0);
      if (days !== centi(row.hours) || objects !== centi(row.hours)) halfNote(`${half}: ${row.employee_id} дни ${days / 100}, объекты ${objects / 100}, итог ${row.hours}`);
      if (row.norm.complete && row.norm.hours !== null) {
        const plan = row.days.reduce((sum, day) => sum + centi(day.plan_hours ?? 0), 0);
        if (plan !== centi(row.norm.hours)) halfNote(`${half}: ${row.employee_id} норма ${row.norm.hours} ≠ Σ плановых ${plan / 100}`);
      }
      for (const item of row.objects) totals.set(item.object.key, (totals.get(item.object.key) ?? 0) + centi(item.hours));
    }
    for (const item of view.objects) {
      if ((totals.get(item.object.key) ?? 0) !== centi(item.hours)) halfNote(`${half}: объект ${item.object.name} ${item.hours} ≠ Σ строк`);
    }
    halvesReport[String(half)] = {
      bounds: view.bounds,
      employees: view.rows.length,
      ready: view.rows.filter(row => !row.preliminary).length,
      not_ready: view.rows.filter(row => row.preliminary).length,
      by_object_source: view.rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.object_source]: (acc[row.object_source] ?? 0) + 1 }), {}),
      brigades: view.brigades.length,
      objects: view.objects.length,
      hours_total: Math.round(view.rows.reduce((sum, row) => sum + row.hours, 0) * 100) / 100,
    };
  }
  const halfOf = (half: 1 | 2) => new Map(snapshot.halves[half].rows.map(row => [row.employee_id, row]));
  const [firstHalf, secondHalf] = [halfOf(1), halfOf(2)];
  for (const row of snapshot.rows) {
    const parts = [firstHalf.get(row.employee_id), secondHalf.get(row.employee_id)].filter(Boolean);
    if (parts.length === 0) halfNote(`${row.employee_id}: нет ни в одной половине`);
    const hours = parts.reduce((sum, part) => sum + centi(part!.hours), 0);
    if (hours !== centi(row.hours)) halfNote(`${row.employee_id}: половины ${hours / 100} ≠ месяц ${row.hours}`);
    const byKey = new Map<string, number>();
    for (const part of parts) for (const item of part!.objects) byKey.set(item.object.key, (byKey.get(item.object.key) ?? 0) + centi(item.hours));
    for (const item of row.objects) {
      if ((byKey.get(item.object.key) ?? 0) !== centi(item.hours)) halfNote(`${row.employee_id}: ${item.object.name} половины ≠ месяц`);
    }
  }

  // 6. Объект табелирования — та же функция разрешения режима месяца, что в API, на той же выборке.
  const resolved = await modes.resolveExportModes(ids, undefined, { month });
  const byMode = snapshot.rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.timesheet_object.mode]: (acc[row.timesheet_object.mode] ?? 0) + 1 }), {});
  const legacy = snapshot.rows.filter(row => resolved.get(row.employee_id)?.source !== 'employee_explicit');
  const legacyByMode = legacy.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.timesheet_object.mode]: (acc[row.timesheet_object.mode] ?? 0) + 1 }), {});
  const pinnedDiff = snapshot.rows.filter(row => row.timesheet_object.object && row.timesheet_object.object.key !== row.object.key);

  const liveRows = snapshot.rows.filter(row => row.days.some(day => day.source === 'live'));
  // Живые дни, отданные как окончательные (прошлый месяц вне подач): кто это — для разбора.
  const liveFinal = liveRows.filter(row => !row.preliminary).map(row => ({
    id: row.employee_id,
    closed_days: row.days.filter(day => day.source === 'closed').length,
    live_days: row.days.filter(day => day.source === 'live').length,
    live_hours: Math.round(row.days.filter(day => day.source === 'live').reduce((sum, day) => sum + day.hours, 0) * 100) / 100,
  }));
  const byCategory = snapshot.rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.category]: (acc[row.category] ?? 0) + 1 }), {});
  const bySource = snapshot.rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.object_source]: (acc[row.object_source] ?? 0) + 1 }), {});
  console.log(JSON.stringify({
    month,
    build_seconds: Math.round(buildMs / 100) / 10,
    build_steps_seconds: steps,
    heap_mb_with_snapshot_after_gc: gc ? Math.round(heapWithSnapshot / 2 ** 20) : null,
    rss_mb: { before: Math.round(rssBefore / 2 ** 20), after: Math.round(rssAfter / 2 ** 20) },
    response_days_500: { kb: Math.round(biggest.length / 1024), serialize_ms: Math.round(serializeMs) },
    snapshot_rows_json_mb: Math.round(whole / 2 ** 20 * 10) / 10,
    employees: snapshot.rows.length,
    preliminary: snapshot.preliminary,
    with_live_days: liveRows.length,
    preliminary_employees: snapshot.rows.filter(row => row.preliminary).length,
    by_category: byCategory,
    by_object_source: bySource,
    meta: snapshot.meta,
    brigades: snapshot.brigades.length,
    objects: snapshot.objects.length,
    hours_total: Math.round(snapshot.rows.reduce((sum, row) => sum + row.hours, 0) * 100) / 100,
    invariant_problems: invariantProblems,
    closed_fact_mismatch: closedMismatch,
    object_vs_svod: objectDiff,
    category_vs_svod_without_live: categoryDiff,
    brigade_object_vs_submissions: brigadeDiff,
    sample_brigade: sample ? { name: sample.name, object: sample.object?.name, objects: sample.objects.map(item => `${item.object.name} ${item.hours}`) } : null,
    halves: halvesReport,
    half_problems: halfProblems,
    halves_rows_json_mb: Math.round((JSON.stringify(snapshot.halves[1].rows).length + JSON.stringify(snapshot.halves[2].rows).length) / 2 ** 20 * 10) / 10,
    timesheet_object: {
      by_mode: byMode,
      legacy: legacy.length,
      legacy_by_mode: legacyByMode,
      differs_from_month_object: pinnedDiff.length,
      differs_sample: pinnedDiff.slice(0, 10).map(row => `${row.employee_id} ${row.full_name}: табелирования ${row.timesheet_object.object?.name}, месяца ${row.object.name} (${row.object_source})`),
    },
    live_final: liveFinal,
    problems,
  }, null, 2));
  await pg.closeDb();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
