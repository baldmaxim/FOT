import { useMemo, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hiringRequestService } from '../../../services/hiringRequestService';
import { employeeService } from '../../../services/employeeService';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { useToast } from '../../../contexts/ToastContext';
import { ApiError } from '../../../api/client';
import { Avatar } from './hiringUi';
import styles from './hiring.module.css';

export const RecruiterPoolModal: FC<{ onClose: () => void }> = ({ onClose }) => {
  const dismiss = useOverlayDismiss(onClose);
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);

  const poolQuery = useQuery({ queryKey: ['hiring-recruiters'], queryFn: () => hiringRequestService.listRecruiters() });
  const pool = poolQuery.data ?? [];
  const poolIds = useMemo(() => new Set(pool.map(p => p.employee_id)), [pool]);

  const searchQuery = useQuery({
    queryKey: ['hiring-emp-search', debounced],
    queryFn: () => employeeService.getPaginated({ page: 1, pageSize: 40, search: debounced || undefined, status: 'active' }),
    enabled: debounced.trim().length >= 2,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['hiring-recruiters'] });
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Ошибка');
  const addMut = useMutation({ mutationFn: (emp: number) => hiringRequestService.addRecruiter(emp), onSuccess: refresh, onError: onErr });
  const removeMut = useMutation({
    mutationFn: (emp: number) => hiringRequestService.removeRecruiter(emp),
    onSuccess: (data) => {
      const active = data?.active_requests ?? [];
      if (active.length > 0) toast.success(`Убран из пула. Активные заявки (${active.length}) продолжают вестись.`);
      else toast.success('Убран из пула');
      refresh();
    },
    onError: onErr,
  });

  const foundEmployees = (searchQuery.data?.data ?? []).filter(e => !poolIds.has(Number(e.id)));

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <div><h3>Команда подбора персонала</h3><p>Рекрутеры, которых можно назначать ответственными за заявки.</p></div>
          <button className={styles.x} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.secH}><h4>В пуле ({pool.length})</h4></div>
          <div className={styles.poolList} style={{ marginBottom: 16 }}>
            {pool.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Пул пуст — добавьте сотрудников ниже.</div>}
            {pool.map(p => (
              <div key={p.employee_id} className={`${styles.poolRow} ${styles.inPool}`}>
                <Avatar name={p.full_name} id={p.employee_id} />
                <div className={styles.meta}>
                  <div className={styles.nm}>{p.full_name}</div>
                  <div className={styles.sub}>{[p.position_name, p.department_name].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <button className={`${styles.mini} ${styles.no}`} disabled={removeMut.isPending} onClick={() => removeMut.mutate(p.employee_id)}>Убрать</button>
              </div>
            ))}
          </div>

          <div className={styles.secH}><h4>Добавить сотрудника</h4></div>
          <input className={styles.poolSearch} placeholder="Поиск по ФИО…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className={styles.poolList}>
            {debounced.trim().length < 2 && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Введите минимум 2 символа.</div>}
            {searchQuery.isFetching && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Поиск…</div>}
            {foundEmployees.map(e => (
              <div key={e.id} className={styles.poolRow}>
                <Avatar name={e.full_name} id={Number(e.id)} />
                <div className={styles.meta}>
                  <div className={styles.nm}>{e.full_name}</div>
                </div>
                <button className={`${styles.mini} ${styles.ok}`} disabled={addMut.isPending} onClick={() => addMut.mutate(Number(e.id))}>＋ В пул</button>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.modalFoot}>
          <button className={styles.btnPrimary} onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
};
