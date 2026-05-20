import { useEffect, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { contractorAdminService } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IProps {
  userId: string;
  onSaved?: () => void;
}

/**
 * Привязка пользователя-подрядчика к одной подрядной организации.
 * Текущую привязку тянет сама (GET /admin/contractor/users/:id/org),
 * поэтому встраивается в карточку пользователя (Система → Пользователи).
 */
export const ContractorOrgAccessSection: FC<IProps> = ({ userId, onSaved }) => {
  const toast = useToast();
  const [value, setValue] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const currentQuery = useQuery({
    queryKey: ['contractor-user-org', userId],
    queryFn: () => contractorAdminService.getUserOrg(userId),
    staleTime: 30_000,
  });

  const orgsQuery = useQuery({
    queryKey: ['contractor-admin-orgs'],
    queryFn: contractorAdminService.listOrgs,
    staleTime: 5 * 60_000,
  });

  const currentOrgId = currentQuery.data ?? null;
  useEffect(() => { setValue(currentOrgId ?? ''); }, [currentOrgId, userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await contractorAdminService.setUserOrg(userId, value || null);
      toast.success('Привязка обновлена');
      await currentQuery.refetch();
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const loading = currentQuery.isLoading || orgsQuery.isLoading;

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        className={styles.select}
        value={value}
        onChange={e => setValue(e.target.value)}
        disabled={saving || loading}
      >
        <option value="">— не привязан —</option>
        {(orgsQuery.data ?? []).map(o => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <button
        type="button"
        className="btn-primary"
        onClick={() => void handleSave()}
        disabled={saving || loading || value === (currentOrgId ?? '')}
      >
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
    </div>
  );
};
