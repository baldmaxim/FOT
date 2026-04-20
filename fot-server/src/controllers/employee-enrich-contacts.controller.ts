import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

interface ParsedRow {
  fullName: string;
  email: string;
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

function parseContactsExcel(buffer: Buffer): ParsedRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

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
      const parsedRows = parseContactsExcel(req.file.buffer);

      if (parsedRows.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных в файле' });
        return;
      }

      // Load all employees
      const dbEmployees: Array<{ id: number; full_name: string; email: string | null }> = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('employees')
          .select('id, full_name, email')
          .eq('is_archived', false)
          .range(from, from + PAGE_SIZE - 1);

        if (error) {
          res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
          return;
        }

        if (!data || data.length === 0) break;
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

        const { error } = await supabase
          .from('employees')
          .update({ email: row.email, updated_at: new Date().toISOString() })
          .eq('id', match.id);

        if (error) {
          errors.push(`${row.fullName}: ${error.message}`);
        } else {
          updated++;
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
