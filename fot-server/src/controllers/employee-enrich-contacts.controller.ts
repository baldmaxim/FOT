import { Response } from 'express';
import { readExcelRows } from '../utils/excel-reader.js';
import { execute, query } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { normalizeFullName } from '../utils/fio.utils.js';
import { cleanCell } from '../utils/import-cells.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface ParsedRow {
  fullName: string;
  email: string;
  departmentName: string | null;
}

async function parseContactsExcel(buffer: Buffer): Promise<ParsedRow[]> {
  const rows = await readExcelRows(buffer);
  const result: ParsedRow[] = [];

  // Row 0 = header, data starts at index 1
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const fullName = cleanCell(row[0]);
    if (!fullName || fullName.length < 3) continue;

    const email = cleanCell(row[1]);
    if (!email) continue;

    result.push({
      fullName,
      email,
      departmentName: cleanCell(row[2]),
    });
  }

  return result;
}

export const employeeEnrichContactsController = {
  async enrichContacts(req: MulterRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const preview = req.query.preview !== 'false';
      const parsedRows = await parseContactsExcel(req.file.buffer);

      if (parsedRows.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных в файле' });
        return;
      }

      // Load all employees
      const dbEmployees: Array<{ id: number; full_name: string; email: string | null }> = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        let data: Array<{ id: number; full_name: string; email: string | null }>;
        try {
          data = await query<{ id: number; full_name: string; email: string | null }>(
            `SELECT id, full_name, email
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

      // Build name map
      const nameToEmp = new Map<string, { id: number; count: number; email: string | null }>();
      for (const emp of dbEmployees) {
        const key = normalizeFullName(emp.full_name);
        const existing = nameToEmp.get(key);
        if (existing) {
          existing.count++;
        } else {
          nameToEmp.set(key, { id: emp.id, count: 1, email: emp.email });
        }
      }

      const matched: Array<{ id: number; fullName: string; updates: Record<string, { old: string | null; new: string | null }> }> = [];
      const conflicts: Array<{ id: number; fullName: string; existingEmail: string; newEmail: string }> = [];
      const unmatched: Array<{ fullName: string; department: string | null }> = [];
      const ambiguous: Array<{ fullName: string; count: number }> = [];

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

        if (match.email && match.email !== row.email) {
          conflicts.push({ id: match.id, fullName: row.fullName, existingEmail: match.email, newEmail: row.email });
          continue;
        }

        // No existing email — will be set
        if (!match.email) {
          matched.push({
            id: match.id,
            fullName: row.fullName,
            updates: { 'Email': { old: null, new: row.email } },
          });
        }
        // same email → skip silently (idempotent)
      }

      const stats = {
        total: parsedRows.length,
        matched: matched.length,
        conflicts: conflicts.length,
        unmatched: unmatched.length,
        ambiguous: ambiguous.length,
      };

      if (preview) {
        res.json({ success: true, data: { matched, conflicts, unmatched, ambiguous, stats } });
        return;
      }

      // === Apply mode ===

      const manualMatches: Array<{ fullName: string; employeeId: number }> = [];
      try {
        const raw = req.body?.manualMatches;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) manualMatches.push(...parsed);
        }
      } catch { /* ignore */ }

      const conflictResolutions: Array<{ employeeId: number; overwrite: boolean }> = [];
      try {
        const raw = req.body?.conflictResolutions;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) conflictResolutions.push(...parsed);
        }
      } catch { /* ignore */ }

      const manualMap = new Map<string, number>();
      const dbById = new Map<number, { id: number; full_name: string; email: string | null }>();
      for (const m of manualMatches) {
        manualMap.set(normalizeFullName(m.fullName), m.employeeId);
      }
      if (manualMap.size > 0) {
        for (const emp of dbEmployees) {
          dbById.set(emp.id, emp);
        }
      }

      const conflictOverwriteSet = new Set(
        conflictResolutions.filter(r => r.overwrite).map(r => r.employeeId),
      );

      const errors: string[] = [];
      let updated = 0;

      for (const row of parsedRows) {
        const key = normalizeFullName(row.fullName);
        let match = nameToEmp.get(key);

        if ((!match || match.count > 1) && manualMap.has(key)) {
          const manualId = manualMap.get(key)!;
          const manualData = dbById.get(manualId);
          if (manualData) {
            match = { id: manualId, count: 1, email: manualData.email };
          }
        }

        if (!match || match.count > 1) continue;

        // Conflict: only overwrite if user chose to
        if (match.email && match.email !== row.email) {
          if (!conflictOverwriteSet.has(match.id)) continue;
        }

        // Skip if same email
        if (match.email === row.email) continue;

        try {
          await execute(
            'UPDATE employees SET email = $1, updated_at = $2 WHERE id = $3',
            [row.email, new Date().toISOString(), match.id],
          );
          updated++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${row.fullName}: ${msg}`);
        }
      }

      await auditService.logFromRequest(req, req.user.id, 'ENRICH_EMPLOYEES_CONTACTS', {
        details: { updated, errors: errors.length, total: parsedRows.length },
      });

      res.json({ success: true, data: { updated, errors, stats } });
    } catch (error) {
      console.error('Enrich contacts error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта контактов' });
    }
  },
};
