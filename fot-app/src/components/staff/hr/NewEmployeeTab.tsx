import { Suspense, lazy, useState, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, UserPlus } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import styles from './NewEmployeeTab.module.css';

const AddEmployeeWizard = lazy(() => import('./AddEmployeeWizard').then(m => ({ default: m.AddEmployeeWizard })));

/**
 * Вкладка «Новый сотрудник»: единственная точка входа в мастер со сканами, когда
 * кадровый модуль включён. Сотрудника создаёт существующий POST /api/employees —
 * тот же запрос, что и прежняя модалка Sigur; мастер лишь добавляет к нему
 * распознавание документов и кадровый профиль.
 */
export const NewEmployeeTab: FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin, canViewPage } = useAuth();
  const [showWizard, setShowWizard] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const handleCreated = (employeeId: number): void => {
    setShowWizard(false);
    void queryClient.invalidateQueries({ queryKey: ['employees'] });
    // Карточка сотрудника закрыта правом /employees: у обладателя кадровых прав
    // без него переход обернулся бы редиректом, поэтому уходим только при доступе.
    if (isAdmin || canViewPage('/employees')) {
      navigate(`/employees/${employeeId}`, { state: { label: 'Управление кадрами', from: '/staff-control' } });
      return;
    }
    setCreatedId(employeeId);
  };

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>Приём нового сотрудника</h2>
      <p className={styles.hint}>
        Загрузите сканы документов — паспорт, патент, ИНН, СНИЛС и остальные распознаются
        автоматически, а поля анкеты заполнятся из них. Проверить и поправить всё можно
        перед созданием.
      </p>
      <ul className={styles.list}>
        <li>Набор документов подбирается по гражданству: для граждан РФ, ЕАЭС и по патенту он разный.</li>
        <li>Перед созданием выполняется проверка на дубли по СНИЛС, ИНН, паспорту и ФИО с датой рождения.</li>
        <li>Шаг с документами можно пропустить и добавить сканы позже — в карточке сотрудника, кнопка «Реквизиты».</li>
      </ul>

      {createdId !== null && (
        <div className={styles.done}>
          <CheckCircle2 size={16} />
          Сотрудник создан (#{createdId}), документы прикреплены.
        </div>
      )}

      <button type="button" className={styles.addBtn} onClick={() => { setCreatedId(null); setShowWizard(true); }}>
        <UserPlus size={16} />
        Добавить
      </button>

      {showWizard && (
        <Suspense fallback={null}>
          <AddEmployeeWizard onClose={() => setShowWizard(false)} onCreated={handleCreated} />
        </Suspense>
      )}
    </div>
  );
};
