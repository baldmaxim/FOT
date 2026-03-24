import type { OrganizationEncrypted, Organization } from '../types/index.js';

/**
 * Расшифровывает организацию
 */
export function decryptOrganization(encrypted: OrganizationEncrypted): Organization {
  return {
    id: encrypted.id,
    name: encrypted.name || 'Неизвестная организация',
    parent_organization_id: encrypted.parent_organization_id ?? null,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

/**
 * Логирует ошибки Supabase с деталями
 */
export function logSupabaseError(context: string, error: unknown) {
  console.error(`[${context}] Supabase error:`, {
    message: error instanceof Error ? error.message : String(error),
    details: (error as any)?.details,
    hint: (error as any)?.hint,
    code: (error as any)?.code,
  });
}
