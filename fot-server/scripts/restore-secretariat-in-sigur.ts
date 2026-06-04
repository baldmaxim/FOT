/**
 * Восстановление ветки «Центральный секретариат» В SIGUR (через REST API).
 *
 * Создаёт 3 подразделения и переносит в них 10 сотрудников. Sigur — источник
 * истины; после этого FOT синком сойдётся сам (старые одноимённые строки
 * схлопнутся consolidateDuplicateDepartments).
 *
 * БЕЗОПАСНОСТЬ:
 *   - по умолчанию DRY-RUN: только печатает план, НИЧЕГО не пишет.
 *   - запись только с флагом --apply.
 *   - идемпотентно: если отдел с таким именем под нужным родителем уже есть —
 *     переиспользует его; сотрудника двигает, только если он сейчас НЕ в целевом.
 *
 * Запуск (на сервере, build-контекст):
 *   cd /opt/fot-build/fot-server
 *   npx tsx scripts/restore-secretariat-in-sigur.ts            # dry-run (план)
 *   npx tsx scripts/restore-secretariat-in-sigur.ts --apply    # выполнить
 */
import { sigurService } from '../src/services/sigur.service.js';
import { normalizeDepartment, normalizeDepartmentLookupName, normalizeEmployee } from '../src/services/sigur-sync-shared.js';
import { createSigurDepartment } from '../src/services/sigur-live-departments-crud.service.js';
import { moveSigurEmployee } from '../src/services/sigur-live-employees-crud.service.js';

const APPLY = process.argv.includes('--apply');

// Родитель ветки в Sigur — «(СУ-10) ООО СУ-10».
const ROOT_SU10 = 142365;

// Целевая структура: Центральный секретариат → {Секретариат, Секретариат-Объекты}.
const CENTRAL = 'Центральный секретариат';
const LEAF_SEKR = 'Секретариат';
const LEAF_OBJ = 'Секретариат-Объекты';

// Сотрудники: sigur_employee_id → целевой лист.
const ASSIGN: Array<{ sigurId: number; fio: string; leaf: string }> = [
  { sigurId: 138721, fio: 'Душанова Елена Анатольевна', leaf: LEAF_SEKR },
  { sigurId: 125880, fio: 'Расстрыгина Юлия Анатольевна', leaf: LEAF_SEKR },
  { sigurId: 145833, fio: 'Гейнц Милада Александровна', leaf: LEAF_SEKR },
  { sigurId: 118844, fio: 'Александрович Руслана', leaf: LEAF_OBJ },
  { sigurId: 102932, fio: 'Лаптева Надежда Владимировна', leaf: LEAF_OBJ },
  { sigurId: 82270, fio: 'Матвеева Людмила Викторовна', leaf: LEAF_OBJ },
  { sigurId: 62489, fio: 'Пахомова Василина Валерьевна', leaf: LEAF_OBJ },
  { sigurId: 110197, fio: 'Смитская Юлия Александровна', leaf: LEAF_OBJ },
  { sigurId: 141311, fio: 'Имаметдинова Рузалия Рушановна', leaf: LEAF_OBJ },
  { sigurId: 141255, fio: 'Пацюкова Татьяна Владимировна', leaf: LEAF_OBJ },
];

async function loadDepts() {
  const raw = (await sigurService.getDepartments()) as Record<string, unknown>[];
  return raw.map(normalizeDepartment).filter(d => d.id);
}

function findChild(depts: Array<{ id: number; name: string; parentId: number | null }>, parentId: number, name: string): number | null {
  const key = normalizeDepartmentLookupName(name);
  const hit = depts.find(d => d.parentId === parentId && normalizeDepartmentLookupName(d.name) === key);
  return hit ? hit.id : null;
}

/** Возвращает id отдела (существующего или созданного). В dry-run для нового — null. */
async function ensureDept(deptsRef: { list: Array<{ id: number; name: string; parentId: number | null }> }, parentId: number, name: string): Promise<number | null> {
  const existing = findChild(deptsRef.list, parentId, name);
  if (existing) {
    console.log(`  ✓ уже есть: «${name}» (id=${existing}) под parent=${parentId}`);
    return existing;
  }
  if (!APPLY) {
    console.log(`  [dry-run] СОЗДАТЬ: «${name}» под parent=${parentId}`);
    return null;
  }
  const created = await createSigurDepartment({ name, parentId });
  console.log(`  + создан: «${name}» (id=${created.id}) под parent=${parentId}`);
  deptsRef.list.push({ id: created.id, name: created.name, parentId: created.parentId ?? parentId });
  return created.id;
}

async function main() {
  console.log(`=== Восстановление секретариата в Sigur (${APPLY ? 'APPLY — запись!' : 'DRY-RUN — только план'}) ===\n`);

  const deptsRef = { list: await loadDepts() };

  // Проверка родителя.
  if (!deptsRef.list.some(d => d.id === ROOT_SU10)) {
    throw new Error(`Родитель ROOT_SU10=${ROOT_SU10} не найден в Sigur — прерываю.`);
  }
  console.log(`Родитель: ${ROOT_SU10} «(СУ-10) ООО СУ-10» ✓\n`);

  console.log('── Подразделения ──');
  const centralId = await ensureDept(deptsRef, ROOT_SU10, CENTRAL);
  const sekrId = centralId != null ? await ensureDept(deptsRef, centralId, LEAF_SEKR) : null;
  const objId = centralId != null ? await ensureDept(deptsRef, centralId, LEAF_OBJ) : null;

  if (!APPLY) {
    console.log('\n[dry-run] id новых отделов пока неизвестны — переносы сотрудников показаны по целевому имени.');
  }

  // Карта сотрудник → текущий departmentId в Sigur.
  const emps = ((await sigurService.getEmployees()) as Record<string, unknown>[]).map(normalizeEmployee);
  const curDept = new Map<number, number | undefined>();
  for (const e of emps) if (typeof e.id === 'number') curDept.set(e.id, e.departmentId);

  const leafId = (leaf: string): number | null => (leaf === LEAF_SEKR ? sekrId : objId);

  console.log('\n── Перенос сотрудников ──');
  let moved = 0, skipped = 0, planned = 0;
  for (const a of ASSIGN) {
    if (!curDept.has(a.sigurId)) { console.log(`  ! ${a.fio} (sigurId=${a.sigurId}) — не найден в Sigur, пропуск`); continue; }
    const target = leafId(a.leaf);
    const cur = curDept.get(a.sigurId);
    if (target != null && cur === target) { console.log(`  ✓ ${a.fio} — уже в «${a.leaf}» (id=${target})`); skipped++; continue; }
    if (!APPLY || target == null) { console.log(`  [dry-run] ПЕРЕНЕСТИ ${a.fio} (sigurId=${a.sigurId}) ${cur ?? '—'} → «${a.leaf}»`); planned++; continue; }
    await moveSigurEmployee(a.sigurId, target);
    console.log(`  → ${a.fio} перенесён в «${a.leaf}» (id=${target})`);
    moved++;
  }

  console.log(`\nИтог: ${APPLY ? `перенесено ${moved}, уже на месте ${skipped}` : `план: создать недостающие отделы + перенести ${planned}, уже на месте ${skipped}`}.`);
  if (!APPLY) console.log('Это был DRY-RUN. Для выполнения: npx tsx scripts/restore-secretariat-in-sigur.ts --apply');
  console.log('\nПосле APPLY дождитесь структурного синка FOT и запустите diagnose-sigur-dept-sync.ts для сверки.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.message ?? err);
  process.exit(1);
});
