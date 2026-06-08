import { type FC, lazy, type ReactNode, Suspense, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings, Trash2, X } from 'lucide-react';
import { feedbackService, type FeedbackKind, type IDepartmentStat } from '../services/feedbackService';
import { testsService, type ITestResponseRow } from '../services/testsService';
import { useStructureTree } from '../hooks/useStructure';
import { DepartmentTreeSelect } from '../components/staff/DepartmentTreeSelect';
import { findSu10CompanyNode, collectDepartmentIds } from '../utils/departmentUtils';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { useToast } from '../contexts/ToastContext';
import type { OrgDepartmentNode } from '../types/organization';
import styles from './FeedbackReviewPage.module.css';

const TestManagementModal = lazy(() =>
  import('../components/tests/TestManagementModal').then(m => ({ default: m.TestManagementModal })),
);

type SubTab = 'tasks' | 'suggestions' | 'complaints' | 'tests';

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'tasks', label: 'Задачи' },
  { key: 'suggestions', label: 'Предложения' },
  { key: 'complaints', label: 'Жалобы' },
  { key: 'tests', label: 'Тесты' },
];

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const fmtDay = (d: string): string => new Date(d).toLocaleDateString('ru-RU');

// id отделов (kind='department') внутри «(СУ-10) ООО СУ-10».
const useSu10DeptIds = (tree?: OrgDepartmentNode[]): Set<string> => useMemo(() => {
  if (!tree) return new Set<string>();
  const node = findSu10CompanyNode(tree);
  return node ? new Set(collectDepartmentIds(node)) : new Set<string>();
}, [tree]);

