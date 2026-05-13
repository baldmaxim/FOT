import { Response } from 'express';
import { readExcelRows } from '../utils/excel-reader.js';
import { execute, query, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { cleanCell } from '../utils/import-cells.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface ParsedSalaryEntry {
  changeType: string; // "Текущий оклад", "Изменение оклада", "Оклад при приеме на работу"
  effectiveDate: string; // YYYY-MM-DD
  salary: number;
}

interface ParsedEmployee {
  shortName: string; // "Артамонов М.А."
  lastName: string;
  initial1: string; // "М"
  initial2: string | null; // "А"
  departmentName: string | null;
  positionName: string | null;
  salaryHistory: ParsedSalaryEntry[];
}

const MONTHS: Record<string, string> = {
  'январь': '01', 'февраль': '02', 'март': '03', 'апрель': '04',
  'май': '05', 'июнь': '06', 'июль': '07', 'август': '08',
  'сентябрь': '09', 'октябрь': '10', 'ноябрь': '11', 'декабрь': '12',
};

/**
 * Парсит "Август 2025" → "2025-08-01"
 */
const parseMonthYear = (text: string): string | null => {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const monthNum = MONTHS[parts[0].toLowerCase()];
  const year = parts[1];
  if (!monthNum || !/^\d{4}$/.test(year)) return null;
  return `${year}-${monthNum}-01`;
};

/**
 * Парсит строку оклада: "Текущий оклад с: Август 2025 = 175 000,00"
 */
const parseSalaryLine = (text: string): ParsedSalaryEntry | null => {
  const match = text.match(/^(.+?)\s+с:\s+(.+?)\s*=\s*([\d\s]+[,.]?\d*)$/);
  if (!match) return null;

  const changeType = match[1].trim();
  const effectiveDate = parseMonthYear(match[2].trim());
  if (!effectiveDate) return null;

  const salaryStr = match[3].replace(/\s/g, '').replace(',', '.');
  const salary = parseFloat(salaryStr);
  if (isNaN(salary)) return null;

  return { changeType, effectiveDate, salary };
};

/**
 * Проверяет, является ли строка ФИО в формате "Фамилия И.О." или "Фамилия И."
 */
const isShortName = (text: string): boolean =>
  /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]?\.?\s*$/.test(text);

/**
 * Парсит сокращённое ФИО: "Артамонов М.А." → { lastName, initial1, initial2 }
 */
const parseShortName = (text: string): { lastName: string; initial1: string; initial2: string | null } | null => {
  const cleaned = text.trim();
  const match = cleaned.match(/^([А-ЯЁа-яё]+)\s+([А-ЯЁ])\.?\s*([А-ЯЁ])?\.?\s*$/);
  if (!match) return null;
  return {
    lastName: match[1],
    initial1: match[2],
    initial2: match[3] || null,
  };
};

/**
 * Парсит Excel-файл формата "История окладов"
 * Данные с 9-й строки (index 8), только столбец B (index 1)
 */
async function parseSalaryHistoryExcel(buffer: Buffer): Promise<ParsedEmployee[]> {
  const rows = await readExcelRows(buffer);

  const result: ParsedEmployee[] = [];
  let currentDepartment: string | null = null;
  let currentPosition: string | null = null;
  let currentEmployee: ParsedEmployee | null = null;

  for (let i = 8; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const cellB = cleanCell(row[1]);
    if (!cellB) continue;

    // Проверяем — это строка оклада?
    const salaryEntry = parseSalaryLine(cellB);
    if (salaryEntry && currentEmployee) {
      currentEmployee.salaryHistory.push(salaryEntry);
      continue;
    }

    // Проверяем — это ФИО сотрудника?
    if (isShortName(cellB)) {
      const parsed = parseShortName(cellB);
      if (parsed) {
        // Сохраняем предыдущего сотрудника
        if (currentEmployee && currentEmployee.salaryHistory.length > 0) {
          result.push(currentEmployee);
        }
        currentEmployee = {
          shortName: cellB,
          lastName: parsed.lastName,
          initial1: parsed.initial1,
          initial2: parsed.initial2,
          departmentName: currentDepartment,
          positionName: currentPosition,
          salaryHistory: [],
        };
        continue;
      }
    }

    // Проверяем — есть ли дата приёма в col C (значит это сотрудник с полным или коротким именем)
    const cellC = cleanCell(row[2]);
    if (cellC && /\d/.test(cellC)) {
      // Строка с данными в col C — может быть сотрудник
      const parsed = parseShortName(cellB);
      if (parsed) {
        if (currentEmployee && currentEmployee.salaryHistory.length > 0) {
          result.push(currentEmployee);
        }
        currentEmployee = {
          shortName: cellB,
          lastName: parsed.lastName,
          initial1: parsed.initial1,
          initial2: parsed.initial2,
          departmentName: currentDepartment,
          positionName: currentPosition,
          salaryHistory: [],
        };
        continue;
      }
    }

    // Иначе — заголовок раздела (отдел или должность)
    // Определяем по col A: целое число = отдел, с точкой = должность
    const cellA = cleanCell(row[0]);
    if (cellA && /^\d+$/.test(cellA)) {
      // Сохраняем текущего сотрудника перед сменой отдела
      if (currentEmployee && currentEmployee.salaryHistory.length > 0) {
        result.push(currentEmployee);
        currentEmployee = null;
      }
      currentDepartment = cellB;
      currentPosition = null;
    } else if (cellA && /^\d+\.\d+$/.test(cellA)) {
      if (currentEmployee && currentEmployee.salaryHistory.length > 0) {
        result.push(currentEmployee);
        currentEmployee = null;
      }
      currentPosition = cellB;
    }
    // Если col A пустой и cellB не оклад и не ФИО — игнорируем
  }

  // Последний сотрудник
  if (currentEmployee && currentEmployee.salaryHistory.length > 0) {
    result.push(currentEmployee);
  }

  return result;
}

