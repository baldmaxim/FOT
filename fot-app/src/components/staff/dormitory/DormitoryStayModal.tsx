import { useId, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '../../../api/client';
import {
  DORMITORY_PENALTIES_KEY,
  dormitoryService,
  type DormitoryStayKind,
  type IDormitoryCandidate,
  type IDormitoryStay,
  type IDormitoryStayPayload,
} from '../../../services/dormitoryService';
import { penaltyCandidateNote } from '../../../utils/dormitoryPenalties';
import {
  DORMITORY_ADDRESS_MAX_LENGTH,
  DORMITORY_STAY_KIND_LABELS,
  parseDormitoryStay,
  type DormitoryStayField,
} from '../../../utils/dormitoryStayForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import { DormitorySelect } from './DormitorySelect';
import { PenaltyWarning } from './PenaltyWarning';

/** Заселение из «Зарплаты» («Справочник» → «Общежитие»): только общежитие, свои поиск и запись. */
export interface IDormitoryStayModalPayroll {
  search: (term: string, signal: AbortSignal) => Promise<IDormitoryCandidate[]>;
  add: (employeeId: number, payload: IDormitoryStayPayload) => Promise<IDormitoryStay>;
}

interface IDormitoryStayModalProps {
  /** Передано — правка этого проживания (сотрудник не меняется); нет — добавление. */
  stay?: IDormitoryStay;
  /** Названия общежитий справочника (миграция 377) — выбор общежития. */
  addresses: readonly string[];
  /** Общежитие по умолчанию при заселении (выбрано в селекте вкладки). */
  initialAddress?: string;
  /** Передано — заселение из «Зарплаты» (окно поверх таблицы «Справочника»); нет — вкладка кадров. */
  payroll?: IDormitoryStayModalPayroll;
  /** Вид задан вкладкой («Общежитие», «Компенсация аренды», миграция 371): переключателя нет. */
  fixedKind?: DormitoryStayKind;
  /** Заселение жильцом этой служебной квартиры: поля адреса нет, адрес — у квартиры. */
  apartment?: { id: number; title: string };
  /** Передано — в правке кнопка «Переселить…» (окно переселения вместо этого). */
  onMove?: () => void;
  /** Подпись «Переселить…»: у «Общежития» — только в другое общежитие. */
  moveLabel?: string;
  /** Передано — в правке своя ссылка под полями: «Приостановить компенсацию…» (окно поверх этого). */
  extraAction?: { label: string; onClick: () => void };
  /** Поверх другого окна (жильцы квартиры): оверлей выше. */
  raised?: boolean;
  /** Поле «Комментарий» (вкладка «Компенсация аренды»): сохраняется частичной правкой записи. */
  withComment?: boolean;
  /**
   * «Заселить» общежития (миграция 378): в подсказке поиска — пометка взысканий, после выбора — их список. Только
   * предупреждение: сохранить можно.
   */
  penaltyCheck?: boolean;
  onClose: () => void;
  onSaved: (stay: IDormitoryStay) => void;
}

const KINDS: DormitoryStayKind[] = ['dormitory', 'apartment'];
/** Как CHECK employee_dormitory_stay_comment (миграция 371). */
const COMMENT_MAX_LENGTH = 500;

/**
 * «Добавить сотрудника» и ✎ во вкладке «Проживание»: сотрудник (поиск по ФИО), вид (общежитие или квартира —
 * при правке не меняется), дата въезда, дата выезда (пусто — живёт). Общежитие — выбором из справочника (миграция
 * 377); квартира — адрес по желанию. Сумму квартиры кадры не задают: новой сервер ставит ставку
 * «Доплата за проживание», меняет её «Зарплата». Ошибка сервера — под полями, ввод не теряется. Из «Зарплаты»
 * (payroll) — только заселение в общежитие: без выбора вида, поиск и запись — «Справочника».
 */
export const DormitoryStayModal: FC<IDormitoryStayModalProps> = ({
  stay, addresses, initialAddress, payroll, fixedKind, apartment, onMove, moveLabel = 'Переселить в другое общежитие или квартиру…',
  extraAction, raised = false, withComment = false, penaltyCheck = false, onClose, onSaved,
}) => {
  const errorId = useId();
  const addressId = useId();
  const isEdit = stay !== undefined;
  /** Жилец служебной квартиры: адрес — у квартиры, здесь не меняется. */
  const flatAddress = apartment ? `Кв. ${apartment.title}` : (stay?.apartment_id ? stay.address : null);
  const [kind, setKind] = useState<DormitoryStayKind>(stay?.kind ?? fixedKind ?? 'dormitory');
  const [employee, setEmployee] = useState<IDormitoryCandidate | null>(null);
  const [checkIn, setCheckIn] = useState(stay?.check_in ?? '');
  const [checkOut, setCheckOut] = useState(stay?.check_out ?? '');
  const [address, setAddress] = useState(stay?.address ?? initialAddress ?? '');
  const [comment, setComment] = useState(stay?.comment ?? '');
  const isApartment = kind === 'apartment';
  const [error, setError] = useState<{ field: DormitoryStayField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const checkPenalties = penaltyCheck && !isEdit && employee !== null;
  const penaltyQuery = useQuery({
    queryKey: [...DORMITORY_PENALTIES_KEY, 'check', employee?.id ?? 0],
    queryFn: ({ signal }) => dormitoryService.checkPenalties(employee!.id, signal),
    enabled: checkPenalties,
    staleTime: 0,
  });

  const clearError = () => setError(null);
  const invalid = (field: DormitoryStayField): true | undefined => (error?.field === field ? true : undefined);
  const dateClass = (field: DormitoryStayField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  /** Адрес общежития в квартиру не переносится. */
  const changeKind = (next: DormitoryStayKind) => {
    if (next === kind) return;
    setKind(next);
    setAddress('');
    clearError();
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseDormitoryStay(
      { checkIn, checkOut, address: flatAddress ?? address },
      { required: !isEdit, selected: employee !== null },
      kind,
    );
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: IDormitoryStay;
      if (isEdit) saved = await dormitoryService.update(stay.id, parsed.payload);
      else if (payroll) saved = await payroll.add(employee!.id, parsed.payload);
      else saved = await dormitoryService.add(employee!.id, kind, parsed.payload, apartment?.id ?? null);
      const nextComment = comment.trim() || null;
      if (withComment && nextComment !== (saved.comment ?? null)) {
        saved = await dormitoryService.updateMeta(saved.id, { comment: nextComment });
      }
      onSaved(saved);
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? (flatAddress ? 'Квартира' : DORMITORY_STAY_KIND_LABELS[kind]) : apartment ? 'Заселить в квартиру' : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
      raised={payroll !== undefined || raised}
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        {isEdit ? (
          <div className={styles.fixed}>
            {/* Одним элементом: во flex-контейнере пробел перед «—» у отдельного span пропал бы. */}
            <span>
              {stay.full_name}
              {stay.department && <span className={styles.muted}> — {stay.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={payroll?.search ?? dormitoryService.searchEmployees}
            {...(penaltyCheck ? { note: penaltyCandidateNote } : {})}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
        {/* Подробности — по запросу; пока он идёт или не удался — заголовок по пометке из поиска (та же проверка). */}
        {checkPenalties && (penaltyQuery.data
          ? penaltyQuery.data.level && <PenaltyWarning match={penaltyQuery.data} />
          : employee?.penalty && <PenaltyWarning match={{ level: employee.penalty, items: [] }} />)}
      </div>

      {!isEdit && !payroll && !fixedKind && !apartment && (
        <div className={styles.field}>
          <div className={styles.segmented} role="group" aria-label="Где живёт">
            {KINDS.map(value => (
              <button
                key={value}
                type="button"
                className={styles.segment}
                aria-pressed={kind === value}
                onClick={() => changeKind(value)}
                disabled={saving}
              >
                {DORMITORY_STAY_KIND_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
      <div className={styles.dates}>
        <div className={styles.field}>
          <span className={styles.label}>Дата въезда</span>
          <DateInput
            value={checkIn}
            onChange={value => { setCheckIn(value); clearError(); }}
            className={dateClass('check_in')}
            disabled={saving}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Дата выезда</span>
          <DateInput
            value={checkOut}
            onChange={value => { setCheckOut(value); clearError(); }}
            className={dateClass('check_out')}
            disabled={saving}
          />
        </div>
      </div>

      {flatAddress ? (
        <div className={styles.field}>
          <span className={styles.label}>Квартира</span>
          <div className={styles.fixed}><span>{flatAddress}</span></div>
        </div>
      ) : isApartment ? (
        <label className={styles.field}>
          <span className={styles.label}>Адрес</span>
          <ClearableInput
            value={address}
            onValueChange={value => { setAddress(value); clearError(); }}
            maxLength={DORMITORY_ADDRESS_MAX_LENGTH}
            autoComplete="off"
            disabled={saving}
            aria-invalid={invalid('address')}
            aria-describedby={error ? errorId : undefined}
            clearLabel="Очистить адрес"
          />
        </label>
      ) : (
        <div className={styles.field}>
          <label htmlFor={addressId} className={styles.label}>Общежитие</label>
          <DormitorySelect
            id={addressId}
            options={addresses}
            value={address}
            onChange={value => { setAddress(value); clearError(); }}
            disabled={saving}
            invalid={invalid('address') === true}
            describedBy={error ? errorId : undefined}
          />
        </div>
      )}

      {withComment && (
        <label className={styles.field}>
          <span className={styles.label}>Комментарий</span>
          <ClearableInput
            value={comment}
            onValueChange={value => { setComment(value); clearError(); }}
            maxLength={COMMENT_MAX_LENGTH}
            autoComplete="off"
            disabled={saving}
            clearLabel="Очистить комментарий"
          />
        </label>
      )}

      {isEdit && onMove && (
        <button type="button" className={styles.linkButton} onClick={onMove} disabled={saving}>
          {moveLabel}
        </button>
      )}
      {isEdit && extraAction && (
        <button type="button" className={styles.linkButton} onClick={extraAction.onClick} disabled={saving}>
          {extraAction.label}
        </button>
      )}
    </RegistryFormModal>
  );
};
