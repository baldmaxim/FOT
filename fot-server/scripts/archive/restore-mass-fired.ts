/**
 * Реактивация ошибочно уволенных сотрудников.
 *
 * Берёт всех employees с employment_status='fired' и sigur_employee_id IS NOT NULL,
 * сверяет со свежей выгрузкой из Sigur:
 *   - в обычном отделе (sigur_dept != archive)         → реактивирует
 *   - в архивной папке Sigur                            → пропускает (реально уволен)
 *   - отсутствует в Sigur                               → пропускает (потерян)
 *
 * Запуск:
 *   npx tsx fot-server/scripts/restore-mass-fired.ts                # dry-run (ничего не пишет)
 *   npx tsx fot-server/scripts/restore-mass-fired.ts --apply        # фактическое восстановление
 *   npx tsx fot-server/scripts/restore-mass-fired.ts --apply --connection=internal
 */
import { supabase } from '../src/config/database.js';
import { sigurService } from '../src/services/sigur.service.js';
import { settingsService } from '../src/services/settings.service.js';
import { normalizeEmployee } from '../src/services/sigur-sync-shared.js';
import type { ConnectionType } from '../src/services/sigur-base.service.js';

interface IFiredEmployee {
  id: number;
  full_name: string | null;
  sigur_employee_id: number;
  org_department_id: string | null;
  is_archived: boolean;
}

interface IDecision {
  emp: IFiredEmployee;
  action: 'reactivate' | 'skip_in_archive' | 'skip_not_in_sigur';
  sigurDeptId: number | null;
  targetOrgDepartmentId: string | null;
}

function parseArgs(): { apply: boolean; connection: ConnectionType } {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const connArg = args.find(a => a.startsWith('--connection='));
  const connectionRaw = connArg ? connArg.split('=')[1] : 'external';
  const connection: ConnectionType = connectionRaw === 'internal' ? 'internal' : 'external';
  return { apply, connection };
}

