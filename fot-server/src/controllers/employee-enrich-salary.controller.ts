import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import { parseDate } from '../utils/date.utils.js';
import { parseFIO } from '../utils/fio.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface ParsedSalaryRow {
  fullName: string;
  hireDate: string | null;
  departmentName: string | null;
  positionName: string | null;
  salaryCalculated: number | null;
  staffUnits: number | null;
  salaryActual: number | null;
}

const normalizeFullName = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

const cleanCell = (val: unknown): string | null => {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s === '-' || s === '—') return null;
  return s;
};

const parseNumber = (val: unknown): number | null => {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  let s = String(val).trim();
  if (!s || s === '-' || s === '—') return null;
  // Убираем пробелы (включая неразрывные)
  s = s.replace(/[\s\u00A0\u202F]/g, '');
  // Определяем формат: "110,000.00" (EN) или "110 000,00" (RU)
  if (s.includes('.') && s.includes(',')) {
    // Оба разделителя — последний является десятичным
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > lastComma) {
      // EN: 110,000.00 → убираем запятые
      s = s.replace(/,/g, '');
    } else {
      // RU: 110.000,00 → убираем точки, запятая→точка
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (s.includes(',')) {
    // Только запятая — десятичный разделитель (RU) или тысячный (EN)
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      s = s.replace(',', '.'); // "130,50" → десятичный
    } else {
      s = s.replace(/,/g, ''); // "130,000" → тысячный
    }
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};

/**
 * Парсит Excel-файл формата "Оклады и ставки"
 * Данные с 5-й строки (index 4), ФИО со 2-го столбца (index 1)
 */
function parseSalaryExcel(buffer: Buffer): ParsedSalaryRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

  const result: ParsedSalaryRow[] = [];

  for (let i = 4; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const fullName = cleanCell(row[1]);
    if (!fullName || fullName.length < 3) continue;

    // Логируем первые 3 строки для отладки
    if (i < 7) {
      console.log(`[enrich-salary] row ${i}: col5='${row[5]}' (${typeof row[5]}), col6='${row[6]}' (${typeof row[6]}), col7='${row[7]}' (${typeof row[7]})`);
    }

    const salaryCalculated = parseNumber(row[5]);
    const staffUnits = parseNumber(row[6]);
    const salaryActual = parseNumber(row[7]);

    // Пропускаем строки без данных об окладах
    if (salaryCalculated === null && staffUnits === null && salaryActual === null) continue;

    result.push({
      fullName,
      hireDate: parseDate(cleanCell(row[2])),
      departmentName: cleanCell(row[3]),
      positionName: cleanCell(row[4]),
      salaryCalculated,
      staffUnits,
      salaryActual,
    });
  }

  return result;
}

