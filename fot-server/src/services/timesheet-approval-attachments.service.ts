import { supabase } from '../config/database.js';
import { r2Service } from './r2.service.js';

export const APPROVAL_ATTACHMENT_ENTITY_TYPE = 'timesheet_approval';
export const APPROVAL_ATTACHMENT_PURPOSE = 'weekend_confirmation';
export const APPROVAL_ATTACHMENT_CATEGORY = 'timesheet_weekend_confirmation';

export interface IApprovalAttachment {
  document_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export async function findOrCreateDraftApproval(params: {
  departmentId: string;
  startDate: string;
  endDate: string;
  userId: string;
}): Promise<{ id: number; status: string }> {
  const { departmentId, startDate, endDate } = params;

  const existing = await supabase
    .from('timesheet_approvals')
    .select('id, status')
    .eq('department_id', departmentId)
    .eq('start_date', startDate)
    .eq('end_date', endDate)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data) {
    return { id: Number(existing.data.id), status: String(existing.data.status) };
  }

  const now = new Date().toISOString();
  const inserted = await supabase
    .from('timesheet_approvals')
    .insert({
      department_id: departmentId,
      start_date: startDate,
      end_date: endDate,
      status: 'draft',
      updated_at: now,
    })
    .select('id, status')
    .single();
  if (inserted.error) throw inserted.error;
  return { id: Number(inserted.data.id), status: String(inserted.data.status) };
}

export async function listApprovalAttachments(approvalId: number): Promise<IApprovalAttachment[]> {
  const linksRes = await supabase
    .from('document_links')
    .select('document_id')
    .eq('entity_type', APPROVAL_ATTACHMENT_ENTITY_TYPE)
    .eq('entity_id', String(approvalId))
    .eq('purpose', APPROVAL_ATTACHMENT_PURPOSE);
  if (linksRes.error) throw linksRes.error;
  const docIds = (linksRes.data || []).map((row) => Number(row.document_id));
  if (docIds.length === 0) return [];

  const docsRes = await supabase
    .from('documents')
    .select('id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at')
    .in('id', docIds)
    .order('created_at', { ascending: false });
  if (docsRes.error) throw docsRes.error;

  const uploaderIds = [...new Set((docsRes.data || []).map((row) => String(row.uploaded_by)).filter(Boolean))];
  const names = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const profilesRes = await supabase
      .from('user_profiles')
      .select('id, full_name')
      .in('id', uploaderIds);
    if (profilesRes.error) throw profilesRes.error;
    for (const row of profilesRes.data || []) {
      names.set(String(row.id), (row.full_name as string | null) ?? null);
    }
  }

  return (docsRes.data || []).map((row) => ({
    document_id: Number(row.id),
    file_name: String(row.file_name),
    file_size: Number(row.file_size),
    mime_type: String(row.mime_type),
    r2_key: String(row.r2_key),
    uploaded_by: String(row.uploaded_by),
    uploaded_by_name: names.get(String(row.uploaded_by)) ?? null,
    created_at: String(row.created_at),
  }));
}

export async function countApprovalAttachments(approvalId: number): Promise<number> {
  const res = await supabase
    .from('document_links')
    .select('id', { count: 'exact', head: true })
    .eq('entity_type', APPROVAL_ATTACHMENT_ENTITY_TYPE)
    .eq('entity_id', String(approvalId))
    .eq('purpose', APPROVAL_ATTACHMENT_PURPOSE);
  if (res.error) throw res.error;
  return res.count ?? 0;
}

export async function createAttachmentRecord(params: {
  approvalId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  r2Key: string;
  uploadedBy: string;
}): Promise<IApprovalAttachment> {
  const docRes = await supabase
    .from('documents')
    .insert({
      employee_id: null,
      leave_request_id: null,
      category: APPROVAL_ATTACHMENT_CATEGORY,
      file_name: params.fileName,
      file_size: params.fileSize,
      mime_type: params.mimeType,
      r2_key: params.r2Key,
      uploaded_by: params.uploadedBy,
    })
    .select('id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at')
    .single();
  if (docRes.error) throw docRes.error;

  const linkRes = await supabase
    .from('document_links')
    .insert({
      document_id: docRes.data.id,
      entity_type: APPROVAL_ATTACHMENT_ENTITY_TYPE,
      entity_id: String(params.approvalId),
      purpose: APPROVAL_ATTACHMENT_PURPOSE,
    });
  if (linkRes.error) throw linkRes.error;

  return {
    document_id: Number(docRes.data.id),
    file_name: String(docRes.data.file_name),
    file_size: Number(docRes.data.file_size),
    mime_type: String(docRes.data.mime_type),
    r2_key: String(docRes.data.r2_key),
    uploaded_by: String(docRes.data.uploaded_by),
    uploaded_by_name: null,
    created_at: String(docRes.data.created_at),
  };
}

export async function deleteAttachmentRecord(documentId: number): Promise<{ deleted: boolean; r2Key: string | null; approvalId: number | null }> {
  const linkRes = await supabase
    .from('document_links')
    .select('entity_id')
    .eq('document_id', documentId)
    .eq('entity_type', APPROVAL_ATTACHMENT_ENTITY_TYPE)
    .eq('purpose', APPROVAL_ATTACHMENT_PURPOSE)
    .maybeSingle();
  if (linkRes.error) throw linkRes.error;
  const approvalId = linkRes.data ? Number(linkRes.data.entity_id) : null;

  const docRes = await supabase
    .from('documents')
    .select('r2_key')
    .eq('id', documentId)
    .maybeSingle();
  if (docRes.error) throw docRes.error;
  const r2Key = docRes.data ? String(docRes.data.r2_key) : null;

  const deleteLinks = await supabase.from('document_links').delete().eq('document_id', documentId);
  if (deleteLinks.error) throw deleteLinks.error;
  const deleteDoc = await supabase.from('documents').delete().eq('id', documentId);
  if (deleteDoc.error) throw deleteDoc.error;

  if (r2Key) {
    try {
      await r2Service.deleteObject(r2Key);
    } catch (err) {
      console.warn('timesheet-approval-attachments.delete: r2 delete failed', err);
    }
  }

  return { deleted: Boolean(docRes.data), r2Key, approvalId };
}