export const employeeSalaryHistoryController = {
  async enrichSalaryHistory(req: MulterRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const preview = req.query.preview !== 'false';
      const parsedEmployees = await parseSalaryHistoryExcel(req.file.buffer);

      console.log('[enrich-salary-history] Parsed employees:', parsedEmployees.length);

      if (parsedEmployees.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных в файле' });
        return;
      }

      // Загружаем сотрудников с ФИО компонентами
      const dbEmployees: Array<{ id: number; full_name: string; last_name: string | null; first_name: string | null; middle_name: string | null }> = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        let data: Array<{ id: number; full_name: string; last_name: string | null; first_name: string | null; middle_name: string | null }>;
        try {
          data = await query<{ id: number; full_name: string; last_name: string | null; first_name: string | null; middle_name: string | null }>(
            `SELECT id, full_name, last_name, first_name, middle_name
               FROM employees
              WHERE is_archived = false
              ORDER BY id
              LIMIT $1 OFFSET $2`,
            [PAGE_SIZE, from],
          );
        } catch {
          res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
          return;
        }

        if (data.length === 0) break;
        dbEmployees.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      // Матчинг по фамилии + инициалам
      const matched: Array<{
        id: number;
        fullName: string;
        updates: Record<string, { old: string | null; new: string | null }>;
        _salaryHistory: ParsedSalaryEntry[];
      }> = [];
      const unmatched: Array<{ fullName: string; department: string | null }> = [];
      const ambiguous: Array<{ fullName: string; count: number }> = [];

      for (const emp of parsedEmployees) {
        const candidates = dbEmployees.filter(db => {
          if (!db.last_name) return false;
          if (db.last_name.toLowerCase() !== emp.lastName.toLowerCase()) return false;
          if (!db.first_name || db.first_name[0].toUpperCase() !== emp.initial1.toUpperCase()) return false;
          if (emp.initial2 && db.middle_name) {
            if (db.middle_name[0].toUpperCase() !== emp.initial2.toUpperCase()) return false;
          }
          return true;
        });

        if (candidates.length === 0) {
          unmatched.push({ fullName: emp.shortName, department: emp.departmentName });
        } else if (candidates.length > 1) {
          ambiguous.push({ fullName: emp.shortName, count: candidates.length });
        } else {
          const db = candidates[0];
          const updates: Record<string, { old: string | null; new: string | null }> = {};
          const sortedHistory = [...emp.salaryHistory].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

          updates['Записей в истории'] = { old: null, new: String(sortedHistory.length) };

          const latest = sortedHistory[sortedHistory.length - 1];
          if (latest) {
            updates['Текущий оклад'] = { old: null, new: `${latest.salary.toLocaleString('ru-RU')} ₽ с ${latest.effectiveDate}` };
          }

          const earliest = sortedHistory[0];
          if (earliest && sortedHistory.length > 1) {
            updates['Первый оклад'] = { old: null, new: `${earliest.salary.toLocaleString('ru-RU')} ₽ с ${earliest.effectiveDate}` };
          }

          matched.push({
            id: db.id,
            fullName: `${db.full_name} (${emp.shortName})`,
            updates,
            _salaryHistory: sortedHistory,
          });
        }
      }

      const stats = {
        total: parsedEmployees.length,
        matched: matched.length,
        unmatched: unmatched.length,
        ambiguous: ambiguous.length,
      };

      if (preview) {
        const previewMatched = matched.map(({ _salaryHistory: _, ...rest }) => rest);
        res.json({ success: true, data: { matched: previewMatched, unmatched, ambiguous, stats } });
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

      // Для manual matches — нужно повторно собрать историю
      const manualMap = new Map<string, number>();
      for (const m of manualMatches) {
        manualMap.set(m.fullName.toLowerCase(), m.employeeId);
      }

      let updated = 0;
      const errors: string[] = [];

      for (const m of matched) {
        const history = m._salaryHistory;
        if (history.length === 0) continue;

        // Вставляем записи в salary_history (VIEW employee_history подхватит автоматически)
        try {
          await withTransaction(async (client) => {
            for (const entry of history) {
              await client.query(
                `INSERT INTO salary_history (employee_id, salary, effective_date, change_reason, note, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6::uuid)`,
                [m.id, entry.salary, entry.effectiveDate, entry.changeType, 'Импорт из Excel', req.user.id],
              );
            }
          });
        } catch (insertError) {
          const msg = insertError instanceof Error ? insertError.message : String(insertError);
          console.error('[enrich-salary-history] Insert error:', m.fullName, msg);
          errors.push(`${m.fullName}: ${msg}`);
          continue;
        }

        // Обновляем текущий оклад (последний = самый свежий)
        const latest = history[history.length - 1];
        if (latest) {
          try {
            await execute(
              `UPDATE employees
                  SET salary_actual = $1, current_salary = $2, updated_at = $3
                WHERE id = $4`,
              [latest.salary, latest.salary, new Date().toISOString(), m.id],
            );
          } catch {
            // ignore — основная вставка истории прошла, продолжаем
          }
        }

        updated++;
      }

      await auditService.logFromRequest(req, req.user.id, 'ENRICH_SALARY_HISTORY', {
        details: { updated, errors: errors.length, total: parsedEmployees.length, totalEntries: matched.reduce((s, m) => s + m._salaryHistory.length, 0) },
      });

      res.json({ success: true, data: { updated, errors, stats } });
    } catch (error) {
      console.error('Enrich salary history error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта истории окладов' });
    }
  },
};
