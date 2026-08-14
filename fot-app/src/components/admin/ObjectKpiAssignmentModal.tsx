import { useEffect, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { ModalShell } from '../ui/ModalShell';
import { objectKpiApi } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { formatDate } from '../../utils/formatMoney';
import styles from './ObjectKpiAssignmentModal.module.css';

/**
 * Модалка «Назначения»: закрепление объектов и выдача внесистемной роли
 * «Руководитель экономического отдела».
 *
 * Один вход вместо двух с разными правами — отдельной вкладки в карточке сотрудника нет.
 * Роль «Руководитель эк. отдела» пишется в object_kpi_global_roles и объекта не имеет,
 * поэтому поле объекта для неё скрывается; выдавать её может только админ.
 */

type RoleKind = 'construction_manager' | 'object_economist' | 'economics_head';

const ROLE_LABELS: Record<RoleKind, string> = {
  construction_manager: 'Руководитель строительства',
  object_economist: 'Экономист объекта',
  economics_head: 'Руководитель эк. отдела',
};

const errorText = (error: unknown): string =>
  (error as { data?: { error?: string } })?.data?.error
  ?? (error as Error)?.message
  ?? 'Не удалось сохранить';

interface IProps {
  onClose: () => void;
  /** Предвыбранный объект — когда модалку открыли из строки таблицы. */
  objectId?: string;
}

export const ObjectKpiAssignmentModal: FC<IProps> = ({ onClose, objectId }) => {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [role, setRole] = useState<RoleKind>('construction_manager');
  const [employeeTerm, setEmployeeTerm] = useState('');
  const [employee, setEmployee] = useState<{ id: number; full_name: string | null } | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: number; full_name: string | null }>>([]);

  const objectsQuery = useQuery({
    queryKey: objectKpiKeys.objects(),
    queryFn: () => objectKpiApi.listObjects(),
  });

  const assignmentsQuery = useQuery({
    queryKey: objectKpiKeys.assignments(objectId),
    queryFn: () => objectKpiApi.listAssignments(objectId),
  });

  const globalRolesQuery = useQuery({
    queryKey: objectKpiKeys.globalRoles(),
    queryFn: () => objectKpiApi.listGlobalRoles(),
  });

  // Автокомплит ФИО: дебаунс 250 мс, минимум 2 символа — как в EmployeeFioPicker.
  // Сброс списка тоже уходит в таймер: setState прямо в теле эффекта даёт каскадный
  // ре-рендер (react-hooks/set-state-in-effect).
  useEffect(() => {
    const term = employeeTerm.trim();
    const timer = window.setTimeout(() => {
      if (term.length < 2) {
        setSuggestions([]);
        return;
      }
      objectKpiApi.searchEmployees(term).then(setSuggestions).catch(() => setSuggestions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [employeeTerm]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: objectKpiKeys.all });
  };

  const createMutation = useMutation({
    // Возврат не используется — список перечитывается инвалидацией, поэтому Promise<void>
    // вместо объединения двух разных типов записи.
    mutationFn: async (payload: Record<string, unknown>): Promise<void> => {
      if (role === 'economics_head') await objectKpiApi.createGlobalRole(payload);
      else await objectKpiApi.createAssignment(payload);
    },
    onSuccess: () => {
      toast.success('Назначение сохранено');
      setEmployee(null);
      setEmployeeTerm('');
      refresh();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const closeAssignmentMutation = useMutation({
    mutationFn: (args: { id: string; version: number; validTo: string }) =>
      objectKpiApi.updateAssignment(args.id, { valid_to: args.validTo, version: args.version }),
    onSuccess: () => { toast.success('Период закрыт'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const revokeRoleMutation = useMutation({
    mutationFn: (id: string) => objectKpiApi.revokeGlobalRole(id),
    onSuccess: () => { toast.success('Роль снята'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee) {
      toast.error('Выберите сотрудника');
      return;
    }
    const form = new FormData(event.currentTarget);
    const validFrom = String(form.get('valid_from') ?? '');
    const validToRaw = String(form.get('valid_to') ?? '');
    const validTo = validToRaw !== '' ? validToRaw : null;

    if (role === 'economics_head') {
      createMutation.mutate({ employee_id: employee.id, valid_from: validFrom, valid_to: validTo });
      return;
    }

    const selectedObject = String(form.get('skud_object_id') ?? '');
    if (!selectedObject) {
      toast.error('Выберите объект');
      return;
    }
    createMutation.mutate({
      skud_object_id: selectedObject,
      employee_id: employee.id,
      role_kind: role,
      valid_from: validFrom,
      valid_to: validTo,
    });
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title}>Назначения по объектам</span>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>

          <div className={styles.body}>
            <form className={styles.form} onSubmit={submit}>
              <label className={styles.field}>
                <span>Роль</span>
                <select value={role} onChange={e => setRole(e.target.value as RoleKind)}>
                  <option value="construction_manager">{ROLE_LABELS.construction_manager}</option>
                  <option value="object_economist">{ROLE_LABELS.object_economist}</option>
                  {/* Внесистемная роль — только админ: она даёт право пересматривать закрытые месяцы. */}
                  {isAdmin && <option value="economics_head">{ROLE_LABELS.economics_head}</option>}
                </select>
              </label>

              {role !== 'economics_head' && (
                <label className={styles.field}>
                  <span>Объект</span>
                  <select name="skud_object_id" defaultValue={objectId ?? ''} required>
                    <option value="">— выберите —</option>
                    {(objectsQuery.data ?? []).map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              )}

              <label className={styles.field}>
                <span>Сотрудник</span>
                <input
                  value={employee ? (employee.full_name ?? String(employee.id)) : employeeTerm}
                  onChange={e => { setEmployee(null); setEmployeeTerm(e.target.value); }}
                  placeholder="Поиск по ФИО…"
                />
                {!employee && suggestions.length > 0 && (
                  <div className={styles.suggestions}>
                    {suggestions.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => { setEmployee(item); setSuggestions([]); }}
                      >
                        {item.full_name ?? item.id}
                      </button>
                    ))}
                  </div>
                )}
              </label>

              <div className={styles.dates}>
                <label className={styles.field}>
                  <span>Период с</span>
                  <input type="date" name="valid_from" defaultValue={today} required />
                </label>
                <label className={styles.field}>
                  <span>по (пусто — бессрочно)</span>
                  <input type="date" name="valid_to" />
                </label>
              </div>

              <button type="submit" className={styles.primaryBtn} disabled={createMutation.isPending}>
                Назначить
              </button>
            </form>

            <h3 className={styles.sectionTitle}>Действующие закрепления</h3>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Объект</th><th>Сотрудник</th><th>Роль</th><th>Период</th><th /></tr>
                </thead>
                <tbody>
                  {(assignmentsQuery.data ?? []).map(item => (
                    <tr key={item.id}>
                      <td>{item.object_name ?? '—'}</td>
                      <td>{item.employee_name ?? item.employee_id}</td>
                      <td>{ROLE_LABELS[item.role_kind]}</td>
                      <td>{formatDate(item.valid_from)} — {item.valid_to ? formatDate(item.valid_to) : '…'}</td>
                      <td className={styles.actions}>
                        {!item.valid_to && (
                          <button
                            type="button"
                            onClick={() => closeAssignmentMutation.mutate({
                              id: item.id, version: item.version, validTo: today,
                            })}
                          >
                            Закрыть сегодня
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(assignmentsQuery.data ?? []).length === 0 && (
                    <tr><td colSpan={5} className={styles.empty}>Закреплений нет</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <h3 className={styles.sectionTitle}>Руководители экономического отдела</h3>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Сотрудник</th><th>Период</th><th /></tr>
                </thead>
                <tbody>
                  {(globalRolesQuery.data ?? []).map(item => (
                    <tr key={item.id}>
                      <td>{item.employee_name ?? item.employee_id}</td>
                      <td>{formatDate(item.valid_from)} — {item.valid_to ? formatDate(item.valid_to) : '…'}</td>
                      <td className={styles.actions}>
                        {isAdmin && !item.valid_to && (
                          <button type="button" onClick={() => revokeRoleMutation.mutate(item.id)}>
                            Снять
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(globalRolesQuery.data ?? []).length === 0 && (
                    <tr><td colSpan={3} className={styles.empty}>Назначений нет</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </ModalShell>
  );
};
