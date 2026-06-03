/**
 * Диагностика рассинхрона отделов Sigur ↔ БД ФОТ (READ-ONLY).
 *
 * Сверяет ТРИ среза:
 *   1) Sigur: список отделов (/api/v1/departments)
 *   2) Sigur: отделы, на которые ссылаются сотрудники (/api/v1/employees → departmentId)
 *   3) FOT:  org_departments (active / sigur_department_id)
 *
 * Находит:
 *   A) referenced-but-not-listed: отдел есть у сотрудников Sigur, но НЕТ в списке
 *      отделов Sigur — внутренняя несогласованность ИСТОЧНИКА (главная причина).
 *   B) FOT-active, но НЕ в фиде Sigur — FOT держит «лишние» активные (или фид неполный).
 *   C) В фиде Sigur, но в FOT неактивен/отсутствует — FOT отстаёт.
 *
 * Запуск на сервере (build-контекст с src+tsx, .env с сайта):
 *   cd /opt/fot-build && npx tsx fot-server/scripts/diagnose-sigur-dept-sync.ts
 *
 * Ничего не пишет ни в Sigur, ни в БД.
 */
import { sigurService } from '../src/services/sigur.service.js';
import { query } from '../src/config/postgres.js';
import { normalizeDepartment, normalizeEmployee } from '../src/services/sigur-sync-shared.js';

function fmt(ids: Iterable<number>, names: Map<number, string>, limit = 50): string {
  const arr = [...ids];
  const shown = arr.slice(0, limit).map(id => `  ${id}  ${names.get(id) ?? '—'}`);
  const tail = arr.length > limit ? `\n  …ещё ${arr.length - limit}` : '';
  return shown.join('\n') + tail;
}

async function main() {
  console.log('=== Диагностика синхронизации отделов Sigur ↔ FOT (read-only) ===\n');

  // --- Sigur: отделы ---
  const rawDepts = (await sigurService.getDepartments()) as Record<string, unknown>[];
  const depts = rawDepts.map(normalizeDepartment).filter(d => d.id);
  const feedIds = new Set<number>(depts.map(d => d.id));
  const nameById = new Map<number, string>();
  for (const d of depts) nameById.set(d.id, d.name || '—');
  console.log(`Sigur /departments: ${feedIds.size} отделов`);

  // --- Sigur: сотрудники → departmentId ---
  const rawEmps = (await sigurService.getEmployees()) as Record<string, unknown>[];
  const emps = rawEmps.map(normalizeEmployee);
  const refIds = new Set<number>();
  const refCount = new Map<number, number>();
  for (const e of emps) {
    if (typeof e.departmentId === 'number' && e.departmentId > 0) {
      refIds.add(e.departmentId);
      refCount.set(e.departmentId, (refCount.get(e.departmentId) ?? 0) + 1);
    }
  }
  console.log(`Sigur /employees: ${emps.length} сотрудников, ссылаются на ${refIds.size} отделов\n`);

  // --- FOT: org_departments ---
  const fotRows = await query<{ sigur_department_id: number | null; name: string | null; is_active: boolean }>(
    'SELECT sigur_department_id, name, is_active FROM org_departments WHERE sigur_department_id IS NOT NULL',
  );
  const fotActive = new Set<number>();
  const fotAll = new Set<number>();
  const fotName = new Map<number, string>();
  for (const r of fotRows) {
    if (r.sigur_department_id == null) continue;
    fotAll.add(r.sigur_department_id);
    if (r.is_active) fotActive.add(r.sigur_department_id);
    fotName.set(r.sigur_department_id, r.name || '—');
  }
  console.log(`FOT org_departments c sigur_id: ${fotAll.size} (активных ${fotActive.size})\n`);

  // --- A) referenced-but-not-listed (несогласованность Sigur) ---
  const aMissing = [...refIds].filter(id => !feedIds.has(id))
    .sort((x, y) => (refCount.get(y)! - refCount.get(x)!));
  console.log('── A) Отделы Sigur с сотрудниками, но ОТСУТСТВУЮТ в списке /departments (рассинхрон ИСТОЧНИКА) ──');
  if (aMissing.length === 0) console.log('  нет — источник согласован ✅');
  else for (const id of aMissing) {
    console.log(`  sigur_id=${id}  сотрудников=${refCount.get(id)}  имя(FOT)=${fotName.get(id) ?? '—'}  активен(FOT)=${fotActive.has(id)}`);
  }

  // --- B) FOT-active, но НЕ в фиде Sigur ---
  const bExtra = [...fotActive].filter(id => !feedIds.has(id));
  console.log('\n── B) Активны в FOT, но НЕТ в фиде Sigur /departments ──');
  if (bExtra.length === 0) console.log('  нет ✅');
  else for (const id of bExtra) {
    console.log(`  sigur_id=${id}  имя(FOT)=${fotName.get(id) ?? '—'}  сотрудников(Sigur)=${refCount.get(id) ?? 0}  ${refIds.has(id) ? '(но есть у сотрудников Sigur → ложный фантом)' : '(и нет у сотрудников → возможно реально удалён)'}`);
  }

  // --- C) В фиде Sigur, но неактивен/отсутствует в FOT ---
  const cLag = [...feedIds].filter(id => !fotActive.has(id));
  console.log('\n── C) Есть в фиде Sigur, но в FOT неактивен/отсутствует (FOT отстаёт) ──');
  if (cLag.length === 0) console.log('  нет ✅');
  else console.log(fmt(cLag, nameById));

  // --- Точечно по нашему инциденту ---
  console.log('\n── Контроль по инциденту (секретариат/коменданты/курьеры) ──');
  for (const id of [145804, 142624, 145807, 142585, 142587]) {
    console.log(`  sigur_id=${id}: в фиде=${feedIds.has(id)} | у сотрудников=${refCount.get(id) ?? 0} | FOT active=${fotActive.has(id)} | имя(Sigur)=${nameById.get(id) ?? '—'} | имя(FOT)=${fotName.get(id) ?? '—'}`);
  }

  console.log('\n=== готово ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка диагностики:', err?.message ?? err);
  process.exit(1);
});
