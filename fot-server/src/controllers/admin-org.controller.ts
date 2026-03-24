import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, OrganizationEncrypted } from '../types/index.js';
import { decryptOrganization } from './admin-helpers.js';

export const adminOrgController = {
  async getOrganizations(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: orgsEncrypted, error: orgsError } = await supabase
        .from('organizations')
        .select('*')
        .order('created_at');

      if (orgsError) {
        console.error('Get organizations error:', orgsError);
        res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
        return;
      }

      const orgs = (orgsEncrypted as OrganizationEncrypted[] || [])
        .filter(o => o.name && o.name.trim().length > 0)
        .map(decryptOrganization);

      const { data: memberCounts, error: countError } = await supabase
        .from('user_profiles')
        .select('organization_id')
        .not('organization_id', 'is', null);

      if (countError) {
        console.error('Get member counts error:', countError);
      }

      const countMap: Record<string, number> = {};
      if (memberCounts) {
        memberCounts.forEach((m: { organization_id: string | null }) => {
          if (m.organization_id) {
            countMap[m.organization_id] = (countMap[m.organization_id] || 0) + 1;
          }
        });
      }

      const orgsWithStats = orgs
        .map(org => ({
          ...org,
          member_count: countMap[org.id] || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      res.json({ success: true, data: orgsWithStats });
    } catch (error) {
      console.error('Get organizations error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
    }
  },

  async createOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name } = z.object({ name: z.string().min(2).max(255) }).parse(req.body);

      const { data: encrypted, error } = await supabase
        .from('organizations')
        .insert({ name: name.trim() })
        .select()
        .single();

      if (error) {
        console.error('Create organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to create organization' });
        return;
      }

      const org = decryptOrganization(encrypted as OrganizationEncrypted);

      await auditService.logFromRequest(req, req.user.id, 'ORG_CREATED', {
        entityType: 'organization',
        entityId: org.id,
        details: { name },
      });

      res.status(201).json({ success: true, data: org });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Create organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to create organization' });
    }
  },

  async updateOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { name } = z.object({ name: z.string().min(2).max(255) }).parse(req.body);

      const { data: encrypted, error } = await supabase
        .from('organizations')
        .update({
          name: name.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Update organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to update organization' });
        return;
      }

      if (!encrypted) {
        res.status(404).json({ success: false, error: 'Organization not found' });
        return;
      }

      const org = decryptOrganization(encrypted as OrganizationEncrypted);

      await auditService.logFromRequest(req, req.user.id, 'ORG_UPDATED', {
        entityType: 'organization',
        entityId: id,
        details: { name },
      });

      res.json({ success: true, data: org });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to update organization' });
    }
  },

  async deleteOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { data: members, error: checkError } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('organization_id', id)
        .limit(1);

      if (checkError) {
        console.error('Check members error:', checkError);
        res.status(500).json({ success: false, error: 'Failed to check organization members' });
        return;
      }

      if (members && members.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Cannot delete organization with members. Remove all members first.',
        });
        return;
      }

      const { error } = await supabase
        .from('organizations')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Delete organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete organization' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'ORG_DELETED', {
        entityType: 'organization',
        entityId: id,
      });

      res.json({ success: true, message: 'Organization deleted successfully' });
    } catch (error) {
      console.error('Delete organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete organization' });
    }
  },
};
