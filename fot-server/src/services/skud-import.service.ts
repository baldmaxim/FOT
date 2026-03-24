/**
 * СКУД: импорт событий из Excel, синхронизация из Sigur, очистка дублей.
 */
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { auditService } from './audit.service.js';
import { sigurService } from './sigur.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { buildInclusiveDateRange, parseDate } from '../utils/date.utils.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import { isHeaderRow, parseTimeFromDateTime } from './skud-shared.service.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import type {
  ISkudEventRow,
  IImportParams,
  IImportResult,
  ICleanDuplicatesResult,
  IClearParams,
} from '../types/skud.types.js';

// ─── Import from Excel ───

export async function importFromExcel(params: IImportParams): Promise<IImportResult> {
  const { organizationId, fileBuffer } = params;

  // Загружаем сотрудников для сопоставления по ФИО
  const { data: employeesData } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('organization_id', organizationId)
    .eq('is_archived', false);

  const employeeMap = new Map<string, number>();
  for (const emp of employeesData || []) {
    const name = (emp.full_name || '').toLowerCase().trim();
    employeeMap.set(name, emp.id);
  }

  // Парсим Excel
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    dateNF: 'yyyy-mm-dd',
  });

  if (rows.length === 0) {
    throw new Error('Файл пуст');
  }

  const startRow = isHeaderRow(rows[0]) ? 1 : 0;
  const dataRows = rows.slice(startRow);

  const errors: string[] = [];
  const eventsToInsert: ISkudEventRow[] = [];
  const summariesToUpdate = new Set<string>();
  const seenHashes = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = startRow + i + 1;

    if (!row || row.length === 0 || !row[0]) continue;

    const physicalPerson = String(row[0] || '').trim();
    const dateRaw = row[3];
    const dateTimeRaw = row[4];
    const cardNumber = String(row[6] || '').trim() || null;
    const accessPoint = String(row[7] || '').trim() || null;
    const doorRaw = String(row[8] || '').trim();

    if (!physicalPerson) {
      errors.push(`Строка ${rowNum}: отсутствует ФИО`);
      continue;
    }

    const eventDate = parseDate(dateRaw);
    if (!eventDate) {
      errors.push(`Строка ${rowNum}: некорректная дата`);
      continue;
    }

    const eventTime = parseTimeFromDateTime(dateTimeRaw);
    if (!eventTime) {
      errors.push(`Строка ${rowNum}: некорректное время`);
      continue;
    }

    const direction: 'entry' | 'exit' =
      (doorRaw === '1' || doorRaw.toLowerCase() === 'вход') ? 'entry' : 'exit';

    const dedupHash = computeDedupHash(physicalPerson, eventDate, eventTime, accessPoint, direction);
    if (seenHashes.has(dedupHash)) continue;
    seenHashes.add(dedupHash);

    const employeeId = employeeMap.get(physicalPerson.toLowerCase()) || null;

    eventsToInsert.push({
      organization_id: organizationId,
      physical_person: physicalPerson,
      card_number: cardNumber,
      event_date: eventDate,
      event_time: eventTime,
      access_point: accessPoint,
      direction,
      employee_id: employeeId,
      dedup_hash: dedupHash,
    });

    if (employeeId) {
      summariesToUpdate.add(`${employeeId}:${eventDate}`);
    }
  }

  if (eventsToInsert.length === 0) {
    throw Object.assign(new Error('Нет данных для импорта'), { errors });
  }

  // Вставляем события
  const { error: insertError } = await supabase
    .from('skud_events')
    .upsert(eventsToInsert, { onConflict: 'dedup_hash', ignoreDuplicates: true });

  if (insertError) {
    console.error('Import insert error:', insertError);
    throw new Error('Ошибка сохранения данных');
  }

  // Пересчитываем дневные сводки
  if (summariesToUpdate.size > 0) {
    const pairs = [...summariesToUpdate].map(key => {
      const [empId, date] = key.split(':');
      return { org_id: organizationId, emp_id: parseInt(empId, 10), date };
    });
    await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
  }

  // Аудит (userId нужен как параметр, но logFromRequest ожидает req)
  // Аудит будет вызван в контроллере

  return {
    imported: eventsToInsert.length,
    matched: [...summariesToUpdate].length,
    errors,
  };
}

