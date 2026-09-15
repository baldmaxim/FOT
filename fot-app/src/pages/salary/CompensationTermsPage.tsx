import { useMemo, useState, type FC } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  defaultCalcTypeFor,
  type IPayrollTermsRow,
} from '../../services/payrollService';
import { useToast } from '../../contexts/ToastContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useStructureTree } from '../../hooks/useStructure';
import { AssignTermsModal } from '../../components/salary/AssignTermsModal';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import type { OrgDepartmentNode } from '../../types';
import styles from './CompensationTermsPage.module.css';

/** Дерево без ветки подрядчиков: они исключены из списка, выбор их узла всегда давал бы 0. */
const withoutNode = (nodes: OrgDepartmentNode[], excludedId: string | null): OrgDepartmentNode[] => (
  excludedId
    ? nodes
      .filter(node => node.id !== excludedId)
      .map(node => ({ ...node, children: withoutNode(node.children ?? [], excludedId) }))
    : nodes
);

/**
 * Сегодня по часам браузера. toISOString() дал бы дату UTC: после местной полуночи
 * (до 03:00 по Москве) выборка шла бы на вчерашний день.
 */
const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const formatMoney = (value: string | number | null): string => {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Сумма зависит от вида оплаты: у оклада — месячная, у почасовой — ставка за час. */
const formatSalary = (row: IPayrollTermsRow): string => {
  if (!row.terms_id) return '—';
  return row.calc_type === 'salary'
    ? `${formatMoney(row.monthly_salary)} ₽/мес`
    : `${formatMoney(row.hourly_rate)} ₽/час`;
};

const formatMonthly = (value: string | number | null): string => {
  const money = formatMoney(value);
  return money === '—' ? money : `${money} ₽/мес`;
};

const pluralEmployees = (count: number): string => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сотрудник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сотрудника';
  return 'сотрудников';
};

const COLUMN_COUNT = 11;

