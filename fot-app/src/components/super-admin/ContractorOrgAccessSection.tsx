import { useEffect, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { contractorAdminService } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IProps {
  userId: string;
  /** Текущая привязка из списка (для начального значения). */
  currentOrgId: string | null;
  onSaved?: () => void;
}

/** Single-select привязка пользователя-подрядчика к одной организации. */
export const ContractorOrgAccessSection: FC<IProps> = ({ userId, currentOrgId, onSaved }) => {
  const toast = useToast();
  const [value, setValue] = useState<string>(currentOrgId ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(currentOrgId ?? ''); }, [currentOrgId, userId]);

  const orgsQuery = useQuery({
    queryKey: ['contractor-admin-orgs'],
    queryFn: contractorAdminService.listOrgs,
    staleTime: 5 * 60_000,
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await contractorAdminService.setUserOrg(userId, value || null);
      toast.success('Привязка обновлена');
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        className={styles.select}
        value={value}
        onChange={e => setValue(e.target.value)}
        disabled={saving || orgsQuery.isLoading}
      >
        <option value="">— не привязан —</option>
        {(orgsQuery.data ?? []).map(o => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <button
        className={styles.btnPrimary}
        onClick={() => void handleSave()}
        disabled={saving || value === (currentOrgId ?? '')}
      >
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
    </div>
  );
};
