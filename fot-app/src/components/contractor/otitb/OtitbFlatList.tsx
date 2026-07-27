import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../../../contexts/ToastContext';
import {
  contractorAdminService,
  type IInductedPersonFull,
  type IOtTrainingDef,
} from '../../../services/contractorService';
import { fmtDate, useOtitbInvalidate } from './otitbShared';
import { OtitbRowBadge } from './OtitbStatusBadge';
import { OtitbPersonModal } from './OtitbPersonModal';
import contractorStyles from '../../../pages/contractor/Contractor.module.css';
import styles from './Otitb.module.css';

/** Плоский список реестра по всем организациям (режим «показать всех»). */
export const OtitbFlatList: FC<{ canEdit: boolean; catalog: IOtTrainingDef[] }> = ({
  canEdit,
  catalog,
}) => {
  const toast = useToast();
  const refresh = useOtitbInvalidate();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<IInductedPersonFull | null>(null);

  const allQuery = useQuery({
    queryKey: ['contractor-induction-all'],
    queryFn: () => contractorAdminService.listAllInducted(),
    staleTime: 15_000,
  });
  const all: IInductedPersonFull[] = allQuery.data ?? [];

  const q = search.trim().toLocaleLowerCase('ru');
  const rows = useMemo(
    () => (q
      ? all.filter(r =>
        r.full_name.toLocaleLowerCase('ru').includes(q)
        || r.org_name.toLocaleLowerCase('ru').includes(q))
      : all),
    [all, q],
  );

  const handleArchive = async (row: IInductedPersonFull) => {
    if (!window.confirm(
      `Убрать «${row.full_name}» (${row.org_name}) из реестра ОТиТБ?\nИстория обучения сохранится в архиве.`,
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

  if (allQuery.isLoading) return <div className={contractorStyles.empty}>Загрузка…</div>;

  return (
    <div>
      <div className={styles.searchRow}>
        <input
          className={contractorStyles.input}
          type="search"
          inputMode="search"
          placeholder="Поиск по ФИО или организации"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <table className={contractorStyles.table}>
        <thead>
          <tr>
            <th style={{ width: 48 }}>№</th>
            <th>Организация</th>
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
              <td>{r.org_name}</td>
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
          {rows.length === 0 && (
            <tr>
              <td colSpan={canEdit ? 6 : 5} style={{ color: 'var(--text-secondary)' }}>
                {q ? 'Никого не найдено' : 'Реестр пуст'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <OtitbPersonModal
          orgId={editing.org_department_id}
          person={editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
};
