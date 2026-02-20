import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const sigurAdminController = {
  /**
   * POST /api/sigur/seed-positions
   * Предзаполнение справочника должностей строительной организации
   */
  async seedPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const SEED_POSITIONS = [
        { name: 'Руководитель строительства', category: 'manager', grade: 50, sort_order: 1 },
        { name: 'Начальник участка', category: 'manager', grade: 40, sort_order: 2 },
        { name: 'Прораб', category: 'engineer', grade: 30, sort_order: 3 },
        { name: 'Бригадир', category: 'worker', grade: 20, sort_order: 4 },
        { name: 'Рабочий', category: 'worker', grade: 10, sort_order: 5 },
        { name: 'Инженер', category: 'engineer', grade: 25, sort_order: 6 },
        { name: 'Сотрудник', category: 'other', grade: 5, sort_order: 7 },
      ];

      const { data: existing } = await supabase
        .from('positions')
        .select('id, name_encrypted')
        .eq('organization_id', organizationId);

      const existingNames = new Set<string>();
      for (const pos of existing || []) {
        if (pos.name_encrypted) {
          existingNames.add(encryptionService.decrypt(pos.name_encrypted).toLowerCase().trim());
        }
      }

      let created = 0;
      let skipped = 0;

      for (const pos of SEED_POSITIONS) {
        if (existingNames.has(pos.name.toLowerCase().trim())) {
          skipped++;
          continue;
        }

        const { error } = await supabase
          .from('positions')
          .insert({
            organization_id: organizationId,
            name_encrypted: encryptionService.encrypt(pos.name),
            category: pos.category,
            grade: pos.grade,
            sort_order: pos.sort_order,
          });

        if (error) {
          console.error(`[seedPositions] error for "${pos.name}":`, error.message);
        } else {
          created++;
        }
      }

      console.log(`[seedPositions] done: ${created} created, ${skipped} skipped`);

      res.json({
        success: true,
        data: { created, skipped, total: SEED_POSITIONS.length },
      });
    } catch (error) {
      console.error('Sigur seedPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания справочника должностей' });
    }
  },

  /**
   * POST /api/sigur/sync-organizations
   * Импорт отделов Sigur как организаций в БД
   */
  async syncOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];

      if (!departments || departments.length === 0) {
        res.json({ success: true, data: { imported: 0, skipped: 0, total: 0 } });
        return;
      }

      const { data: existingOrgs } = await supabase
        .from('organizations')
        .select('id, name_encrypted');

      const existingNames = new Set<string>();
      for (const org of existingOrgs || []) {
        if (org.name_encrypted) {
          existingNames.add(encryptionService.decrypt(org.name_encrypted).toLowerCase().trim());
        }
      }

      let imported = 0;
      let skipped = 0;

      for (const dept of departments) {
        const name = (dept.name as string) || (dept.title as string) || '';
        if (!name.trim()) { skipped++; continue; }

        if (existingNames.has(name.toLowerCase().trim())) {
          skipped++;
          continue;
        }

        const { error: insertError } = await supabase
          .from('organizations')
          .insert({ name_encrypted: encryptionService.encrypt(name.trim()) });

        if (insertError) {
          console.error('[syncOrganizations] insert error:', insertError.message);
          skipped++;
        } else {
          existingNames.add(name.toLowerCase().trim());
          imported++;
        }
      }

      console.log(`[syncOrganizations] done: ${imported} imported, ${skipped} skipped`);

      res.json({
        success: true,
        data: { imported, skipped, total: departments.length },
      });
    } catch (error) {
      console.error('Sigur syncOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта организаций из Sigur' });
    }
  },

  /**
   * POST /api/sigur/clean-duplicate-organizations
   * Удаление дублей организаций
   */
  async cleanDuplicateOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: allOrgs } = await supabase
        .from('organizations')
        .select('id, name_encrypted, created_at')
        .order('created_at', { ascending: true });

      if (!allOrgs || allOrgs.length === 0) {
        res.json({ success: true, data: { duplicatesRemoved: 0, totalBefore: 0, totalAfter: 0 } });
        return;
      }

      const groups = new Map<string, typeof allOrgs>();
      for (const org of allOrgs) {
        const name = org.name_encrypted
          ? encryptionService.decrypt(org.name_encrypted).toLowerCase().trim()
          : '';
        if (!name) continue;
        const existing = groups.get(name) || [];
        existing.push(org);
        groups.set(name, existing);
      }

      const remapEntries: { dupId: string; keepId: string }[] = [];
      const allDuplicateIds: string[] = [];

      for (const [, orgs] of groups) {
        if (orgs.length <= 1) continue;
        const keepId = orgs[0].id;
        for (let i = 1; i < orgs.length; i++) {
          remapEntries.push({ dupId: orgs[i].id, keepId });
          allDuplicateIds.push(orgs[i].id);
        }
      }

      if (allDuplicateIds.length === 0) {
        res.json({ success: true, data: { duplicatesRemoved: 0, totalBefore: allOrgs.length, totalAfter: allOrgs.length } });
        return;
      }

      const TABLES_WITH_ORG_ID = [
        'employees', 'org_departments', 'org_sites',
        'positions', 'skud_daily_summary', 'skud_events', 'user_profiles',
      ];

      const errors: string[] = [];
      const keepGroups = new Map<string, string[]>();
      for (const { dupId, keepId } of remapEntries) {
        const list = keepGroups.get(keepId) || [];
        list.push(dupId);
        keepGroups.set(keepId, list);
      }

      for (const table of TABLES_WITH_ORG_ID) {
        for (const [keepId, dupIds] of keepGroups) {
          const { error: updateError } = await supabase
            .from(table)
            .update({ organization_id: keepId })
            .in('organization_id', dupIds);

          if (updateError) {
            errors.push(`${table}: ${updateError.message}`);
          }
        }
      }

      const { error: deleteError } = await supabase
        .from('organizations')
        .delete()
        .in('id', allDuplicateIds);

      let duplicatesRemoved = allDuplicateIds.length;
      if (deleteError) {
        errors.push(`delete batch: ${deleteError.message}`);
        duplicatesRemoved = 0;
      }

      console.log(`[cleanDuplicateOrgs] removed ${duplicatesRemoved} duplicates`);

      res.json({
        success: true,
        data: {
          totalBefore: allOrgs.length,
          totalAfter: allOrgs.length - duplicatesRemoved,
          duplicatesRemoved,
          errors,
        },
      });
    } catch (error) {
      console.error('cleanDuplicateOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки дублей организаций' });
    }
  },
};