export const employeeSalaryEnrichController = {
  async enrichSalary(req: MulterRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const preview = req.query.preview !== 'false';
      const parsedRows = parseSalaryExcel(req.file.buffer);

      console.log('[enrich-salary] Parsed rows:', parsedRows.length);

      if (parsedRows.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных в файле' });
        return;
      }

      // Загружаем всех сотрудников
      const dbEmployees: Array<{ id: number; full_name: string; [k: string]: unknown }> = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        const { data, error: empError } = await supabase
          .from('employees')
          .select('id, full_name, hire_date, position_id, org_department_id, salary_actual, salary_calculated, staff_units, current_salary')
          .eq('is_archived', false)
          .range(from, from + PAGE_SIZE - 1);

        if (empError) {
          console.error('Enrich-salary: load employees error:', empError);
          res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
          return;
        }

        if (!data || data.length === 0) break;
        dbEmployees.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      // Map по нормализованному имени
      const nameToEmp = new Map<string, { id: number; count: number; data: Record<string, unknown> }>();
      for (const emp of dbEmployees) {
        const key = normalizeFullName(emp.full_name);
        const existing = nameToEmp.get(key);
        if (existing) {
          existing.count++;
        } else {
          nameToEmp.set(key, { id: emp.id, count: 1, data: emp });
        }
      }

      // Загружаем позиции
      const { data: positions } = await supabase
        .from('positions')
        .select('id, name')
        .eq('is_active', true);

      const posNameToId = new Map<string, string>();
      for (const p of (positions || [])) {
        if (p.name) posNameToId.set(p.name.toLowerCase(), p.id);
      }

      const matched: Array<{ id: number; fullName: string; updates: Record<string, { old: string | null; new: string | null }> }> = [];
      const unmatched: Array<{ fullName: string; department: string | null }> = [];
      const ambiguous: Array<{ fullName: string; count: number }> = [];
      const errors: string[] = [];
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
          if (!positionId) newPositions.add(row.positionName);
        }

        // Diff
        const updates: Record<string, { old: string | null; new: string | null }> = {};
        const existing = match.data as Record<string, unknown>;

        const fmtNum = (v: number | null) => v !== null ? String(v) : null;

        if (row.salaryActual !== null && String(existing.salary_actual || '') !== String(row.salaryActual)) {
          updates['Оклад (договор)'] = { old: fmtNum(existing.salary_actual as number | null), new: fmtNum(row.salaryActual) };
        }
        if (row.salaryCalculated !== null && String(existing.salary_calculated || '') !== String(row.salaryCalculated)) {
          updates['Оклад (программа)'] = { old: fmtNum(existing.salary_calculated as number | null), new: fmtNum(row.salaryCalculated) };
        }
        if (row.staffUnits !== null && String(existing.staff_units || '') !== String(row.staffUnits)) {
          updates['Ставка'] = { old: fmtNum(existing.staff_units as number | null), new: fmtNum(row.staffUnits) };
        }
        if (row.hireDate && String(existing.hire_date || '') !== row.hireDate) {
          updates['Дата приема'] = { old: (existing.hire_date as string) || null, new: row.hireDate };
        }
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

      if (preview) {
        res.json({ success: true, data: { matched, unmatched, ambiguous, stats } });
        return;
      }

      // === Режим применения ===

      // Ручные сопоставления
      const manualMatches: Array<{ fullName: string; employeeId: number }> = [];
      try {
        const raw = req.body?.manualMatches;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) manualMatches.push(...parsed);
        }
      } catch { /* ignore */ }

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

      // Создаём недостающие позиции
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

      // Обновляем сотрудников
      let updated = 0;

      for (const row of parsedRows) {
        const key = normalizeFullName(row.fullName);
        let match = nameToEmp.get(key);

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

        if (row.salaryCalculated !== null) updateData.salary_calculated = row.salaryCalculated;
        if (row.staffUnits !== null) updateData.staff_units = row.staffUnits;
        if (row.hireDate) updateData.hire_date = row.hireDate;

        // ФИО компоненты
        const fio = parseFIO(row.fullName);
        updateData.last_name = fio.lastName;
        updateData.first_name = fio.firstName || null;
        updateData.middle_name = fio.middleName || null;

        // Проверяем есть ли реальные обновления (кроме meta-полей)
        const hasRealUpdates = Object.keys(updateData).some(k =>
          !['updated_at', 'last_name', 'first_name', 'middle_name'].includes(k)
        );
        if (!hasRealUpdates && !row.salaryActual && !row.positionName) continue;

        try {
          // Оклад → через сервис (пишет salary_history)
          if (row.salaryActual !== null) {
            const existing = match.data as Record<string, unknown>;
            if (Number(existing.salary_actual || 0) !== row.salaryActual) {
              await employeeChangesService.changeSalary(match.id, row.salaryActual, {
                reason: 'Импорт из Excel',
                createdBy: req.user.id,
              });
            }
          }

          // Позиция → через сервис (пишет employee_assignments)
          if (row.positionName) {
            const pid = posNameToId.get(row.positionName.toLowerCase());
            if (pid) {
              const existing = match.data as Record<string, unknown>;
              if (existing.position_id !== pid) {
                await employeeChangesService.changePosition(match.id, pid, {
                  reason: 'Импорт из Excel',
                  createdBy: req.user.id,
                });
              }
            }
          }

          // Остальные поля — прямое обновление
          if (Object.keys(updateData).length > 1) {
            await supabase
              .from('employees')
              .update(updateData)
              .eq('id', match.id);
          }

          updated++;
        } catch (err) {
          errors.push(`${row.fullName}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'ENRICH_SALARY', {
        details: { updated, errors: errors.length, total: parsedRows.length },
      });

      res.json({ success: true, data: { updated, errors, stats } });
    } catch (error) {
      console.error('Enrich salary error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта окладов' });
    }
  },
};
