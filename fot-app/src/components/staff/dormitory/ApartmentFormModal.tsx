import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  dormitoryService,
  type ICompanyApartment,
  type ICompanyApartmentPayload,
} from '../../../services/dormitoryService';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IApartmentFormModalProps {
  /** Передана — правка; нет — добавление. */
  apartment?: ICompanyApartment;
  onClose: () => void;
  onSaved: () => void;
}

type Field = 'address' | 'rooms' | 'places' | 'price' | 'paid_until';

/** Целое 1–99 или пусто; иначе — undefined (ошибка). */
const parseCount = (value: string): number | null | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,2}$/.test(trimmed) || Number(trimmed) === 0) return undefined;
  return Number(trimmed);
};

/** Рубли до копейки или пусто; иначе — undefined (ошибка). Пробелы и запятая допустимы: «65 000,00». */
const parsePrice = (value: string): number | null | undefined => {
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) return undefined;
  return Number(normalized);
};

/**
 * «Добавить квартиру» и ✎ на вкладке «Квартира» (миграция 371): адрес (без «Кв.» — его подставит система), пометка
 * («РФ \ ВНЖ», «семейная»), комнат, мест (справочно), цена аренды ₽/мес, «оплачено по». Новый адрес меняется и у
 * всех проживаний квартиры — «Зарплата» увидит его же.
 */
export const ApartmentFormModal: FC<IApartmentFormModalProps> = ({ apartment, onClose, onSaved }) => {
  const errorId = useId();
  const [address, setAddress] = useState(apartment?.address ?? '');
  const [note, setNote] = useState(apartment?.note ?? '');
  const [rooms, setRooms] = useState(apartment?.rooms?.toString() ?? '');
  const [places, setPlaces] = useState(apartment?.places?.toString() ?? '');
  const [price, setPrice] = useState(apartment?.price ? String(Number(apartment.price)) : '');
  const [paidUntil, setPaidUntil] = useState(apartment?.paid_until ?? '');
  const [error, setError] = useState<{ field: Field | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (field: Field | null, message: string) => setError({ field, message });
  const invalid = (field: Field): true | undefined => (error?.field === field ? true : undefined);

  const handleSubmit = async (requestClose: () => void) => {
    const cleanAddress = address.replace(/\s+/g, ' ').trim().replace(/^кв[.\s]\s*/i, '');
    if (!cleanAddress) { fail('address', 'Укажите адрес квартиры'); return; }
    const roomsValue = parseCount(rooms);
    if (roomsValue === undefined) { fail('rooms', 'Комнат — целое число от 1 до 99'); return; }
    const placesValue = parseCount(places);
    if (placesValue === undefined) { fail('places', 'Мест — целое число от 1 до 99'); return; }
    const priceValue = parsePrice(price);
    if (priceValue === undefined) { fail('price', 'Цена — сумма в рублях, до копеек'); return; }
    const payload: ICompanyApartmentPayload = {
      address: cleanAddress,
      note: note.replace(/\s+/g, ' ').trim() || null,
      rooms: roomsValue,
      places: placesValue,
      price: priceValue,
      paid_until: paidUntil || null,
    };
    setSaving(true);
    setError(null);
    try {
      if (apartment) await dormitoryService.updateApartment(apartment.id, payload);
      else await dormitoryService.addApartment(payload);
      onSaved();
      requestClose();
    } catch (err) {
      fail(null, err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={apartment ? 'Квартира' : 'Добавить квартиру'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
    >
      <label className={styles.field}>
        <span className={styles.label}>Адрес</span>
        <ClearableInput
          value={address}
          onValueChange={value => { setAddress(value); setError(null); }}
          maxLength={200}
          autoComplete="off"
          placeholder="Ляпидевского 12-58"
          disabled={saving}
          aria-invalid={invalid('address')}
          aria-describedby={error ? errorId : undefined}
          clearLabel="Очистить адрес"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Пометка</span>
        <ClearableInput
          value={note}
          onValueChange={value => { setNote(value); setError(null); }}
          maxLength={100}
          autoComplete="off"
          placeholder="семейная, РФ \ ВНЖ"
          disabled={saving}
          clearLabel="Очистить пометку"
        />
      </label>
      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Комнат</span>
          <ClearableInput
            value={rooms}
            onValueChange={value => { setRooms(value); setError(null); }}
            inputMode="numeric"
            maxLength={2}
            disabled={saving}
            aria-invalid={invalid('rooms')}
            clearLabel="Очистить «Комнат»"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Мест</span>
          <ClearableInput
            value={places}
            onValueChange={value => { setPlaces(value); setError(null); }}
            inputMode="numeric"
            maxLength={2}
            disabled={saving}
            aria-invalid={invalid('places')}
            clearLabel="Очистить «Мест»"
          />
        </label>
      </div>
      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Цена, ₽/мес</span>
          <ClearableInput
            value={price}
            onValueChange={value => { setPrice(value); setError(null); }}
            inputMode="decimal"
            maxLength={16}
            disabled={saving}
            aria-invalid={invalid('price')}
            clearLabel="Очистить цену"
          />
        </label>
        {/* Не <label>: внутри поля даты — кнопка календаря. */}
        <div className={styles.field}>
          <span className={styles.label}>Оплачено по</span>
          <DateInput
            value={paidUntil}
            onChange={value => { setPaidUntil(value); setError(null); }}
            className={styles.dateInput}
            disabled={saving}
          />
        </div>
      </div>
    </RegistryFormModal>
  );
};