// ─── Sync employee from Sigur (SSE) ───

/**
 * Синхронизация событий Sigur для конкретного сотрудника.
 * Использует SSE-стрим, поэтому принимает req/res напрямую.
 */
export async function syncEmployee(
  req: AuthenticatedRequest,
  res: Response,
  params: {
    employeeId: number;
    startDate: string;
    endDate: string;
    organizationId: string | undefined;
    connection?: 'external' | 'internal';
  },
): Promise<void> {
  const { employeeId, startDate, endDate, organizationId } = params;

  // 1. Загрузка сотрудника
  let empQuery = supabase
    .from('employees')
    .select('id, organization_id, full_name, sigur_employee_id')
    .eq('id', employeeId)
    .eq('is_archived', false);
  if (organizationId) empQuery = empQuery.eq('organization_id', organizationId);

  const { data: empData, error: empError } = await empQuery.single();
  if (empError || !empData) {
    throw Object.assign(new Error('Сотрудник не найден'), { statusCode: 404 });
  }

  const sigurEmpId: number | null = empData.sigur_employee_id;
  const employeeOrgId: string = empData.organization_id;
  const employeeName = (empData.full_name || '').toLowerCase().trim();

  console.log(`[sync-employee] id=${employeeId}, sigurId=${sigurEmpId}, name="${employeeName}"`);

  // 2. Список дней
  const days = buildInclusiveDateRange(startDate, endDate);

  // 3. SSE-стрим прогресса
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const connection = params.connection;
  const summariesToUpdate = new Set<string>();
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalRaw = 0;

  send({ type: 'start', totalDays: days.length, employeeName });

  // 4. Обработка по дням
  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const day = days[dayIdx];
    const dayStart = `${day}T00:00:00`;
    const dayEnd = `${day}T23:59:59`;

    send({ type: 'day_start', day, dayIndex: dayIdx, totalDays: days.length, percent: Math.round((dayIdx / days.length) * 100) });

    const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
    totalRaw += rawEvents.length;

    if (rawEvents.length === 0) {
      send({ type: 'day_done', day, raw: 0, matched: 0, inserted: 0 });
      continue;
    }

    // Быстрая фильтрация по sigurEmpId
    const filtered = rawEvents.filter(raw => {
      const r = raw as Record<string, unknown>;
      const data = r.data as Record<string, unknown> | undefined;
      const additionalData = r.additionalData as Record<string, unknown> | undefined;
      const accessObject = additionalData?.accessObject as Record<string, unknown> | undefined;
      const accessObjectData = accessObject?.data as Record<string, unknown> | undefined;
      const evtEmpId = data?.employeeId ?? accessObjectData?.id;
      if (sigurEmpId != null && evtEmpId != null) return evtEmpId === sigurEmpId;
      const name = accessObjectData?.name;
      return typeof name === 'string' && name.toLowerCase().trim() === employeeName;
    });

    if (filtered.length === 0) {
      send({ type: 'day_done', day, raw: rawEvents.length, matched: 0, inserted: 0 });
      continue;
    }

    const mapped = filtered
      .map(raw => mapSigurEvent(raw as Record<string, unknown>))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    // Дедупликация
    const { data: existingHashes } = await supabase
      .from('skud_events')
      .select('dedup_hash')
      .eq('event_date', day)
      .eq('organization_id', employeeOrgId)
      .not('dedup_hash', 'is', null);

    const existingSet = new Set<string>();
    for (const evt of existingHashes || []) {
      if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
    }

    const toInsert: ISkudEventRow[] = [];
    for (const m of mapped) {
      const dedupHash = computeDedupHash(
        m.physicalPerson, m.eventDate, m.eventTime,
        m.accessPoint, m.direction,
      );
      if (existingSet.has(dedupHash)) {
        totalSkipped++;
        continue;
      }
      existingSet.add(dedupHash);
      toInsert.push({
        organization_id: employeeOrgId,
        physical_person: m.physicalPerson,
        card_number: m.cardNumber || null,
        event_date: m.eventDate,
        event_time: m.eventTime,
        access_point: m.accessPoint,
        direction: m.direction,
        employee_id: employeeId,
        dedup_hash: dedupHash,
      });
      summariesToUpdate.add(m.eventDate);
    }

    let dayInserted = 0;
    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const { error: insertErr } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
      if (!insertErr) {
        dayInserted += batch.length;
        totalInserted += batch.length;
      }
    }

    send({ type: 'day_done', day, raw: rawEvents.length, matched: filtered.length, inserted: dayInserted });
  }

  // 5. Пересчёт daily summary
  if (summariesToUpdate.size > 0) {
    const pairs = [...summariesToUpdate].map(date => ({
      org_id: employeeOrgId, emp_id: employeeId, date,
    }));
    await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
  }

  // 6. Аудит
  await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR_EMPLOYEE', {
    details: { employeeId, sigurEmpId, startDate, endDate, rawFetched: totalRaw, inserted: totalInserted, skipped: totalSkipped },
  });

  console.log(`[sync-employee] done: raw=${totalRaw}, inserted=${totalInserted}, skipped=${totalSkipped}`);
  send({ type: 'done', inserted: totalInserted, skipped: totalSkipped, total: totalInserted + totalSkipped });
  res.end();
}

