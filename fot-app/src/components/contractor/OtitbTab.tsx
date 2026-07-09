import { Fragment, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  contractorAdminService,
  type IInductionOrg,
  type IInductedPerson,
  type IInductedPersonFull,
} from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

/** YYYY-MM-DD → DD.MM.YYYY строкой, без Date (иначе сдвиг дня по таймзоне). */
const fmtDate = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (ymd || '—');
};

/** Сегодня в локальной TZ как YYYY-MM-DD (sv-SE даёт ISO-формат), без UTC-сдвига. */
const todayLocal = (): string => new Date().toLocaleDateString('sv-SE');

interface IOrgDetailProps {
  orgId: string;
  canEdit: boolean;
}

/** Реестр прошедших вводный инструктаж по одной организации: № / ФИО / Дата + добавление. */
const OtitbOrgDetail: FC<IOrgDetailProps> = ({ orgId, canEdit }) => {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [date, setDate] = useState(todayLocal());
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
    await qc.invalidateQueries({ queryKey: ['contractor-induction-all'] });
  };

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.warning('Введите ФИО (минимум 2 символа)');
      return;
    }
    if (!date) {
      toast.warning('Укажите дату инструктажа');
      return;
    }
    // Мягкая защита от случайного дубля в пределах организации (тёзки на бэке не режем).
    const dup = rows.some(r => r.full_name.trim().toLocaleLowerCase('ru') === trimmed.toLocaleLowerCase('ru'));
    if (dup && !window.confirm('Такой сотрудник уже есть в списке. Добавить ещё раз?')) return;
    setBusy(true);
    try {
      await contractorAdminService.addInducted(orgId, trimmed, date);
      setName('');
      // Дату оставляем — обычно вводят пачкой за один день.
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
          <th style={{ width: 160 }}>Дата</th>
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
            <td>
              <input
                className={styles.input}
                type="date"
                value={date}
                disabled={busy}
                onChange={e => setDate(e.target.value)}
                title="Дата прохождения вводного инструктажа"
              />
            </td>
            <td>
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

/** Плоский список всех прошедших инструктаж по всем организациям (режим «показать всех»). */
const OtitbFlatList: FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

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

  const handleDelete = async (row: IInductedPersonFull) => {
    if (!window.confirm(`Удалить «${row.full_name}» (${row.org_name}) из списка прошедших инструктаж?`)) return;
    setBusy(true);
    try {
      await contractorAdminService.removeInducted(row.id);
      // Инвалидируем плоский список, счётчики организаций и раскрытые per-org списки.
      await qc.invalidateQueries({ queryKey: ['contractor-induction-all'] });
      await qc.invalidateQueries({ queryKey: ['contractor-induction-orgs'] });
      await qc.invalidateQueries({ queryKey: ['contractor-induction'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить запись');
    } finally {
      setBusy(false);
    }
  };

  if (allQuery.isLoading) return <div className={styles.empty}>Загрузка…</div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <input
          className={styles.input}
          type="search"
          inputMode="search"
          placeholder="Поиск по ФИО или организации"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: 48 }}>№</th>
            <th>Организация</th>
            <th>ФИО</th>
            <th style={{ width: 160 }}>Дата</th>
            {canEdit && <th style={{ width: 48 }}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td>{i + 1}</td>
              <td>{r.org_name}</td>
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
              <td colSpan={canEdit ? 5 : 4} style={{ color: 'var(--text-secondary)' }}>
                {q ? 'Никого не найдено' : 'Пока никто не прошёл инструктаж'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

/**
 * Вкладка «ОТиТБ»: реестр сотрудников подрядчиков, прошедших вводный инструктаж.
 * По умолчанию — список организаций (раскрывается в № / ФИО / Дата). Чекбокс
 * «Показать всех» переключает на плоский список по всем организациям.
 * Заведённый здесь сотрудник далее доступен подрядчику в выпадающем списке ФИО.
 */
export const OtitbTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin
    || canEditPage('/admin/contractor-approvals')
    || canEditPage('/admin/contractor-approvals/otitb');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);

  const orgsQuery = useQuery({
    queryKey: ['contractor-induction-orgs'],
    queryFn: () => contractorAdminService.getInductionOrgs(),
    staleTime: 30_000,
    enabled: !flat,
  });
  const orgs: IInductionOrg[] = orgsQuery.data ?? [];

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={flat} onChange={e => setFlat(e.target.checked)} />
        Показать всех прошедших инструктаж
      </label>

      {flat ? (
        <OtitbFlatList canEdit={canEdit} />
      ) : orgsQuery.isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : orgs.length === 0 ? (
        <div className={styles.empty}>Подрядные организации не найдены</div>
      ) : (
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
      )}
    </div>
  );
};

export default OtitbTab;