// ---- Общая модалка детализации по отделу ----
const DeptDetailModal: FC<{ title: string; onClose: () => void; children: ReactNode }> = ({ title, onClose, children }) => {
  const overlay = useOverlayDismiss(onClose);
  return (
    <div className={styles.overlay}
      onMouseDown={overlay.onMouseDown} onMouseUp={overlay.onMouseUp} onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart} onTouchEnd={overlay.onTouchEnd}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>{title}</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        </div>
        <div className={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
};

// ---- Сводка отделов СУ-10 (5 столбцов), отделы кликабельны ----
const Su10StatsTable: FC<{ rows: IDepartmentStat[]; verb: string; onSelect: (s: IDepartmentStat) => void }> = ({ rows, verb, onSelect }) => {
  const pairs = useMemo(() => {
    const out: Array<[IDepartmentStat, IDepartmentStat | null]> = [];
    for (let i = 0; i < rows.length; i += 2) out.push([rows[i], rows[i + 1] ?? null]);
    return out;
  }, [rows]);

  if (!rows.length) return <div className={styles.empty}>Нет отделов</div>;
  return (
    <table className={styles.statTable}>
      <thead>
        <tr><th>№</th><th>Отдел</th><th>{verb}</th><th>Отдел</th><th>{verb}</th></tr>
      </thead>
      <tbody>
        {pairs.map(([a, b], i) => (
          <tr key={a.department_id ?? i}>
            <td>{i + 1}</td>
            <td className={styles.deptCell} onClick={() => onSelect(a)}>{a.department_name}</td>
            <td>{a.filled}/{a.total}</td>
            {b
              ? <><td className={styles.deptCell} onClick={() => onSelect(b)}>{b.department_name}</td><td>{b.filled}/{b.total}</td></>
              : <><td></td><td></td></>}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ---- Панель фильтров (дерево отдела + даты, опц. поиск ФИО) ----
interface IFilterBarProps {
  from: string; onFrom: (v: string) => void;
  to: string; onTo: (v: string) => void;
  q?: string; onQ?: (v: string) => void;
  tree?: OrgDepartmentNode[]; treeLoading?: boolean; treeError?: boolean;
  department?: string; onDepartment?: (v: string) => void;
}

const FilterBar: FC<IFilterBarProps> = ({ from, onFrom, to, onTo, q, onQ, tree, treeLoading, treeError, department, onDepartment }) => (
  <div className={styles.filters}>
    {onQ && <input className={styles.search} placeholder="Поиск по ФИО" value={q ?? ''} onChange={e => onQ(e.target.value)} />}
    {tree && onDepartment && (
      <div className={styles.deptSelect}>
        <DepartmentTreeSelect departments={tree} value={department ?? ''} onChange={onDepartment}
          isLoading={treeLoading} isError={treeError} showAllOption />
      </div>
    )}
    <input className={styles.date} type="date" value={from} onChange={e => onFrom(e.target.value)} />
    <input className={styles.date} type="date" value={to} onChange={e => onTo(e.target.value)} />
  </div>
);

// ---- Вкладка «Задачи» ----
const TasksTab: FC = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [modalDept, setModalDept] = useState<{ id: string; name: string } | null>(null);

  const structure = useStructureTree();
  const tree = structure.data?.departments;
  const su10Ids = useSu10DeptIds(tree);

  const { data } = useQuery({
    queryKey: ['fb-tasks-stats', from, to, department],
    queryFn: () => feedbackService.listTasks({ from, to, department }),
    staleTime: 30_000,
  });

  const rows = useMemo(() => (data?.stats ?? [])
    .filter(s => s.department_id && su10Ids.has(s.department_id))
    .filter(s => !department || s.department_id === department)
    .sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru')),
  [data, su10Ids, department]);

  return (
    <div className={styles.tabBody}>
      <FilterBar from={from} onFrom={setFrom} to={to} onTo={setTo}
        tree={tree} treeLoading={structure.isPending} treeError={structure.isError}
        department={department} onDepartment={setDepartment} />
      <Su10StatsTable rows={rows} verb="Заполнили" onSelect={s => s.department_id && setModalDept({ id: s.department_id, name: s.department_name })} />

      {modalDept && (
        <DeptDetailModal title={modalDept.name} onClose={() => setModalDept(null)}>
          <DeptTasksContent departmentId={modalDept.id} from={from} to={to} />
        </DeptDetailModal>
      )}
    </div>
  );
};

// Содержимое модалки «Задачи отдела» — серверная выборка с поиском по ФИО.
const DeptTasksContent: FC<{ departmentId: string; from: string; to: string }> = ({ departmentId, from, to }) => {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['fb-tasks-dept', departmentId, from, to, q],
    queryFn: () => feedbackService.listTasks({ department: departmentId, from, to, q }),
    staleTime: 30_000,
  });
  return (
    <>
      <input className={styles.search} placeholder="Поиск по ФИО" value={q} onChange={e => setQ(e.target.value)} />
      {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
        <table className={styles.table}>
          <thead><tr><th>Сотрудник</th><th>Задача</th><th>Дата</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map(r => (
              <tr key={r.id}>
                <td>{r.full_name ?? '—'}</td>
                <td className={styles.textCell}>{r.content}</td>
                <td>{fmtDay(r.task_date)}</td>
              </tr>
            ))}
            {!data?.rows.length && <tr><td colSpan={3} className={styles.empty}>Нет данных</td></tr>}
          </tbody>
        </table>
      )}
    </>
  );
};

// ---- Вкладки «Предложения» / «Жалобы» ----
const MessagesTab: FC<{ kind: FeedbackKind }> = ({ kind }) => {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['fb-messages', kind, q, from, to],
    queryFn: () => feedbackService.listMessages(kind, { q, from, to }),
    staleTime: 30_000,
  });

  const handleDelete = async (id: number) => {
    if (!window.confirm('Удалить обращение? Действие необратимо.')) return;
    try {
      await feedbackService.remove(id);
      await queryClient.invalidateQueries({ queryKey: ['fb-messages', kind] });
      showToast('success', 'Обращение удалено');
    } catch (err) {
      console.error('feedback delete error:', err);
      showToast('error', 'Не удалось удалить обращение');
    }
  };

  return (
    <div className={styles.tabBody}>
      <FilterBar from={from} onFrom={setFrom} to={to} onTo={setTo} q={q} onQ={setQ} />
      {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
        <table className={styles.table}>
          <thead><tr><th>Автор</th><th>Сообщение</th><th>Время</th><th></th></tr></thead>
          <tbody>
            {(data ?? []).map(r => (
              <tr key={r.id}>
                <td>{r.is_anonymous ? <em className={styles.anon}>Анонимно</em> : r.author}</td>
                <td className={styles.textCell}>{r.content}</td>
                <td>{fmtDate(r.created_at)}</td>
                <td>
                  <button className={styles.deleteBtn} onClick={() => handleDelete(r.id)} title="Удалить">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={4} className={styles.empty}>Нет данных</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ---- Вкладка «Тесты» ----
const TestsTab: FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);
  const [modalDept, setModalDept] = useState<string | null>(null);

  const structure = useStructureTree();
  const tree = structure.data?.departments;
  const su10Ids = useSu10DeptIds(tree);

  const { data: tests } = useQuery({
    queryKey: ['tests-manage-list'],
    queryFn: () => testsService.list(),
    staleTime: 30_000,
  });
  const effectiveTest = selectedTest || tests?.[0]?.id || '';

  const { data: stats } = useQuery({
    queryKey: ['test-stats', effectiveTest],
    queryFn: () => testsService.getStats(effectiveTest),
    enabled: !!effectiveTest,
    staleTime: 30_000,
  });
  const { data: responses } = useQuery({
    queryKey: ['test-responses', effectiveTest],
    queryFn: () => testsService.listResponses(effectiveTest),
    enabled: !!effectiveTest,
    staleTime: 30_000,
  });

  const rows = useMemo(() => (stats ?? [])
    .filter(s => s.department_id && su10Ids.has(s.department_id))
    .filter(s => !department || s.department_id === department)
    .sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru')),
  [stats, su10Ids, department]);

  return (
    <div className={styles.tabBody}>
      <div className={styles.testsHead}>
        <select className={styles.select} value={effectiveTest} onChange={e => setSelectedTest(e.target.value)}>
          {(tests ?? []).map(t => (
            <option key={t.id} value={t.id}>{t.title}{t.is_active ? '' : ' (неактивен)'}</option>
          ))}
          {!tests?.length && <option value="">Тестов нет</option>}
        </select>
        <button className={styles.gearBtn} onClick={() => setManagerOpen(true)} title="Управление тестами">
          <Settings size={18} />
        </button>
      </div>

      <FilterBar from={from} onFrom={setFrom} to={to} onTo={setTo}
        tree={tree} treeLoading={structure.isPending} treeError={structure.isError}
        department={department} onDepartment={setDepartment} />
      <Su10StatsTable rows={rows} verb="Прошли" onSelect={s => setModalDept(s.department_name)} />

      {modalDept && (
        <DeptDetailModal title={modalDept} onClose={() => setModalDept(null)}>
          <DeptTakersContent responses={responses ?? []} departmentName={modalDept} />
        </DeptDetailModal>
      )}

      {managerOpen && (
        <Suspense fallback={null}>
          <TestManagementModal onClose={() => setManagerOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

// Содержимое модалки «Прохождения отдела» — клиентский фильтр по уже загруженным.
const DeptTakersContent: FC<{ responses: ITestResponseRow[]; departmentName: string }> = ({ responses, departmentName }) => {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => responses.filter(r =>
    r.status === 'submitted'
    && r.department_name === departmentName
    && (!q || (r.full_name ?? '').toLowerCase().includes(q.toLowerCase())),
  ), [responses, departmentName, q]);

  return (
    <>
      <input className={styles.search} placeholder="Поиск по ФИО" value={q} onChange={e => setQ(e.target.value)} />
      <table className={styles.table}>
        <thead><tr><th>Сотрудник</th><th>Статус</th><th>Время</th></tr></thead>
        <tbody>
          {filtered.map(r => (
            <tr key={r.id}>
              <td>{r.full_name ?? '—'}</td>
              <td>Пройден</td>
              <td>{fmtDate(r.submitted_at)}</td>
            </tr>
          ))}
          {!filtered.length && <tr><td colSpan={3} className={styles.empty}>Нет прохождений</td></tr>}
        </tbody>
      </table>
    </>
  );
};

export const FeedbackReviewPage: FC = () => {
  const [tab, setTab] = useState<SubTab>('tasks');

  return (
    <div className={styles.page}>
      <div className={styles.subTabs}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.subTab} ${tab === t.key ? styles.subTabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'tasks' && <TasksTab />}
      {tab === 'suggestions' && <MessagesTab kind="suggestion" />}
      {tab === 'complaints' && <MessagesTab kind="complaint" />}
      {tab === 'tests' && <TestsTab />}
    </div>
  );
};
