import { Fragment, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  contractorAdminService,
  type IInductionOrg,
  type IInductedPerson,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru');
};

interface IOrgDetailProps {
  orgId: string;
  canEdit: boolean;
}

/** Реестр прошедших вводный инструктаж по одной организации: № / ФИО / Дата + добавление. */
const OtitbOrgDetail: FC<IOrgDetailProps> = ({ orgId, canEdit }) => {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const listQuery = useQuery({
    queryKey: ['contractor-induction', orgId],
    queryFn: () => contractorAdminService.listInducted(orgId),
    staleTime: 10_000,
  });
  const rows: IInductedPerson[] = listQuery.data ?? [];

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['contractor-induction', orgId] });
    await qc.invalidateQueries({ queryKey: ['contractor-induction-orgs'] });
  };

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.warning('Введите ФИО (минимум 2 символа)');
      return;
    }
    // Мягкая защита от случайного дубля в пределах организации (тёзки на бэке не режем).
    const dup = rows.some(r => r.full_name.trim().toLocaleLowerCase('ru') === trimmed.toLocaleLowerCase('ru'));
    if (dup && !window.confirm('Такой сотрудник уже есть в списке. Добавить ещё раз?')) return;
    setBusy(true);
    try {
      await contractorAdminService.addInducted(orgId, trimmed);
      setName('');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить сотрудника');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (row: IInductedPerson) => {
    if (!window.confirm(`Удалить «${row.full_name}» из списка прошедших инструктаж?`)) return;
    setBusy(true);
    try {
      await contractorAdminService.removeInducted(row.id);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить запись');
    } finally {
      setBusy(false);
    }
  };

  if (listQuery.isLoading) return <div className={styles.detailRow}>Загрузка…</div>;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th style={{ width: 48 }}>№</th>
          <th>ФИО</th>
          <th style={{ width: 140 }}>Дата</th>
          {canEdit && <th style={{ width: 48 }}></th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id}>
            <td>{i + 1}</td>
            <td>{r.full_name}</td>
            <td>{fmtDate(r.inducted_on)}</td>
            {canEdit && (
              <td>
                <button
                  className="btn-secondary"
                  onClick={() => void handleDelete(r)}
                  disabled={busy}
                  title="Удалить из списка"
                >
                  ✗
                </button>
              </td>
            )}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={canEdit ? 4 : 3} style={{ color: 'var(--text-secondary)' }}>
              Пока никого нет
            </td>
          </tr>
        )}
        {canEdit && (
          <tr>
            <td>—</td>
            <td>
              <input
                className={`${styles.input} ${styles.fullInput}`}
                value={name}
                placeholder="Фамилия Имя Отчество"
                disabled={busy}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleAdd(); }}
              />
            </td>
            <td colSpan={2}>
              <button className="btn-primary" onClick={() => void handleAdd()} disabled={busy}>
                Добавить
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
};

/**
 * Вкладка «ОТиТБ»: реестр сотрудников подрядчиков, прошедших вводный инструктаж.
 * Список всех подрядных организаций, каждая раскрывается в таблицу № / ФИО / Дата.
 * Заведённый здесь сотрудник далее доступен подрядчику в выпадающем списке ФИО.
 */
export const OtitbTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin
    || canEditPage('/admin/contractor-approvals')
    || canEditPage('/admin/contractor-approvals/otitb');
  const [expanded, setExpanded] = useState<string | null>(null);

  const orgsQuery = useQuery({
    queryKey: ['contractor-induction-orgs'],
    queryFn: () => contractorAdminService.getInductionOrgs(),
    staleTime: 30_000,
  });
  const orgs: IInductionOrg[] = orgsQuery.data ?? [];

  if (orgsQuery.isLoading) return <div className={styles.empty}>Загрузка…</div>;
  if (orgs.length === 0) return <div className={styles.empty}>Подрядные организации не найдены</div>;

  return (
    <div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Организация</th>
            <th style={{ width: 200 }}>Прошли инструктаж</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map(org => {
            const isOpen = expanded === org.id;
            return (
              <Fragment key={org.id}>
                <tr>
                  <td
                    onClick={() => setExpanded(isOpen ? null : org.id)}
                    style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}
                    title={isOpen ? 'Скрыть список' : 'Показать список'}
                  >
                    <span style={{ display: 'inline-block', width: 14, color: 'var(--text-secondary)' }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    {org.name}
                  </td>
                  <td>{org.inducted_count}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={2}>
                      <OtitbOrgDetail orgId={org.id} canEdit={canEdit} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default OtitbTab;
