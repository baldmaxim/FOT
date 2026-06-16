import { type FC, lazy, type ReactNode, Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings, Trash2, X } from 'lucide-react';
import { feedbackService, type FeedbackKind } from '../services/feedbackService';
import { testsService, type ITestResponseRow } from '../services/testsService';
import { useStructureTree } from '../hooks/useStructure';
import { DepartmentTreeSelect } from '../components/staff/DepartmentTreeSelect';
import { DeptStatsGrid } from '../components/feedback/DeptStatsGrid';
import { PeriodFilter } from '../components/feedback/PeriodFilter';
import { DailyActivity } from '../components/feedback/DailyActivity';
import { DepartmentTasksPage } from '../components/feedback/DepartmentTasksPage';
import { todayIso, isSingleDay, periodLabel } from '../components/feedback/deptStats';
import { findSu10CompanyNode, collectDepartmentIds } from '../utils/departmentUtils';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { useToast } from '../contexts/ToastContext';
import type { OrgDepartmentNode } from '../types/organization';
import styles from './FeedbackReviewPage.module.css';

const TestManagementModal = lazy(() =>
  import('../components/tests/TestManagementModal').then(m => ({ default: m.TestManagementModal })),
);
const TestResponseViewModal = lazy(() =>
  import('../components/tests/TestResponseViewModal').then(m => ({ default: m.TestResponseViewModal })),
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
  const today = useMemo(() => todayIso(), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [department, setDepartment] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const deptParam = searchParams.get('dept');

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
    .filter(s => !department || s.department_id === department),
  [data, su10Ids, department]);

  const single = isSingleDay(from, to);

  const openDept = (id: string): void => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('dept', id);
    return next;
  });
  const closeDept = (): void => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.delete('dept');
    return next;
  });

  // Клик по отделу → страница отдела (адрес ?dept=<id>, работает «назад»).
  if (deptParam) {
    return (
      <div className={styles.tabBody}>
        <DepartmentTasksPage departmentId={deptParam} from={from} to={to} single={single} onBack={closeDept} />
      </div>
    );
  }

  const note = single
    ? periodLabel(from, to)
    : `${periodLabel(from, to)} · ${data?.workingDays ?? 0} раб. дн.`;

  return (
    <div className={styles.tabBody}>
      <DeptStatsGrid
        rows={rows}
        verb="Заполнили"
        showCounts={single}
        overallNote={note}
        onSelect={s => s.department_id && openDept(s.department_id)}
        leadingControls={
          <PeriodFilter from={from} to={to} today={today} onChange={(f, t) => { setFrom(f); setTo(t); }}>
            <DepartmentTreeSelect departments={tree ?? []} value={department} onChange={setDepartment}
              isLoading={structure.isPending} isError={structure.isError} showAllOption />
          </PeriodFilter>
        }
        activity={single ? undefined : <DailyActivity daily={data?.daily ?? []} from={from} to={to} />}
      />
    </div>
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

// ---- Вкладка «Тесты» (визуально та же сетка; метрика «прошли/всего», без периода) ----
const TestsTab: FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>('');
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
    .filter(s => !department || s.department_id === department),
  [stats, su10Ids, department]);

  return (
    <div className={styles.tabBody}>
      <DeptStatsGrid
        rows={rows}
        verb="Прошли"
        showCounts
        onSelect={s => setModalDept(s.department_name)}
        leadingControls={
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
            <div className={styles.deptSelect}>
              <DepartmentTreeSelect departments={tree ?? []} value={department} onChange={setDepartment}
                isLoading={structure.isPending} isError={structure.isError} showAllOption />
            </div>
          </div>
        }
      />

      {modalDept && (
        <DeptDetailModal title={modalDept} onClose={() => setModalDept(null)}>
          <DeptTakersContent testId={effectiveTest} responses={responses ?? []} departmentName={modalDept} />
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
const DeptTakersContent: FC<{ testId: string; responses: ITestResponseRow[]; departmentName: string }> = ({ testId, responses, departmentName }) => {
  const [q, setQ] = useState('');
  const [viewResponseId, setViewResponseId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const filtered = useMemo(() => responses.filter(r =>
    r.status === 'submitted'
    && r.department_name === departmentName
    && (!q || (r.full_name ?? '').toLowerCase().includes(q.toLowerCase())),
  ), [responses, departmentName, q]);

  const handleDelete = async (responseId: string) => {
    if (!window.confirm('Удалить прохождение? Сотрудник сможет пройти тест заново.')) return;
    try {
      await testsService.deleteResponse(testId, responseId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['test-responses', testId] }),
        queryClient.invalidateQueries({ queryKey: ['test-stats', testId] }),
      ]);
      showToast('success', 'Прохождение удалено');
    } catch (err) {
      console.error('test response delete error:', err);
      showToast('error', 'Не удалось удалить прохождение');
    }
  };

  return (
    <>
      <input className={styles.search} placeholder="Поиск по ФИО" value={q} onChange={e => setQ(e.target.value)} />
      <table className={styles.table}>
        <thead><tr><th>Сотрудник</th><th>Статус</th><th>Время</th><th></th></tr></thead>
        <tbody>
          {filtered.map(r => (
            <tr key={r.id}>
              <td className={styles.deptCell} onClick={() => setViewResponseId(r.id)}>{r.full_name ?? '—'}</td>
              <td>Пройден</td>
              <td>{fmtDate(r.submitted_at)}</td>
              <td>
                <button className={styles.deleteBtn} onClick={() => handleDelete(r.id)} title="Удалить прохождение">
                  <Trash2 size={15} />
                </button>
              </td>
            </tr>
          ))}
          {!filtered.length && <tr><td colSpan={4} className={styles.empty}>Нет прохождений</td></tr>}
        </tbody>
      </table>

      {viewResponseId && (
        <Suspense fallback={null}>
          <TestResponseViewModal testId={testId} responseId={viewResponseId} onClose={() => setViewResponseId(null)} />
        </Suspense>
      )}
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
