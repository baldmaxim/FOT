import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../../contexts/ToastContext';
import {
  contractorAdminService,
  type IInductedPerson,
  type IOtTrainingDef,
} from '../../../services/contractorService';
import { fmtDate, useOtitbInvalidate } from './otitbShared';
import { OtitbRowBadge } from './OtitbStatusBadge';
import { OtitbPersonModal } from './OtitbPersonModal';
import contractorStyles from '../../../pages/contractor/Contractor.module.css';
import styles from './Otitb.module.css';

interface IProps {
  orgId: string;
  canEdit: boolean;
  catalog: IOtTrainingDef[];
}

/** Реестр обучения по ОТ одной организации: № / ФИО / Статус / Вводный инструктаж. */
export const OtitbOrgDetail: FC<IProps> = ({ orgId, canEdit, catalog }) => {
  const toast = useToast();
  const refresh = useOtitbInvalidate();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<IInductedPerson | null>(null);
  const [creating, setCreating] = useState(false);

  const listQuery = useQuery({
    queryKey: ['contractor-induction', orgId],
    queryFn: () => contractorAdminService.listInducted(orgId),
    staleTime: 10_000,
  });
  const rows: IInductedPerson[] = listQuery.data ?? [];

  const handleArchive = async (row: IInductedPerson) => {
    if (!window.confirm(
      `Убрать «${row.full_name}» из реестра ОТиТБ?\nИстория обучения сохранится в архиве.`,
    )) return;
    setBusy(true);
    try {
      await contractorAdminService.removeInducted(row.id);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось убрать запись');
    } finally {
      setBusy(false);
    }
  };

  if (listQuery.isLoading) return <div className={contractorStyles.detailRow}>Загрузка…</div>;

  return (
    <>
      <table className={contractorStyles.table}>
        <thead>
          <tr>
            <th style={{ width: 48 }}>№</th>
            <th>ФИО</th>
            <th style={{ width: 220 }}>Статус</th>
            <th style={{ width: 160 }} className={styles.hideNarrow}>Вводный инструктаж</th>
            {canEdit && <th style={{ width: 96 }}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={r.row_status === 'alert' ? styles.rowAlert : undefined}>
              <td>{i + 1}</td>
              <td>{r.full_name}</td>
              <td><OtitbRowBadge person={r} /></td>
              <td className={styles.hideNarrow}>{fmtDate(r.inducted_on)}</td>
              {canEdit && (
                <td>
                  <div className={styles.rowActions}>
                    <button
                      className={contractorStyles.btn}
                      onClick={() => setEditing(r)}
                      disabled={busy}
                      title="Обучение по охране труда"
                    >
                      ✎
                    </button>
                    <button
                      className={contractorStyles.btn}
                      onClick={() => void handleArchive(r)}
                      disabled={busy}
                      title="Убрать из реестра (в архив)"
                    >
                      ✗
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canEdit && (
        <div className={contractorStyles.detailRow}>
          <button
            type="button"
            className={`${contractorStyles.btn} ${contractorStyles.btnPrimary}`}
            onClick={() => setCreating(true)}
            disabled={busy}
          >
            Добавить сотрудника
          </button>
        </div>
      )}

      {creating && (
        <OtitbPersonModal
          orgId={orgId}
          catalog={catalog}
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      )}
      {editing && (
        <OtitbPersonModal
          orgId={orgId}
          person={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
};
