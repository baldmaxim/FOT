import { type FC, lazy, Suspense, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings, Trash2 } from 'lucide-react';
import { feedbackService, type FeedbackKind, type IDepartmentStat } from '../services/feedbackService';
import { testsService } from '../services/testsService';
import { useStructureTree } from '../hooks/useStructure';
import { DepartmentTreeSelect } from '../components/staff/DepartmentTreeSelect';
import { findDepartmentName } from '../utils/departmentUtils';
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

// Узел компании «(СУ-10) ООО СУ-10» в дереве: прямой потомок синтетического
// корня (kind='object') с именем, содержащим «СУ-10». Возвращает узел или null.
const SU10_RE = /су-?10/i;
const findSu10Node = (nodes: OrgDepartmentNode[]): OrgDepartmentNode | null => {
  for (const n of nodes) {
    if (n.kind !== 'object' && SU10_RE.test(n.name)) return n;
    if (n.children?.length) {
      const found = findSu10Node(n.children);
      if (found) return found;
    }
  }
  return null;
};

// Все id потомков-отделов (kind='department') узла компании, без бригад/объектов
// и без самого узла компании.
const collectDeptIds = (node: OrgDepartmentNode, out: Set<string>): void => {
  node.children?.forEach(c => {
    if (c.kind === 'department') out.add(c.id);
    collectDeptIds(c, out);
  });
};

// Панель статистики по отделам (для выбранного отдела / вкладки Тесты).
const StatsPanel: FC<{ stats: IDepartmentStat[]; verb: string }> = ({ stats, verb }) => {
  if (!stats.length) return null;
  return (
    <div className={styles.stats}>
      {stats.map(s => (
        <div key={s.department_id ?? s.department_name} className={styles.statItem}>
          <span className={styles.statDept}>{s.department_name}</span>
          <span className={styles.statValue}>{s.filled}/{s.total} {verb}</span>
        </div>
      ))}
    </div>
  );
};

