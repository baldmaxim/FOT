/**
 * Консолидация дублей файлов-вложений корректировок за период (по умолчанию 01–15.06.2026).
 *
 * До фикса один файл массовой корректировки прикреплялся отдельным документом на КАЖДЫЙ
 * день. Скрипт схлопывает такой набор в ОДИН документ, привязанный ко всем дням (как ведёт
 * себя новая модель), и удаляет лишние документы + их R2-объекты.
 *
 * По умолчанию --dry-run (только печать плана). Применение — флаг --apply.
 *
 * Усиленные гарды (берём документ в обработку только если все выполнены):
 *  - category='timesheet_correction' и leave_request_id IS NULL;
 *  - у документа НЕТ ссылок иного типа (только attendance_adjustment/timesheet_correction);
 *  - ВСЕ привязанные дни документа в окне [FROM, TO];
 *  - группа = один пользовательский батч: разброс created_at ≤ BATCH_MINUTES,
 *    иначе группа пропускается (skip unless exact batch) и логируется для ручного разбора.
 *
 * Группировка: (employee_id, file_name, file_size, mime_type, uploaded_by).
 *
 * Запуск:  npx tsx scripts/dedup-correction-attachments-h1-june.ts            # dry-run
 *          npx tsx scripts/dedup-correction-attachments-h1-june.ts --apply    # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';
import { r2Service } from '../src/services/r2.service.js';

const FROM = process.env.FROM ?? '2026-06-01';
const TO = process.env.TO ?? '2026-06-15';
const APPLY = process.argv.includes('--apply');
const BATCH_MINUTES = Number(process.env.BATCH_MINUTES ?? 10);

const CORR_ENTITY = 'attendance_adjustment';
const CORR_PURPOSE = 'timesheet_correction';

interface DocLite {
  document_id: number;
  employee_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string | null;
  created_at: string;
  adjustmentIds: number[];
  workDates: string[];
}

const inWindow = (date: string): boolean => date >= FROM && date <= TO;

async function loadCleanCandidates(): Promise<DocLite[]> {
  // 1. Документы-кандидаты: correction-вложения, у которых есть хотя бы один день в окне.
  const candidateRows = await query<{
    id: number | string; employee_id: number | string; file_name: string;
    file_size: number | string; mime_type: string; r2_key: string;
    uploaded_by: string | null; created_at: string;
  }>(
    `SELECT DISTINCT d.id, d.employee_id, d.file_name, d.file_size, d.mime_type,
            d.r2_key, d.uploaded_by, d.created_at
       FROM documents d
       JOIN document_links dl
         ON dl.document_id = d.id
        AND dl.entity_type = $3 AND dl.purpose = $4
       JOIN attendance_adjustments aa ON aa.id = dl.entity_id::int
      WHERE d.category = 'timesheet_correction'
        AND d.leave_request_id IS NULL
        AND aa.work_date >= $1::date AND aa.work_date <= $2::date`,
    [FROM, TO, CORR_ENTITY, CORR_PURPOSE],
  );
  if (candidateRows.length === 0) return [];

  const docById = new Map<number, DocLite>();
  for (const r of candidateRows) {
    docById.set(Number(r.id), {
      document_id: Number(r.id),
      employee_id: Number(r.employee_id),
      file_name: String(r.file_name),
      file_size: Number(r.file_size),
      mime_type: String(r.mime_type),
      r2_key: String(r.r2_key),
      uploaded_by: r.uploaded_by ? String(r.uploaded_by) : null,
      created_at: String(r.created_at),
      adjustmentIds: [],
      workDates: [],
    });
  }

  // 2. ВСЕ ссылки кандидатов + дни их корректировок (для проверки гардов).
  const linkRows = await query<{
    document_id: number | string; entity_type: string; purpose: string;
    adj_id: number | string | null; work_date: string | null;
  }>(
    `SELECT dl.document_id, dl.entity_type, dl.purpose,
            aa.id AS adj_id, aa.work_date
       FROM document_links dl
       LEFT JOIN attendance_adjustments aa
         ON dl.entity_type = $2 AND aa.id = dl.entity_id::int
      WHERE dl.document_id = ANY($1::int[])`,
    [[...docById.keys()], CORR_ENTITY],
  );

  const foreignDocs = new Set<number>();
  const outOfWindowDocs = new Set<number>();
  for (const l of linkRows) {
    const docId = Number(l.document_id);
    const doc = docById.get(docId);
    if (!doc) continue;
    const isCorr = l.entity_type === CORR_ENTITY && l.purpose === CORR_PURPOSE;
    if (!isCorr) { foreignDocs.add(docId); continue; }
    if (l.adj_id == null || l.work_date == null) { outOfWindowDocs.add(docId); continue; }
    const wd = String(l.work_date).slice(0, 10);
    if (!inWindow(wd)) { outOfWindowDocs.add(docId); continue; }
    doc.adjustmentIds.push(Number(l.adj_id));
    doc.workDates.push(wd);
  }

  const clean: DocLite[] = [];
  for (const doc of docById.values()) {
    if (foreignDocs.has(doc.document_id)) {
      console.log(`⏭️  doc ${doc.document_id} пропущен: есть сторонние ссылки (не correction)`);
      continue;
    }
    if (outOfWindowDocs.has(doc.document_id)) {
      console.log(`⏭️  doc ${doc.document_id} пропущен: есть день вне окна [${FROM};${TO}]`);
      continue;
    }
    if (doc.adjustmentIds.length === 0) continue;
    clean.push(doc);
  }
  return clean;
}

function groupKey(d: DocLite): string {
  return `${d.employee_id}|${d.file_name}|${d.file_size}|${d.mime_type}|${d.uploaded_by ?? ''}`;
}

function batchSpreadMinutes(docs: DocLite[]): number {
  const times = docs.map(d => Date.parse(d.created_at)).filter(t => Number.isFinite(t));
  if (times.length === 0) return 0;
  return (Math.max(...times) - Math.min(...times)) / 60000;
}

async function consolidate(group: DocLite[]): Promise<{ deletedDocs: number; r2Keys: string[] }> {
  const sorted = [...group].sort((a, b) => a.document_id - b.document_id);
  const kept = sorted[0];
  const dups = sorted.slice(1);
  const allAdjustmentIds = [...new Set(group.flatMap(d => d.adjustmentIds))];
  const dupIds = dups.map(d => d.document_id);
  const dupR2Keys = [...new Set(dups.map(d => d.r2_key))].filter(k => k !== kept.r2_key);

  await withTransaction(async (client) => {
    // Привязываем kept ко всем дням набора.
    await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         SELECT $1, $2, adj_id::text, $3 FROM unnest($4::int[]) AS adj_id
       ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
      [kept.document_id, CORR_ENTITY, CORR_PURPOSE, allAdjustmentIds],
    );
    // Удаляем дубль-документы и их ссылки.
    await client.query(`DELETE FROM document_links WHERE document_id = ANY($1::int[])`, [dupIds]);
    await client.query(`DELETE FROM documents WHERE id = ANY($1::int[])`, [dupIds]);
  });

  // R2-объекты дублей (kept не трогаем).
  for (const key of dupR2Keys) {
    try { await r2Service.deleteObject(key); }
    catch (err) { console.warn(`⚠️  R2 delete не удалось для ${key}:`, err); }
  }
  return { deletedDocs: dupIds.length, r2Keys: dupR2Keys };
}

async function main(): Promise<void> {
  console.log(`${APPLY ? '⚙️  APPLY' : '🧪 DRY-RUN'}: консолидация дублей за ${FROM} … ${TO} (batch ≤ ${BATCH_MINUTES} мин)\n`);

  const clean = await loadCleanCandidates();
  const groups = new Map<string, DocLite[]>();
  for (const doc of clean) {
    const key = groupKey(doc);
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }

  let groupsToFix = 0;
  let docsToDelete = 0;
  let r2ToDelete = 0;

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const spread = batchSpreadMinutes(group);
    if (spread > BATCH_MINUTES) {
      console.log(`⏭️  [${key}] пропуск: разброс created_at ${spread.toFixed(1)} мин > ${BATCH_MINUTES} (не один батч)`);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.document_id - b.document_id);
    const kept = sorted[0];
    const dupIds = sorted.slice(1).map(d => d.document_id);
    const allDays = [...new Set(group.flatMap(d => d.workDates))].sort();
    groupsToFix++;
    docsToDelete += dupIds.length;
    console.log(
      `${APPLY ? '✅' : '•'} emp ${kept.employee_id} «${kept.file_name}»: kept=${kept.document_id}, `
      + `удалить doc=[${dupIds.join(',')}], дней=${allDays.length} (${allDays[0]}…${allDays[allDays.length - 1]})`,
    );

    if (APPLY) {
      const { deletedDocs, r2Keys } = await consolidate(group);
      r2ToDelete += r2Keys.length;
      console.log(`   → удалено документов: ${deletedDocs}, R2-объектов: ${r2Keys.length}`);
    } else {
      r2ToDelete += [...new Set(sorted.slice(1).map(d => d.r2_key))].filter(k => k !== kept.r2_key).length;
    }
  }

  console.log(
    `\n📊 Групп к консолидации: ${groupsToFix}; документов ${APPLY ? 'удалено' : 'к удалению'}: ${docsToDelete}; `
    + `R2-объектов ${APPLY ? 'удалено' : 'к удалению'}: ${r2ToDelete}`,
  );
  if (!APPLY) console.log('ℹ️  Это dry-run. Для применения запустите с флагом --apply');
}

main()
  .catch(err => { console.error('❌ Ошибка:', err); process.exit(1); })
  .then(() => process.exit(0));
