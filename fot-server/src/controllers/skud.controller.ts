import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { parseDate, formatDateToISO } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface SkudEventRow {
  organization_id: string;
  physical_person_encrypted: string;
  card_number_encrypted: string | null;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
  employee_id: number | null;
}

interface DailySummaryRow {
  id: number;
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
}

export const skudController = {
  /**
   * GET /api/skud/daily-summary
   * Получение дневных сводок за месяц
   */
  async getDailySummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { date } = req.query; // YYYY-MM-DD (первый день месяца)

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      if (!date || typeof date !== 'string') {
        res.status(400).json({ success: false, error: 'Date parameter required' });
        return;
      }

      // Вычисляем диапазон месяца
      const startDate = new Date(date);
      const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0);

      const startStr = formatDateToISO(startDate);
      const endStr = formatDateToISO(endDate);

      const { data, error } = await supabase
        .from('skud_daily_summary')
        .select('*')
        .eq('organization_id', organizationId)
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date');

      if (error) {
        console.error('Get daily summary error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
        return;
      }

      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('Get daily summary error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch daily summary' });
    }
  },

  /**
   * GET /api/skud/events
   * Получение событий СКУД с фильтрами
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { startDate, endDate, accessPoint, employeeId } = req.query;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      let query = supabase
        .from('skud_events')
        .select('*')
        .eq('organization_id', organizationId)
        .order('event_date', { ascending: false })
        .order('event_time', { ascending: false })
        .limit(1000);

      if (startDate && typeof startDate === 'string') {
        query = query.gte('event_date', startDate);
      }
      if (endDate && typeof endDate === 'string') {
        query = query.lte('event_date', endDate);
      }
      if (accessPoint && typeof accessPoint === 'string') {
        query = query.eq('access_point', accessPoint);
      }
      if (employeeId && typeof employeeId === 'string') {
        query = query.eq('employee_id', parseInt(employeeId, 10));
      }

      const { data, error } = await query;

      if (error) {
        console.error('Get events error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch events' });
        return;
      }

      // Расшифровываем данные
      const decrypted = (data || []).map((event: {
        id: number;
        physical_person_encrypted: string;
        card_number_encrypted: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: string | null;
        employee_id: number | null;
      }) => ({
        id: event.id,
        physical_person: encryptionService.decrypt(event.physical_person_encrypted),
        card_number: event.card_number_encrypted
          ? encryptionService.decrypt(event.card_number_encrypted)
          : null,
        event_date: event.event_date,
        event_time: event.event_time,
        access_point: event.access_point,
        direction: event.direction,
        employee_id: event.employee_id,
      }));

      res.json({ success: true, data: decrypted });
    } catch (error) {
      console.error('Get events error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch events' });
    }
  },

  /**
   * GET /api/skud/access-points
   * Получение списка точек доступа
   */
  async getAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const { data, error } = await supabase
        .from('skud_events')
        .select('access_point')
        .eq('organization_id', organizationId)
        .not('access_point', 'is', null);

      if (error) {
        console.error('Get access points error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch access points' });
        return;
      }

      // Уникальные точки доступа
      const unique = [...new Set((data || []).map((d: { access_point: string }) => d.access_point))];

      res.json({ success: true, data: unique });
    } catch (error) {
      console.error('Get access points error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch access points' });
    }
  },

  /**
   * POST /api/skud/import
   * Импорт событий СКУД из Excel
   * Формат колонок:
   * 0 - Сотрудник (ФИО)
   * 1 - пропускаем
   * 2 - Подразделение (пропускаем)
   * 3 - Дата
   * 4 - Дата и Время (извлекаем время)
   * 5 - Помещение (пропускаем)
   * 6 - Карта
   * 7 - Контроллер (точка доступа)
   * 8 - Дверь (1 = вход, иначе = выход)
   * 9 - пропускаем
   */
  async import(req: MulterRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      // Загружаем сотрудников для сопоставления по ФИО
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, full_name_encrypted')
        .eq('organization_id', organizationId)
        .eq('is_archived', false);

      const employeeMap = new Map<string, number>();
      for (const emp of employeesData || []) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
        employeeMap.set(name, emp.id);
      }

      // Парсим Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        dateNF: 'yyyy-mm-dd',
      });

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'Файл пуст' });
        return;
      }

      // Пропускаем заголовок
      const startRow = isHeaderRow(rows[0]) ? 1 : 0;
      const dataRows = rows.slice(startRow);

      const errors: string[] = [];
      const eventsToInsert: SkudEventRow[] = [];
      const summariesToUpdate = new Set<string>(); // employee_id:date

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNum = startRow + i + 1;

        if (!row || row.length === 0 || !row[0]) continue;

        // Парсинг колонок по новому формату
        const physicalPerson = String(row[0] || '').trim();        // Сотрудник (ФИО)
        const dateRaw = row[3];                                      // Дата
        const dateTimeRaw = row[4];                                  // Дата и Время
        const cardNumber = String(row[6] || '').trim() || null;      // Карта
        const accessPoint = String(row[7] || '').trim() || null;     // Контроллер
        const doorRaw = String(row[8] || '').trim();                 // Дверь (1 = вход)

        if (!physicalPerson) {
          errors.push(`Строка ${rowNum}: отсутствует ФИО`);
          continue;
        }

        // Парсим дату из колонки 3
        const eventDate = parseDate(dateRaw);
        if (!eventDate) {
          errors.push(`Строка ${rowNum}: некорректная дата`);
          continue;
        }

        // Парсим время из колонки 4 (Дата и Время)
        const eventTime = parseTimeFromDateTime(dateTimeRaw);
        if (!eventTime) {
          errors.push(`Строка ${rowNum}: некорректное время`);
          continue;
        }

        // Определяем направление: 1 = вход, иначе = выход
        const direction: 'entry' | 'exit' =
          (doorRaw === '1' || doorRaw.toLowerCase() === 'вход') ? 'entry' : 'exit';

        // Сопоставляем с сотрудником
        const employeeId = employeeMap.get(physicalPerson.toLowerCase()) || null;

        eventsToInsert.push({
          organization_id: organizationId,
          physical_person_encrypted: encryptionService.encrypt(physicalPerson),
          card_number_encrypted: cardNumber ? encryptionService.encrypt(cardNumber) : null,
          event_date: eventDate,
          event_time: eventTime,
          access_point: accessPoint,
          direction,
          employee_id: employeeId,
        });

        // Отмечаем для пересчёта сводки
        if (employeeId) {
          summariesToUpdate.add(`${employeeId}:${eventDate}`);
        }
      }

      if (eventsToInsert.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Нет данных для импорта',
          errors,
        });
        return;
      }

      // Вставляем события
      const { error: insertError } = await supabase
        .from('skud_events')
        .insert(eventsToInsert);

      if (insertError) {
        console.error('Import insert error:', insertError);
        res.status(500).json({ success: false, error: 'Ошибка сохранения данных' });
        return;
      }

      // Пересчитываем дневные сводки
      for (const key of summariesToUpdate) {
        const [empId, date] = key.split(':');
        await supabase.rpc('recalculate_skud_daily_summary', {
          p_organization_id: organizationId,
          p_employee_id: parseInt(empId, 10),
          p_date: date,
        });
      }

      await auditService.logFromRequest(req, req.user.id, 'IMPORT_SKUD', {
        details: {
          imported: eventsToInsert.length,
          errors: errors.length,
          matched_employees: [...summariesToUpdate].length,
        },
      });

      res.json({
        success: true,
        data: {
          imported: eventsToInsert.length,
          matched: [...summariesToUpdate].length,
          errors,
        },
      });
    } catch (error) {
      console.error('Import SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта' });
    }
  },

  /**
   * DELETE /api/skud/clear
   * Очистка данных СКУД за период
   */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { startDate, endDate } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

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

      await auditService.logFromRequest(req, req.user.id, 'CLEAR_SKUD', {
        details: { startDate, endDate },
      });

      res.json({ success: true, message: 'Данные очищены' });
    } catch (error) {
      console.error('Clear SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки данных' });
    }
  },
};

// Вспомогательные функции

function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  if (!row || row.length === 0) return false;
  const firstCell = String(row[0] || '').toLowerCase();
  return (
    firstCell.includes('фио') ||
    firstCell.includes('имя') ||
    firstCell.includes('person') ||
    firstCell.includes('физ') ||
    firstCell.includes('сотрудник') ||
    firstCell === '№'
  );
}

// Извлекает время из строки "Дата и Время" (например: "27.01.2026 09:30:00" или "2026-01-27 09:30")
function parseTimeFromDateTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  // Ищем время в формате HH:MM или HH:MM:SS
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Excel десятичное время
  if (!isNaN(Number(str))) {
    const num = Number(str);
    // Если это дробная часть дня (время)
    const timePart = num % 1;
    if (timePart > 0) {
      const totalMinutes = Math.round(timePart * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}

function parseTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  // HH:MM или HH:MM:SS
  const timeMatch = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Excel десятичное время (0.5 = 12:00)
  if (!isNaN(Number(str))) {
    const num = Number(str);
    if (num >= 0 && num < 1) {
      const totalMinutes = Math.round(num * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}