// Сводка по отделам СУ-10 в 5 столбцов (по 2 отдела в строке).
const Su10StatsTable: FC<{ rows: IDepartmentStat[] }> = ({ rows }) => {
  const pairs = useMemo(() => {
    const out: Array<[IDepartmentStat, IDepartmentStat | null]> = [];
    for (let i = 0; i < rows.length; i += 2) out.push([rows[i], rows[i + 1] ?? null]);
    return out;
  }, [rows]);

  if (!rows.length) return null;
  return (
    <table className={styles.statTable}>
      <thead>
        <tr>
          <th>№</th><th>Отдел</th><th>Заполнили</th><th>Отдел</th><th>Заполнили</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map(([a, b], i) => (
          <tr key={a.department_id ?? i}>
            <td>{i + 1}</td>
            <td>{a.department_name}</td>
            <td>{a.filled}/{a.total}</td>
            <td>{b?.department_name ?? ''}</td>
            <td>{b ? `${b.filled}/${b.total}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

interface IFilterBarProps {
  q: string; onQ: (v: string) => void;
  from: string; onFrom: (v: string) => void;
  to: string; onTo: (v: string) => void;
  // Дерево отделов для фильтра (если передано — рендерим DepartmentTreeSelect).
  tree?: OrgDepartmentNode[];
  treeLoading?: boolean;
  treeError?: boolean;
  department?: string; onDepartment?: (v: string) => void;
}

const FilterBar: FC<IFilterBarProps> = ({ q, onQ, from, onFrom, to, onTo, tree, treeLoading, treeError, department, onDepartment }) => (
  <div className={styles.filters}>
    <input className={styles.search} placeholder="Поиск по ФИО" value={q} onChange={e => onQ(e.target.value)} />
    {tree && onDepartment && (
      <div className={styles.deptSelect}>
        <DepartmentTreeSelect
          departments={tree}
          value={department ?? ''}
          onChange={onDepartment}
          isLoading={treeLoading}
          isError={treeError}
          showAllOption
        />
      </div>
    )}
    <input className={styles.date} type="date" value={from} onChange={e => onFrom(e.target.value)} />
    <input className={styles.date} type="date" value={to} onChange={e => onTo(e.target.value)} />
  </div>
);

// ---- Вкладка «Задачи» ----
const TasksTab: FC = () => {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');

  const structure = useStructureTree();
  const tree = structure.data?.departments;

  const { data, isLoading } = useQuery({
    queryKey: ['fb-tasks', q, from, to, department],
    queryFn: () => feedbackService.listTasks({ q, from, to, department }),
    staleTime: 30_000,
  });

  // Отделы внутри «(СУ-10) ООО СУ-10», без бригад — для сводной таблицы.
  const su10Rows = useMemo(() => {
    if (!tree) return [];
    const node = findSu10Node(tree);
    if (!node) return [];
    const ids = new Set<string>();
    collectDeptIds(node, ids);
    return (data?.stats ?? [])
      .filter(s => s.department_id && ids.has(s.department_id))
      .sort((a, b) => a.department_name.localeCompare(b.department_name, 'ru'));
  }, [tree, data]);

  const selectedStat = useMemo(
    () => (department ? (data?.stats ?? []).filter(s => s.department_id === department) : []),
    [department, data],
  );

  return (
    <div className={styles.tabBody}>
      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo}
        tree={tree} treeLoading={structure.isPending} treeError={structure.isError}
        department={department} onDepartment={setDepartment} />

      {department === ''
        ? <Su10StatsTable rows={su10Rows} />
        : <StatsPanel stats={selectedStat} verb="заполнили" />}

      {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
        <table className={styles.table}>
          <thead><tr><th>Сотрудник</th><th>Отдел</th><th>Задача</th><th>Дата</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map(r => (
              <tr key={r.id}>
                <td>{r.full_name ?? '—'}</td>
                <td>{r.department_name ?? '—'}</td>
                <td className={styles.textCell}>{r.content}</td>
                <td>{fmtDay(r.task_date)}</td>
              </tr>
            ))}
            {!data?.rows.length && <tr><td colSpan={4} className={styles.empty}>Нет данных</td></tr>}
          </tbody>
        </table>
      )}
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

  const queryKey = ['fb-messages', kind, q, from, to];
  const { data, isLoading } = useQuery({
    queryKey,
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
      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo} />
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
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);

  const structure = useStructureTree();
  const tree = structure.data?.departments;

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

  // Имя выбранного в дереве отдела — для клиентского фильтра прохождений.
  const selectedDeptName = useMemo(
    () => (department && tree ? findDepartmentName(tree, department) : null),
    [department, tree],
  );

  const filtered = useMemo(() => (responses ?? []).filter(r => {
    if (r.status !== 'submitted') return false;
    if (q && !(r.full_name ?? '').toLowerCase().includes(q.toLowerCase())) return false;
    if (selectedDeptName && r.department_name !== selectedDeptName) return false;
    if (from && (!r.submitted_at || r.submitted_at < from)) return false;
    if (to && (!r.submitted_at || r.submitted_at > `${to}T23:59:59`)) return false;
    return true;
  }), [responses, q, selectedDeptName, from, to]);

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

      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo}
        tree={tree} treeLoading={structure.isPending} treeError={structure.isError}
        department={department} onDepartment={setDepartment} />
      <StatsPanel stats={stats ?? []} verb="прошли" />

      <table className={styles.table}>
        <thead><tr><th>Сотрудник</th><th>Отдел</th><th>Статус</th><th>Время</th></tr></thead>
        <tbody>
          {filtered.map(r => (
            <tr key={r.id}>
              <td>{r.full_name ?? '—'}</td>
              <td>{r.department_name ?? '—'}</td>
              <td>Пройден</td>
              <td>{fmtDate(r.submitted_at)}</td>
            </tr>
          ))}
          {!filtered.length && <tr><td colSpan={4} className={styles.empty}>Нет прохождений</td></tr>}
        </tbody>
      </table>

      {managerOpen && (
        <Suspense fallback={null}>
          <TestManagementModal onClose={() => setManagerOpen(false)} />
        </Suspense>
      )}
    </div>
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
