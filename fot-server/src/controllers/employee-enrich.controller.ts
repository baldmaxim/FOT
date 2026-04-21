import { Response } from 'express';
import { readExcelRows } from '../utils/excel-reader.js';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { parseDate } from '../utils/date.utils.js';
import { parseFIO } from '../utils/fio.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface ParsedRow {
  fullName: string;
  tabNumber: string | null;
  country: string | null;
  hireDate: string | null;
  currentStatus: string | null;
  permitExpiryDate: string | null;
  registrationCat1: string | null;
  registrationCat4: string | null;
  docReceiptDate: string | null;
  positionName: string | null;
  workObject: string | null;
  departmentName: string | null;
}

const normalizeFullName = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

const cleanCell = (val: unknown): string | null => {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s === '-' || s === '—') return null;
  return s;
};

/**
 * Определяет, является ли строка заголовком отдела.
 * Отдел: col B (index 1) заполнен, cols C-L (index 2-11) пустые или "-"
 */
const isDeptRow = (row: unknown[]): boolean => {
  const nameVal = cleanCell(row[1]);
  if (!nameVal) return false;
  // Проверяем что остальные ячейки пустые
  for (let i = 2; i <= 11; i++) {
    const v = cleanCell(row[i]);
    if (v) return false;
  }
  return true;
};

/**
 * Парсит Excel-файл формата "Список сотрудников"
 */
async function parseEnrichExcel(buffer: Buffer): Promise<ParsedRow[]> {
  const rows = await readExcelRows(buffer);

  const result: ParsedRow[] = [];
  let currentDepartment: string | null = null;

  // Пропускаем первые 5 строк (заголовок, фильтр, пустая, шапка, нумерация)
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    // Проверяем — строка отдела?
    if (isDeptRow(row)) {
      currentDepartment = cleanCell(row[1]);
      continue;
    }

    // Строка сотрудника — должно быть ФИО в col C (index 2)
    const fullName = cleanCell(row[2]);
    if (!fullName || fullName.length < 3) continue;

    result.push({
      fullName,
      tabNumber: cleanCell(row[1]),
      country: cleanCell(row[3]),
      hireDate: parseDate(cleanCell(row[4])),
      currentStatus: cleanCell(row[5]),
      permitExpiryDate: cleanCell(row[6]),
      registrationCat1: cleanCell(row[7]),
      registrationCat4: cleanCell(row[8]),
      docReceiptDate: cleanCell(row[9]),
      positionName: cleanCell(row[10]),
      workObject: cleanCell(row[11]),
      departmentName: currentDepartment,
    });
  }

  return result;
}

