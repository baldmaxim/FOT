import { type FC, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { testsService } from '../../services/testsService';
import { TestEditorModal } from './TestEditorModal';
import styles from './TestManagement.module.css';

interface IProps {
  onClose: () => void;
}

const fmtWindow = (from: string | null, to: string | null): string => {
  const f = from ? new Date(from).toLocaleDateString('ru-RU') : '—';
  const t = to ? new Date(to).toLocaleDateString('ru-RU') : '∞';
  return `${f} → ${t}`;
};

export const TestManagementModal: FC<IProps> = ({ onClose }) => {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const overlay = useOverlayDismiss(onClose);

  const [editorTestId, setEditorTestId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const { data: tests, isLoading } = useQuery({
    queryKey: ['tests-manage-list'],
    queryFn: () => testsService.list(),
    staleTime: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tests-manage-list'] });

  const handleDeactivate = async (id: string) => {
    if (!window.confirm('Деактивировать тест? Сотрудники перестанут его видеть.')) return;
    try {
      await testsService.deactivate(id);
      await refresh();
      showToast('success', 'Тест деактивирован');
    } catch (err) {
      console.error('deactivate test error:', err);
      showToast('error', 'Не удалось деактивировать');
    }
  };

  const openCreate = () => { setEditorTestId(null); setEditorOpen(true); };
  const openEdit = (id: string) => { setEditorTestId(id); setEditorOpen(true); };

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.head}>
          <h2 className={styles.title}>Управление тестами</h2>
          <div className={styles.headActions}>
            <button className={styles.addBtn} onClick={openCreate}><Plus size={14} /> Создать тест</button>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
          </div>
        </div>

        <div className={styles.body}>
          {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
            <table className={styles.table}>
              <thead>
                <tr><th>Название</th><th>Период</th><th>Вопросов</th><th>Отделов</th><th>Пройдено</th><th>Статус</th><th></th></tr>
              </thead>
              <tbody>
                {(tests ?? []).map(t => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td>{fmtWindow(t.active_from, t.active_to)}</td>
                    <td>{t.question_count}</td>
                    <td>{t.assignment_count}</td>
                    <td>{t.submitted_count}</td>
                    <td>{t.is_active ? 'Активен' : 'Выключен'}</td>
                    <td className={styles.rowActions}>
                      <button className={styles.iconBtn} onClick={() => openEdit(t.id)} title="Редактировать"><Pencil size={15} /></button>
                      {t.is_active && (
                        <button className={styles.iconBtn} onClick={() => handleDeactivate(t.id)} title="Деактивировать"><Power size={15} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {!tests?.length && <tr><td colSpan={7} className={styles.empty}>Тестов пока нет</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editorOpen && (
        <TestEditorModal
          testId={editorTestId}
          onClose={() => setEditorOpen(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
};
