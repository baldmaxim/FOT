/**
 * Слияние отдела-дубля Sigur в целевой отдел (по умолчанию 142642 → 142649,
 * «Фабрика Витражей» → «Фабрика витражей»).
 *
 * Что делает:
 *   1) preflight по БД и снимку Sigur (только чтение);
 *   2) в Sigur переводит карточки сотрудников источника в целевой отдел
 *      (уже переведённые пропускает) и проверяет, что источник опустел;
 *   3) в ОДНОЙ транзакции FOT: employees.org_department_id, ОТКРЫТЫЕ
 *      employee_assignments (без создания новых строк истории) и
 *      employee_department_access;
 *   4) снимок «до» пишется на диск ДО commit — упала запись файла, откатилась
 *      транзакция;
 *   5) сверяет инвентарь данных сотрудников и слепок закрытых подач до/после.
 *
 * Не трогает: timesheet_approvals, timesheet_versions, timesheet_approval_employees,
 * события утверждения, закрытые назначения, флаги org_departments (дубль гасится
 * удалением отдела в Sigur из раздела SIGUR — там же сбрасываются кэши сервера).
 *
 * Запуск (БД — прод):
 *   cd fot-server && npx tsx scripts/merge-duplicate-department.ts
 *   npx tsx scripts/merge-duplicate-department.ts --apply --snapshot=<путь>
 *   npx tsx scripts/merge-duplicate-department.ts --source-sigur=142642 --target-sigur=142649
 *
 * Откат:
 *   npx tsx scripts/merge-duplicate-department.ts --rollback <файл>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// На проде DATABASE_URL/CA приходят из окружения — не подменяем. Локально читаем fot-server/.env.
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(__dirname, '../.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const parsed: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (!parsed.DATABASE_URL) {
    console.error(`DATABASE_URL не найден ни в окружении, ни в ${envPath}`);
    process.exit(1);
  }
  try {
    const u = new URL(parsed.DATABASE_URL);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch {
    process.env.DATABASE_URL = parsed.DATABASE_URL;
  }
  process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'true';
  process.env.DATABASE_SSL_CA_PATH = process.env.DATABASE_SSL_CA_PATH
    ?? path.resolve(__dirname, '../../.migration/yandex-ca.pem');
}

const DEFAULT_SOURCE_SIGUR = 142642;
const DEFAULT_TARGET_SIGUR = 142649;

interface IDepartmentRow {
  id: string;
  name: string | null;
  sigur_department_id: number;
  is_active: boolean;
  is_assignable: boolean;
}

interface IApprovalSlice {
  approval_id: number;
  department_id: string;
  status: string;
  version_dirty_at: string | null;
  revision: number | null;
  content_hash: string | null;
  employees_in_version: number;
}

interface ISnapshot {
  created_at: string;
  source: { sigur_department_id: number; department_id: string; name: string | null };
  target: { sigur_department_id: number; department_id: string; name: string | null };
  employees: Array<{
    employeeId: number;
    fullName: string;
    sigurEmployeeId: number | null;
    orgDepartmentId: string | null;
    openAssignmentIds: string[];
  }>;
  access: Array<{ id: string; employeeId: number; departmentId: string; isActive: boolean }>;
  inventory: Record<string, number>;
  approvals: IApprovalSlice[];
}

const argValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const inline = process.argv.find(a => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
};

async function main(): Promise<void> {
  const { query, queryOne, withTransaction, getPool } = await import('../src/config/postgres.js');
  const {
    MERGE_INVENTORY_TABLES,
    loadMergeCandidates,
    mergeDepartmentEmployeesTx,
    moveEmployeesInSigur,
    planEmployeeMerge,
    rollbackDepartmentMergeTx,
  } = await import('../src/services/department-merge.service.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { normalizeDepartment, normalizeEmployee } = await import('../src/services/sigur-sync-shared.js');

  const apply = process.argv.includes('--apply');
  const rollbackFile = argValue('rollback');

  /** Инвентарь данных сотрудников: отдел в этих таблицах не хранится, числа обязаны совпасть до/после. */
  const loadInventory = async (employeeIds: number[]): Promise<Record<string, number>> => {
    const parts = MERGE_INVENTORY_TABLES.map(
      table => `SELECT '${table}' AS t, count(*)::text AS c FROM ${table} WHERE employee_id = ANY($1::bigint[])`,
    );
    const rows = await query<{ t: string; c: string }>(parts.join(' UNION ALL '), [employeeIds]);
    return Object.fromEntries(rows.map(row => [row.t, Number(row.c)]));
  };

  /** Слепок закрытых подач обоих отделов: доказательство, что их не переписали. */
  const loadApprovals = async (departmentIds: string[]): Promise<IApprovalSlice[]> => {
    const rows = await query<IApprovalSlice>(
      `SELECT a.id AS approval_id, a.department_id::text, a.status, a.version_dirty_at,
              v.revision, v.content_hash,
              (SELECT count(*) FROM timesheet_approval_employees t WHERE t.approval_id = a.id)::int
                AS employees_in_version
         FROM timesheet_approvals a
         LEFT JOIN timesheet_versions v ON v.approval_id = a.id
        WHERE a.department_id = ANY($1::uuid[])
        ORDER BY a.id, v.revision`,
      [departmentIds],
    );
    return rows;
  };

  if (rollbackFile) {
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(rollbackFile), 'utf8')) as ISnapshot;
    console.log(`Откат по снимку от ${snapshot.created_at}: ${snapshot.employees.length} сотрудников`);
    const result = await withTransaction(client => rollbackDepartmentMergeTx(client, {
      targetDepartmentId: snapshot.target.department_id,
      employees: snapshot.employees,
      access: snapshot.access,
    }));
    console.log(
      `Возвращено: сотрудников ${result.employeesRestored}, назначений ${result.assignmentsRestored},`
      + ` доступов ${result.accessRestored}`,
    );
    for (const skip of result.skipped) console.warn(`  ⏭ ${skip}`);
    await getPool().end();
    return;
  }

  const sourceSigurId = Number(argValue('source-sigur') ?? DEFAULT_SOURCE_SIGUR);
  const targetSigurId = Number(argValue('target-sigur') ?? DEFAULT_TARGET_SIGUR);
  if (!Number.isFinite(sourceSigurId) || !Number.isFinite(targetSigurId) || sourceSigurId === targetSigurId) {
    console.error('Некорректные --source-sigur/--target-sigur');
    process.exit(1);
  }

  // ── Preflight ──────────────────────────────────────────────────────────────
  const departments = await query<IDepartmentRow>(
    `SELECT id::text, name, sigur_department_id, is_active, is_assignable
       FROM org_departments WHERE sigur_department_id = ANY($1::int[])`,
    [[sourceSigurId, targetSigurId]],
  );
  const source = departments.find(d => d.sigur_department_id === sourceSigurId);
  const target = departments.find(d => d.sigur_department_id === targetSigurId);

  const problems: string[] = [];
  if (!source) problems.push(`отдел-источник ${sourceSigurId} не найден в org_departments`);
  if (!target) problems.push(`целевой отдел ${targetSigurId} не найден в org_departments`);
  if (target && !target.is_active) problems.push(`целевой отдел «${target.name}» неактивен`);
  if (target && !target.is_assignable) problems.push(`целевой отдел «${target.name}» неназначаем`);

  if (source && target) {
    const cycle = await queryOne<{ hit: number }>(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id FROM org_departments WHERE id = $1::uuid
         UNION ALL
         SELECT d.id, d.parent_id FROM org_departments d JOIN up ON d.id = up.parent_id
       ) SELECT 1 AS hit FROM up WHERE id = $2::uuid`,
      [target.id, source.id],
    );
    if (cycle) problems.push('целевой отдел находится внутри поддерева источника');
  }

  if (!(await sigurService.isConfigured())) problems.push('Sigur не настроен');
  let sigurDepartmentIds = new Set<number>();
  if (problems.length === 0) {
    const raw = await sigurService.getDepartments() as Record<string, unknown>[];
    sigurDepartmentIds = new Set(raw.map(item => normalizeDepartment(item).id));
    if (!sigurDepartmentIds.has(targetSigurId)) problems.push(`целевого отдела ${targetSigurId} нет в снимке Sigur`);
    if (!sigurDepartmentIds.has(sourceSigurId)) {
      console.warn(`[preflight] отдел ${sourceSigurId} уже отсутствует в снимке Sigur — перенос только в FOT`);
    }
  }

  if (problems.length > 0) {
    console.error('Preflight не пройден:');
    for (const item of problems) console.error(`  ✗ ${item}`);
    await getPool().end();
    process.exit(1);
  }

  const candidateRows = await withTransaction(client => loadMergeCandidates(client, source!.id));
  const plan = planEmployeeMerge(candidateRows);

  console.log(`Источник: «${source!.name}» (sigur ${sourceSigurId}, ${source!.id})`);
  console.log(`Цель:     «${target!.name}» (sigur ${targetSigurId}, ${target!.id})`);
  console.log(`К переносу: ${plan.candidates.length}`);
  for (const candidate of plan.candidates) {
    console.log(`  • ${candidate.employeeId} ${candidate.fullName} (sigur ${candidate.sigurEmployeeId})`);
  }
  if (plan.problems.length > 0) {
    console.error('Проблемные сотрудники — операция отменена (частичный перенос оставит дубль непустым):');
    for (const item of plan.problems) console.error(`  ✗ ${item}`);
    await getPool().end();
    process.exit(1);
  }
  if (plan.candidates.length === 0) {
    console.log('В источнике никого нет — переносить нечего.');
    await getPool().end();
    return;
  }

  const employeeIds = plan.candidates.map(c => c.employeeId);
  const targetEmployeeIds = await query<{ id: number }>(
    'SELECT id FROM employees WHERE org_department_id = $1::uuid AND is_archived = false',
    [target!.id],
  );
  const allIds = [...new Set([...employeeIds, ...targetEmployeeIds.map(r => Number(r.id))])];

  const inventoryBefore = await loadInventory(allIds);
  const approvalsBefore = await loadApprovals([source!.id, target!.id]);
  console.log(`Инвентарь до: ${JSON.stringify(inventoryBefore)}`);
  console.log(`Закрытых подач в слепке: ${approvalsBefore.length}`);

  if (!apply) {
    console.log('\nРежим dry-run. Для применения: --apply [--snapshot=<путь>]');
    await getPool().end();
    return;
  }

  // ── Фаза 1: Sigur ──────────────────────────────────────────────────────────
  const sigurResult = await moveEmployeesInSigur(plan.candidates, targetSigurId);
  console.log(`Sigur: переведено ${sigurResult.moved}, уже в цели ${sigurResult.skipped}`);

  if (sigurDepartmentIds.has(sourceSigurId)) {
    const rawEmployees = await sigurService.getEmployees(undefined) as Record<string, unknown>[];
    const leftovers = (rawEmployees || [])
      .map(normalizeEmployee)
      .filter(item => item.departmentId === sourceSigurId);
    if (leftovers.length > 0) {
      console.error(`В Sigur в отделе ${sourceSigurId} остались карточки: ${leftovers.map(l => l.id).join(', ')}`);
      console.error('Перенос в FOT не выполняем — сначала разберите остаток в Sigur.');
      await getPool().end();
      process.exit(1);
    }
  }

  // ── Фаза 2: FOT, одна транзакция ───────────────────────────────────────────
  const createdAt = new Date().toISOString();
  const snapshotPath = path.resolve(
    argValue('snapshot')
    ?? path.resolve(__dirname, `../../temp/merge_department_${sourceSigurId}_to_${targetSigurId}_${createdAt.replace(/[:.]/g, '-')}.json`),
  );

  const counters = await withTransaction(async client => {
    const fresh = await loadMergeCandidates(client, source!.id);
    const freshPlan = planEmployeeMerge(fresh);
    if (freshPlan.problems.length > 0) {
      throw new Error(`состав источника изменился между preflight и записью: ${freshPlan.problems.join('; ')}`);
    }

    const openAssignments = await client.query<{ id: string; employee_id: number }>(
      `SELECT id::text, employee_id FROM employee_assignments
        WHERE employee_id = ANY($1::bigint[]) AND effective_to IS NULL AND org_department_id = $2::uuid`,
      [employeeIds, source!.id],
    );
    const assignmentsByEmployee = new Map<number, string[]>();
    for (const row of openAssignments.rows) {
      const list = assignmentsByEmployee.get(Number(row.employee_id)) ?? [];
      list.push(row.id);
      assignmentsByEmployee.set(Number(row.employee_id), list);
    }

    const accessRows = await client.query<{ id: string; employee_id: number; department_id: string; is_active: boolean }>(
      `SELECT id::text, employee_id, department_id::text, is_active
         FROM employee_department_access
        WHERE department_id = ANY($1::uuid[])`,
      [[source!.id, target!.id]],
    );

    const snapshot: ISnapshot = {
      created_at: createdAt,
      source: { sigur_department_id: sourceSigurId, department_id: source!.id, name: source!.name },
      target: { sigur_department_id: targetSigurId, department_id: target!.id, name: target!.name },
      employees: plan.candidates.map(candidate => ({
        employeeId: candidate.employeeId,
        fullName: candidate.fullName,
        sigurEmployeeId: candidate.sigurEmployeeId,
        orgDepartmentId: source!.id,
        openAssignmentIds: assignmentsByEmployee.get(candidate.employeeId) ?? [],
      })),
      access: accessRows.rows.map(row => ({
        id: row.id,
        employeeId: Number(row.employee_id),
        departmentId: row.department_id,
        isActive: row.is_active,
      })),
      inventory: inventoryBefore,
      approvals: approvalsBefore,
    };

    const result = await mergeDepartmentEmployeesTx(client, {
      sourceDepartmentId: source!.id,
      targetDepartmentId: target!.id,
      employeeIds,
    });

    // Post-check ДО commit: источник пуст, у каждого ровно одно открытое назначение в цели.
    const left = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM employees WHERE org_department_id = $1::uuid',
      [source!.id],
    );
    if (Number(left.rows[0]?.count ?? '0') !== 0) {
      throw new Error('после переноса в источнике остались сотрудники — откат');
    }
    const open = await client.query<{ employee_id: number; count: string }>(
      `SELECT employee_id, count(*)::text AS count FROM employee_assignments
        WHERE employee_id = ANY($1::bigint[]) AND effective_to IS NULL AND org_department_id = $2::uuid
        GROUP BY employee_id`,
      [employeeIds, target!.id],
    );
    if (open.rows.length !== employeeIds.length || open.rows.some(row => Number(row.count) !== 1)) {
      throw new Error('после переноса открытые назначения не сошлись — откат');
    }

    // Снимок на диск ДО commit: не записался файл — откатилась транзакция.
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

    return result;
  });

  console.log(
    `FOT: сотрудников ${counters.employeesUpdated}, открытых назначений ${counters.assignmentsUpdated},`
    + ` доступ создан ${counters.accessGranted}, включён ${counters.accessReactivated},`
    + ` погашено на источнике ${counters.accessRevoked}`,
  );
  console.log(`Снимок для отката: ${snapshotPath}`);

  // ── Фаза 3: сверка ─────────────────────────────────────────────────────────
  const inventoryAfter = await loadInventory(allIds);
  const inventoryDiff = Object.entries(inventoryAfter)
    .filter(([table, count]) => count !== inventoryBefore[table])
    .map(([table, count]) => `${table}: ${inventoryBefore[table]} → ${count}`);

  const approvalsAfter = await loadApprovals([source!.id, target!.id]);
  const approvalsChanged = JSON.stringify(approvalsBefore) !== JSON.stringify(approvalsAfter);

  if (inventoryDiff.length > 0) {
    console.error(`⚠ Инвентарь изменился: ${inventoryDiff.join(', ')}`);
  } else {
    console.log('Инвентарь данных сотрудников не изменился.');
  }
  if (approvalsChanged) {
    console.error('⚠ Слепок закрытых подач изменился — проверьте вручную.');
  } else {
    console.log('Закрытые подачи и их версии не изменились.');
  }

  console.log('\nДальше вручную: раздел SIGUR → удалить пустой отдел '
    + `«${source!.name}» (${sourceSigurId}); затем СКУД → Фильтр синхронизации → Сохранить.`);

  await getPool().end();
  if (inventoryDiff.length > 0 || approvalsChanged) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Ошибка слияния:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