export const employeeEnrichController = {
  async enrich(req: MulterRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const preview = req.query.preview !== 'false';
      const parsedRows = await parseEnrichExcel(req.file.buffer);

      console.log('[enrich] Parsed rows:', parsedRows.length);
      if (parsedRows.length > 0) {
        console.log('[enrich] First 3 rows:', parsedRows.slice(0, 3).map(r => ({ fullName: r.fullName, dept: r.departmentName })));
      }

      if (parsedRows.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных в файле' });
        return;
      }

      // Загружаем всех сотрудников (пагинация для >1000)
      const dbEmployees: Array<{ id: number; full_name: string; [k: string]: unknown }> = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        const { data, error: empError } = await supabase
          .from('employees')
          .select('id, full_name, country, hire_date, position_id, org_department_id, tab_number, current_status, permit_expiry_date, registration_cat1, registration_cat4, doc_receipt_date, work_object')
          .eq('is_archived', false)
          .range(from, from + PAGE_SIZE - 1);

        if (empError) {
          console.error('Enrich: load employees error:', empError);
          res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
          return;
        }

        if (!data || data.length === 0) break;
        dbEmployees.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      console.log('[enrich] DB employees loaded:', dbEmployees?.length);

      // Строим Map по нормализованному имени
      const nameToEmp = new Map<string, { id: number; count: number; data: Record<string, unknown> }>();
      for (const emp of (dbEmployees || [])) {
        const key = normalizeFullName(emp.full_name);
        const existing = nameToEmp.get(key);
        if (existing) {
          existing.count++;
        } else {
          nameToEmp.set(key, { id: emp.id, count: 1, data: emp });
        }
      }

      // Загружаем позиции для маппинга
      const { data: positions } = await supabase
        .from('positions')
        .select('id, name')
        .eq('is_active', true);

      const posNameToId = new Map<string, string>();
      for (const p of (positions || [])) {
        if (p.name) posNameToId.set(p.name.toLowerCase(), p.id);
      }

      // Результаты
      const matched: Array<{ id: number; fullName: string; updates: Record<string, { old: string | null; new: string | null }> }> = [];
      const unmatched: Array<{ fullName: string; department: string | null }> = [];
      const ambiguous: Array<{ fullName: string; count: number }> = [];
      const errors: string[] = [];

      // Собираем новые позиции для batch-создания
      const newPositions = new Set<string>();

      for (const row of parsedRows) {
        const key = normalizeFullName(row.fullName);
        const match = nameToEmp.get(key);

        if (!match) {
          unmatched.push({ fullName: row.fullName, department: row.departmentName });
          continue;
        }

        if (match.count > 1) {
          ambiguous.push({ fullName: row.fullName, count: match.count });
          continue;
        }

        // Ищем position_id
        let positionId: string | null = null;
        if (row.positionName) {
          positionId = posNameToId.get(row.positionName.toLowerCase()) || null;
          if (!positionId) {
            newPositions.add(row.positionName);
          }
        }

        // Вычисляем diff
        const updates: Record<string, { old: string | null; new: string | null }> = {};
        const existing = match.data as Record<string, unknown>;

        const addUpdate = (field: string, dbField: string, newVal: string | null) => {
          if (newVal && String(existing[dbField] || '') !== newVal) {
            updates[field] = { old: (existing[dbField] as string) || null, new: newVal };
          }
        };

        addUpdate('Таб. №', 'tab_number', row.tabNumber);
        addUpdate('Гражданство', 'country', row.country);
        addUpdate('Дата приема', 'hire_date', row.hireDate);
        addUpdate('Текущее состояние', 'current_status', row.currentStatus);
        addUpdate('Срок разрешения', 'permit_expiry_date', row.permitExpiryDate);
        addUpdate('Регистрация 1 кат', 'registration_cat1', row.registrationCat1);
        addUpdate('Регистрация 4 кат', 'registration_cat4', row.registrationCat4);
        addUpdate('Дата документов', 'doc_receipt_date', row.docReceiptDate);
        addUpdate('Объект', 'work_object', row.workObject);

        if (positionId && positionId !== existing.position_id) {
          updates['Должность'] = { old: (existing.position_id as string) || null, new: row.positionName };
        } else if (row.positionName && !positionId && newPositions.has(row.positionName)) {
          updates['Должность'] = { old: null, new: row.positionName + ' (новая)' };
        }

        if (Object.keys(updates).length > 0) {
          matched.push({ id: match.id, fullName: row.fullName, updates });
        }
      }

      const stats = {
        total: parsedRows.length,
        matched: matched.length,
        unmatched: unmatched.length,
        ambiguous: ambiguous.length,
      };

      // Режим превью — возвращаем результат без записи
      if (preview) {
        res.json({ success: true, data: { matched, unmatched, ambiguous, stats } });
        return;
      }

      // === Режим применения ===

      // 0. Ручные сопоставления (из UI)
      const manualMatches: Array<{ fullName: string; employeeId: number }> = [];
      try {
        const raw = req.body?.manualMatches;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) manualMatches.push(...parsed);
        }
      } catch { /* ignore parse errors */ }

      const manualMap = new Map<string, number>();
      const dbById = new Map<number, Record<string, unknown>>();
      for (const m of manualMatches) {
        manualMap.set(normalizeFullName(m.fullName), m.employeeId);
      }
      if (manualMap.size > 0) {
        for (const emp of dbEmployees) {
          dbById.set(emp.id, emp);
        }
      }

      // 1. Создаём недостающие позиции
      if (newPositions.size > 0) {
        const posInserts = Array.from(newPositions).map(name => ({
          name,
          is_active: true,
          sort_order: 0,
        }));

        const { data: createdPos } = await supabase
          .from('positions')
          .upsert(posInserts, { onConflict: 'name', ignoreDuplicates: true })
          .select('id, name');

        for (const p of (createdPos || [])) {
          posNameToId.set(p.name.toLowerCase(), p.id);
        }
      }

      // 2. Обновляем сотрудников
      let updated = 0;

      for (const row of parsedRows) {
        const key = normalizeFullName(row.fullName);
        let match = nameToEmp.get(key);

        // Ручное сопоставление — если автоматически не нашли
        if ((!match || match.count > 1) && manualMap.has(key)) {
          const manualId = manualMap.get(key)!;
          const manualData = dbById.get(manualId);
          if (manualData) {
            match = { id: manualId, count: 1, data: manualData };
          }
        }

        if (!match || match.count > 1) continue;

        const updateData: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        if (row.tabNumber) updateData.tab_number = row.tabNumber;
        if (row.country) updateData.country = row.country;
        if (row.hireDate) updateData.hire_date = row.hireDate;
        if (row.currentStatus) updateData.current_status = row.currentStatus;
        if (row.permitExpiryDate) updateData.permit_expiry_date = row.permitExpiryDate;
        if (row.registrationCat1) updateData.registration_cat1 = row.registrationCat1;
        if (row.registrationCat4) updateData.registration_cat4 = row.registrationCat4;
        if (row.docReceiptDate) updateData.doc_receipt_date = row.docReceiptDate;
        if (row.workObject) updateData.work_object = row.workObject;

        // ФИО компоненты
        const fio = parseFIO(row.fullName);
        updateData.last_name = fio.lastName;
        updateData.first_name = fio.firstName || null;
        updateData.middle_name = fio.middleName || null;

        // Позиция
        if (row.positionName) {
          const pid = posNameToId.get(row.positionName.toLowerCase());
          if (pid) updateData.position_id = pid;
        }

        // Проверяем есть ли реальные обновления (кроме updated_at и FIO)
        if (Object.keys(updateData).length <= 4) continue; // updated_at + last/first/middle

        const { error: updateError } = await supabase
          .from('employees')
          .update(updateData)
          .eq('id', match.id);

        if (updateError) {
          errors.push(`${row.fullName}: ${updateError.message}`);
        } else {
          updated++;
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'ENRICH_EMPLOYEES', {
        details: { updated, errors: errors.length, total: parsedRows.length },
      });

      res.json({ success: true, data: { updated, errors, stats } });
    } catch (error) {
      console.error('Enrich employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка обогащения данных' });
    }
  },
};