async function main(): Promise<void> {
  const { apply, connection } = parseArgs();
  console.log(`[restore-mass-fired] mode=${apply ? 'APPLY' : 'DRY-RUN'} connection=${connection}`);

  if (!(await sigurService.isConfigured())) {
    throw new Error('Sigur не настроен — заполните system_settings.sigur_external_*');
  }

  const sigurSettings = await settingsService.getSigurConnectionSettings();
  const archiveDepartmentId = sigurSettings.archiveDepartmentId;
  if (!archiveDepartmentId) {
    throw new Error('sigur_archive_department_id не задан в system_settings');
  }
  console.log(`[restore-mass-fired] archive department id (Sigur) = ${archiveDepartmentId}`);

  console.log('[restore-mass-fired] Загружаю fired сотрудников из БД...');
  const { data: firedRaw, error: firedErr } = await supabase
    .from('employees')
    .select('id, full_name, sigur_employee_id, org_department_id, is_archived')
    .eq('employment_status', 'fired')
    .not('sigur_employee_id', 'is', null);
  if (firedErr) throw firedErr;
  const fired: IFiredEmployee[] = (firedRaw ?? []).map(r => ({
    id: Number(r.id),
    full_name: (r.full_name as string | null) ?? null,
    sigur_employee_id: Number(r.sigur_employee_id),
    org_department_id: (r.org_department_id as string | null) ?? null,
    is_archived: Boolean(r.is_archived),
  }));
  console.log(`[restore-mass-fired] fired в БД: ${fired.length}`);

  console.log('[restore-mass-fired] Загружаю свежую выгрузку Sigur (без кэша)...');
  const sigurRaw = await sigurService.getEmployees(undefined, connection) as Record<string, unknown>[];
  const sigurNorm = sigurRaw.map(normalizeEmployee);
  const sigurById = new Map<number, { departmentId: number | undefined }>();
  for (const e of sigurNorm) {
    if (e.id != null) sigurById.set(e.id, { departmentId: e.departmentId });
  }
  console.log(`[restore-mass-fired] Sigur вернул ${sigurNorm.length} сотрудников`);

  const { data: deptRaw, error: deptErr } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id')
    .not('sigur_department_id', 'is', null);
  if (deptErr) throw deptErr;
  const sigurDeptToOrgId = new Map<number, string>();
  for (const d of deptRaw ?? []) {
    if (d.sigur_department_id != null) {
      sigurDeptToOrgId.set(Number(d.sigur_department_id), String(d.id));
    }
  }

  const decisions: IDecision[] = [];
  for (const emp of fired) {
    const sigurEmp = sigurById.get(emp.sigur_employee_id);
    if (!sigurEmp) {
      decisions.push({ emp, action: 'skip_not_in_sigur', sigurDeptId: null, targetOrgDepartmentId: null });
      continue;
    }
    const sigurDeptId = sigurEmp.departmentId ?? null;
    if (sigurDeptId === archiveDepartmentId) {
      decisions.push({ emp, action: 'skip_in_archive', sigurDeptId, targetOrgDepartmentId: null });
      continue;
    }
    const target = sigurDeptId != null ? sigurDeptToOrgId.get(sigurDeptId) ?? null : null;
    decisions.push({
      emp,
      action: 'reactivate',
      sigurDeptId,
      targetOrgDepartmentId: target ?? emp.org_department_id,
    });
  }

  const reactivate = decisions.filter(d => d.action === 'reactivate');
  const inArchive = decisions.filter(d => d.action === 'skip_in_archive');
  const notInSigur = decisions.filter(d => d.action === 'skip_not_in_sigur');

  console.log('');
  console.log('=== СВОДКА ===');
  console.log(`К восстановлению:        ${reactivate.length}`);
  console.log(`В архивной папке Sigur:  ${inArchive.length} (не трогаем)`);
  console.log(`Отсутствуют в Sigur:     ${notInSigur.length} (не трогаем)`);
  console.log('');

  if (reactivate.length > 0) {
    console.log('--- Будут реактивированы ---');
    for (const d of reactivate) {
      const dept = d.targetOrgDepartmentId ?? '(нет маппинга)';
      console.log(`  #${d.emp.id}  sigurId=${d.emp.sigur_employee_id}  sigurDept=${d.sigurDeptId}  → org_dept=${dept}  | ${d.emp.full_name}`);
    }
    console.log('');
  }

  if (notInSigur.length > 0) {
    console.log('--- Отсутствуют в Sigur (skip) ---');
    for (const d of notInSigur) {
      console.log(`  #${d.emp.id}  sigurId=${d.emp.sigur_employee_id}  | ${d.emp.full_name}`);
    }
    console.log('');
  }

  if (!apply) {
    console.log('[restore-mass-fired] DRY-RUN — изменения не записаны. Запустите с флагом --apply.');
    return;
  }

  if (reactivate.length === 0) {
    console.log('[restore-mass-fired] Восстанавливать некого, выходим.');
    return;
  }

  console.log(`[restore-mass-fired] Применяю изменения для ${reactivate.length} сотрудников...`);
  const nowIso = new Date().toISOString();
  let ok = 0;
  const failures: { id: number; error: string }[] = [];

  for (const d of reactivate) {
    const update: Record<string, unknown> = {
      employment_status: 'active',
      is_archived: false,
      archived_at: null,
      updated_at: nowIso,
    };
    if (d.targetOrgDepartmentId) update.org_department_id = d.targetOrgDepartmentId;

    const { error } = await supabase
      .from('employees')
      .update(update)
      .eq('id', d.emp.id);
    if (error) {
      failures.push({ id: d.emp.id, error: error.message });
      console.error(`  FAIL #${d.emp.id}: ${error.message}`);
    } else {
      ok++;
      console.log(`  OK   #${d.emp.id}  ${d.emp.full_name}`);
    }
  }

  console.log('');
  console.log('=== РЕЗУЛЬТАТ ===');
  console.log(`Восстановлено: ${ok}`);
  console.log(`Ошибок:        ${failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  #${f.id}: ${f.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[restore-mass-fired] FATAL:', err);
    process.exit(1);
  });
