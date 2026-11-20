import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './DormitoryTab.module.css';

interface IEmployeeCardLinkProps {
  employeeId: number;
  fullName: string;
  /** Куда вернуться из карточки: вкладка «Проживания» и месяц. */
  backPath: string;
}

/**
 * ФИО в таблицах «Проживания» — ссылкой на карточку сотрудника (там «Реквизиты» с документами). Кнопка, а не <a>:
 * переход — с состоянием «назад» (как «Текущие сотрудники»), клик не открывает окно строки. Показывают только тем,
 * кому доступна карточка (/employees).
 */
export const EmployeeCardLink: FC<IEmployeeCardLinkProps> = ({ employeeId, fullName, backPath }) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={styles.employeeLink}
      onClick={event => {
        event.stopPropagation();
        navigate(`/employees/${employeeId}`, { state: { label: 'Управление кадрами', from: backPath } });
      }}
      title="Открыть карточку сотрудника"
    >
      {fullName}
    </button>
  );
};