export const CompensationTermsPage: FC = () => {
  const { success, error: showError, warning } = useToast();
  const queryClient = useQueryClient();

  // Дата выборки фиксируется на открытии экрана: условия и графики — «на сегодня».
  const [date] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modalFor, setModalFor] = useState<IPayrollTermsRow[] | null>(null);

  // Поиск идёт на сервере по всему штату, а не по загруженной странице.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // Любой фильтр меняет выборку: возвращаемся на первую страницу и снимаем выделение,
  // иначе можно назначить условия строкам, которых на экране уже нет.
  const resetPaging = () => {
    setPage(1);
    setSelected(new Set());
  };

  const termsQuery = useQuery({
    queryKey: ['payroll-terms', date, departmentId, debouncedSearch, page],
    queryFn: () => payrollService.listTerms({
      date,
      departmentId: departmentId || undefined,
      q: debouncedSearch || undefined,
      page,
      pageSize: PAYROLL_TERMS_PAGE_SIZE,
    }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => termsQuery.data?.rows ?? [], [termsQuery.data]);
  const meta = termsQuery.data?.meta;
  const total = meta?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAYROLL_TERMS_PAGE_SIZE));

  const structureTree = useStructureTree();
  const contractorRootId = meta?.contractor_root_id ?? null;
  const departments = useMemo(
    () => withoutNode(structureTree.data?.departments ?? [], contractorRootId),
    [structureTree.data, contractorRootId],
  );

  const assignMutation = useMutation({
    mutationFn: async (payload: Parameters<typeof payrollService.assignBulk>[1] & { ids: number[] }) => {
      const { ids, ...rest } = payload;
      return ids.length === 1
        ? payrollService.assign(ids[0], rest).then(() => ({ applied: [{ employee_id: ids[0], terms_id: 0 }], skipped: [] }))
        : payrollService.assignBulk(ids, rest);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      setSelected(new Set());
      setModalFor(null);
      if (result.skipped.length > 0) {
        warning(`Применено: ${result.applied.length}. Отклонено: ${result.skipped.length} — ${result.skipped[0].message}`);
      } else {
        success(`Условия оплаты назначены: ${result.applied.length}`);
      }
    },
    onError: (err: Error) => showError(err.message || 'Не удалось назначить условия'),
  });

  const toggleOne = (employeeId: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const allVisibleSelected = rows.length > 0 && rows.every(row => selected.has(row.employee_id));
  const toggleAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map(row => row.employee_id)));
  };

  const goToPage = (next: number) => {
    setPage(next);
    // Выделение действует в пределах страницы: на другой странице — другие люди.
    setSelected(new Set());
  };

  const openBulk = () => {
    const chosen = rows.filter(row => selected.has(row.employee_id));
    if (chosen.length > 0) setModalFor(chosen);
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Поиск</span>
          <input
            type="search"
            className={styles.input}
            placeholder="Поиск по ФИО…"
            value={search}
            onChange={event => { setSearch(event.target.value); resetPaging(); }}
          />
        </label>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Подразделение</span>
          <DepartmentTreeSelect
            departments={departments}
            value={departmentId}
            onChange={(id) => { setDepartmentId(id); resetPaging(); }}
            isLoading={structureTree.isPending}
            isError={structureTree.isError}
            onRetry={() => { void structureTree.refetch(); }}
          />
        </div>
      </div>

      {meta && !meta.contractors_excluded && (
        <div className={styles.warning}>
          Не найден узел «Подрядные организации» — в списке могут оказаться сотрудники подрядчиков.
        </div>
      )}

      <div className={styles.actions}>
        <span className={styles.counter}>
          {total} {pluralEmployees(total)}{selected.size > 0 ? `, выделено ${selected.size}` : ''}
        </span>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={selected.size === 0}
          onClick={openBulk}
        >
          Назначить выделенным
        </button>
      </div>

      {termsQuery.isLoading && <div className={styles.state}>Загрузка…</div>}
      {termsQuery.isError && <div className={styles.stateError}>Не удалось загрузить условия оплаты</div>}

      {!termsQuery.isLoading && !termsQuery.isError && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.checkboxCell}>
                  <input
                    type="checkbox"
                    aria-label="Выделить всех на странице"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th>Сотрудник</th>
                <th>Подразделение</th>
                <th>Должность</th>
                <th>График работы</th>
                <th>Оклад</th>
                <th>Премиальная часть</th>
                <th>Компенсация проживания</th>
                <th>Начисления за посл. полгода</th>
                <th>Действует с</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.employee_id} className={row.terms_id ? undefined : styles.rowMissing}>
                  <td className={styles.checkboxCell}>
                    <input
                      type="checkbox"
                      aria-label={`Выделить ${row.full_name ?? ''}`}
                      checked={selected.has(row.employee_id)}
                      onChange={() => toggleOne(row.employee_id)}
                    />
                  </td>
                  <td>{row.full_name ?? '—'}</td>
                  <td>{row.department_name ?? '—'}</td>
                  <td>{row.position_name ?? '—'}</td>
                  <td>{row.schedule_name ?? '—'}</td>
                  <td>{formatSalary(row)}</td>
                  <td>{row.terms_id ? formatMonthly(row.bonus_amount) : '—'}</td>
                  <td>{row.terms_id ? formatMonthly(row.housing_compensation) : '—'}</td>
                  {/* Фактические начисления придут из 1С ЗУП — импорта пока нет. */}
                  <td>—</td>
                  <td>{row.effective_from ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setModalFor([row])}
                    >
                      {row.terms_id ? 'Изменить' : 'Назначить'}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className={styles.state}>Сотрудники не найдены</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <nav className={styles.pagination} aria-label="Страницы списка">
          <button
            type="button"
            className={styles.pageButton}
            disabled={page <= 1 || termsQuery.isFetching}
            onClick={() => goToPage(page - 1)}
          >
            ← Назад
          </button>
          <span className={styles.pageInfo}>
            Стр. {page} из {pageCount}
          </span>
          <button
            type="button"
            className={styles.pageButton}
            disabled={page >= pageCount || termsQuery.isFetching}
            onClick={() => goToPage(page + 1)}
          >
            Вперёд →
          </button>
        </nav>
      )}

      {modalFor && (
        <AssignTermsModal
          rows={modalFor}
          defaultDate={date}
          isSaving={assignMutation.isPending}
          onClose={() => setModalFor(null)}
          onSubmit={(payload) => assignMutation.mutate({
            ...payload,
            ids: modalFor.map(row => row.employee_id),
          })}
          resolveDefaultCalcType={defaultCalcTypeFor}
        />
      )}
    </div>
  );
};
