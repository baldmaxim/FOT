import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import { dormitoryService, type IDormitory, type IDormitoryPayload } from '../../../services/dormitoryService';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IDormitoryFormModalProps {
  /** Передано — правка; нет — добавление. */
  dormitory?: IDormitory;
  onClose: () => void;
  onSaved: () => void;
}

type Field = 'address' | 'doc_number' | 'place_price';

/** Как CHECK dormitory_address_doc_number (миграция 377). */
const DOC_NUMBER_MAX_LENGTH = 30;

/** Рубли до копейки или пусто; иначе — undefined (ошибка). Пробелы и запятая допустимы: «550,00». */
const parsePrice = (value: string): number | null | undefined => {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) return undefined;
  return Number(normalized);
};

const squeeze = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * «Добавить общежитие» и ✎ в справочнике общежитий (миграция 377) — как «Общежития» 1С: Общежитие (название / адрес,
 * обязательно), Дата, Номер, Стоимость места (₽, только для информации). Новое название меняется и у всех записей
 * общежития. Ошибка сервера — под полями, ввод не теряется.
 */
export const DormitoryFormModal: FC<IDormitoryFormModalProps> = ({ dormitory, onClose, onSaved }) => {
  const errorId = useId();
  const [address, setAddress] = useState(dormitory?.address ?? '');
  const [docDate, setDocDate] = useState(dormitory?.doc_date ?? '');
  const [docNumber, setDocNumber] = useState(dormitory?.doc_number ?? '');
  const [price, setPrice] = useState(dormitory?.place_price ? String(Number(dormitory.place_price)).replace('.', ',') : '');
  const [error, setError] = useState<{ field: Field | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (field: Field | null, message: string) => setError({ field, message });
  const invalid = (field: Field): true | undefined => (error?.field === field ? true : undefined);

  const handleSubmit = async (requestClose: () => void) => {
    const name = squeeze(address);
    if (!name) { fail('address', 'Укажите общежитие'); return; }
    if (/^кв[.\s]/i.test(name)) { fail('address', 'Служебные квартиры ведут во вкладке «Квартира»'); return; }
    const priceValue = parsePrice(price);
    if (priceValue === undefined) { fail('place_price', 'Стоимость места — сумма в рублях, до копеек'); return; }
    const payload: IDormitoryPayload = {
      address: name,
      doc_date: docDate || null,
      doc_number: squeeze(docNumber) || null,
      place_price: priceValue,
    };
    if (dormitory && name !== dormitory.address
      && !window.confirm(`Переименовать «${dormitory.address}» в «${name}»? Название сменится и у всех, кто там жил.`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (dormitory) await dormitoryService.updateDormitory(dormitory.id, payload);
      else await dormitoryService.addDormitory(payload);
      onSaved();
      requestClose();
    } catch (err) {
      fail(null, err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={dormitory ? 'Общежитие' : 'Добавить общежитие'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
      raised
    >
      <label className={styles.field}>
        <span className={styles.label}>Общежитие</span>
        <ClearableInput
          value={address}
          onValueChange={value => { setAddress(value); setError(null); }}
          maxLength={200}
          autoComplete="off"
          placeholder="Общ. Свободы 35"
          disabled={saving}
          aria-invalid={invalid('address')}
          aria-describedby={error ? errorId : undefined}
          clearLabel="Очистить название общежития"
        />
      </label>
      <div className={styles.dates}>
        {/* Не <label>: внутри поля даты — кнопка календаря. */}
        <div className={styles.field}>
          <span className={styles.label}>Дата</span>
          <DateInput
            value={docDate}
            onChange={value => { setDocDate(value); setError(null); }}
            className={styles.dateInput}
            disabled={saving}
          />
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Номер</span>
          <ClearableInput
            value={docNumber}
            onValueChange={value => { setDocNumber(value); setError(null); }}
            maxLength={DOC_NUMBER_MAX_LENGTH}
            autoComplete="off"
            placeholder="000000004"
            disabled={saving}
            aria-invalid={invalid('doc_number')}
            clearLabel="Очистить номер"
          />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Стоимость места, ₽</span>
        <ClearableInput
          value={price}
          onValueChange={value => { setPrice(value); setError(null); }}
          inputMode="decimal"
          maxLength={16}
          disabled={saving}
          aria-invalid={invalid('place_price')}
          aria-describedby={error ? errorId : undefined}
          clearLabel="Очистить стоимость места"
        />
      </label>
    </RegistryFormModal>
  );
};
