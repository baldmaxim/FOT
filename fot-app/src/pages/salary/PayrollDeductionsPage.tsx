import { useRef, useState, type FC } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { PAYROLL_CALC_COLUMNS_KEY } from '../../utils/payrollColumns';
import { PayrollDictionaryModal } from '../../components/salary/PayrollDictionaryModal';
import { PayrollEmployeeModal } from '../../components/salary/PayrollEmployeeModal';
import { CompensationTermsPage } from './CompensationTermsPage';
import styles from './PayrollDeductionsPage.module.css';

interface IPayrollDeductionsPageProps {
  /** Дата выборки условий — та же, что у «Условий оплаты». */
  date: string;
  /** «Расчёты» на экране. Скрытые не размонтируются: фильтры и прокрутка сохраняются. */
  active: boolean;
  /** Карточку сотрудника сохранили в окне: его карточка «Подробно» (если открыта) устарела. */
  onSaved: (employeeId: number) => void;
}

/**
 * «Зарплата → Расчёты»: таблица штата как у «Условий оплаты» (без галочек и «Назначить выделенным»).
 * Рядом с шестерёнкой — «Справочник»: виды удержаний и ставки. Клик по строке — окно с карточкой
 * сотрудника: только там вносятся компенсации, доплаты и удержания.
 */
export const PayrollDeductionsPage: FC<IPayrollDeductionsPageProps> = ({ date, active, onSaved }) => {
  const [employee, setEmployee] = useState<IPayrollTermsRow | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const dictionaryButtonRef = useRef<HTMLButtonElement>(null);

  // Уход с «Расчётов» (другая вкладка, «Назад» браузера) закрывает окна: они поверх страницы, скрытие
  // экрана их не прячет. Паттерн «состояние из прошлого рендера» вместо setState-в-effect.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active) {
      setDictionaryOpen(false);
      setEmployee(null);
    }
  }

  /** Закрытие возвращает фокус на кнопку — клавиатура не теряет место. */
  const closeDictionary = () => {
    setDictionaryOpen(false);
    dictionaryButtonRef.current?.focus();
  };

  return (
    <>
      <CompensationTermsPage
        date={date}
        active={active}
        onOpenEmployee={setEmployee}
        selectable={false}
        hiddenColumnsKey={PAYROLL_CALC_COLUMNS_KEY}
        actionsExtra={(
          <button
            ref={dictionaryButtonRef}
            type="button"
            className={styles.dictionaryButton}
            aria-haspopup="dialog"
            onClick={() => setDictionaryOpen(true)}
          >
            Справочник
          </button>
        )}
      />

      {dictionaryOpen && <PayrollDictionaryModal onClose={closeDictionary} />}

      {employee && (
        <PayrollEmployeeModal
          key={employee.employee_id}
          row={employee}
          defaultDate={date}
          onClose={() => setEmployee(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
};