// ─── Clean duplicates ───

export async function cleanDuplicates(): Promise<ICleanDuplicatesResult> {
  const BATCH = 1000;
  let offset = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;

  // 1. Бэкфилл: вычисляем dedup_hash для строк без него
  while (true) {
    const { data: rows } = await supabase
      .from('skud_events')
      .select('id, physical_person, event_date, event_time, access_point, direction')
      .is('dedup_hash', null)
      .order('id')
      .range(offset, offset + BATCH - 1);

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const name = row.physical_person || '';
      const hash = computeDedupHash(name, row.event_date, row.event_time, row.access_point, row.direction);
      await supabase.from('skud_events').update({ dedup_hash: hash }).eq('id', row.id);
      totalUpdated++;
    }

    if (rows.length < BATCH) break;
    offset += BATCH;
  }

  // 2. Удаляем дубли
  const { data: dupes } = await supabase.rpc('find_skud_duplicate_ids');
  if (dupes && dupes.length > 0) {
    const idsToDelete: number[] = dupes.map((d: { id: number }) => d.id);
    for (let i = 0; i < idsToDelete.length; i += BATCH) {
      const batch = idsToDelete.slice(i, i + BATCH);
      await supabase.from('skud_events').delete().in('id', batch);
      totalDeleted += batch.length;
    }
  }

  return { hashesUpdated: totalUpdated, duplicatesDeleted: totalDeleted };
}

// ─── Clear data ───

export async function clearData(params: IClearParams): Promise<void> {
  const { organizationId, startDate, endDate } = params;

  let eventsQuery = supabase
    .from('skud_events')
    .delete()
    .eq('organization_id', organizationId);

  let summaryQuery = supabase
    .from('skud_daily_summary')
    .delete()
    .eq('organization_id', organizationId);

  if (startDate) {
    eventsQuery = eventsQuery.gte('event_date', startDate);
    summaryQuery = summaryQuery.gte('date', startDate);
  }
  if (endDate) {
    eventsQuery = eventsQuery.lte('event_date', endDate);
    summaryQuery = summaryQuery.lte('date', endDate);
  }

  await eventsQuery;
  await summaryQuery;
}
