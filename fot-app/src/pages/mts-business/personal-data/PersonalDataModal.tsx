import { type FC, type ReactElement, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useMtsBusinessPersonalData,
  useSubmitMtsBusinessPersonalData,
  useDeleteMtsBusinessPersonalData,
} from '../../../hooks/useMtsBusinessPersonalData';
import type { IMtsPdInfo, IMtsPdPerson } from '../../../services/mtsBusinessPersonalDataService';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { PersonalDataStatusBadge } from './PersonalDataStatusBadge';
import { PD_COUNTRIES } from './countries';
import { errText } from '../mtsBusinessFormat';
import s from './PersonalDataModal.module.css';

interface IFormState {
  citizenship: 'RU' | 'FOREIGN';
  surName: string;
  firstName: string;
  secondName: string;
  gender: 'Male' | 'Female';
  birthday: string;
  birthPlace: string;
  docSeries: string;
  docNumber: string;
  docDateIssued: string;
  docIssuer: string;
  docIssuerCode: string;
  docCountryCode: string;
  addrRegion: string;
  addrCity: string;
  addrStreet: string;
  addrHome: string;
  addrApartment: string;
  addrZip: string;
}

const EMPTY_FORM: IFormState = {
  citizenship: 'RU',
  surName: '', firstName: '', secondName: '',
  gender: 'Male', birthday: '', birthPlace: '',
  docSeries: '', docNumber: '', docDateIssued: '', docIssuer: '', docIssuerCode: '', docCountryCode: 'UZ',
  addrRegion: '', addrCity: '', addrStreet: '', addrHome: '', addrApartment: '', addrZip: '',
};

/** Автоформат кода подразделения: цифры → ХХХ-ХХХ. */
const formatIssuerCode = (raw: string): string => {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
};

const splitFio = (fio: string): { surName: string; firstName: string; secondName: string } => {
  const parts = fio.replace(/\s+/g, ' ').trim().split(' ');
  return { surName: parts[0] ?? '', firstName: parts[1] ?? '', secondName: parts.slice(2).join(' ') };
};

/** Префилл формы: привязанный сотрудник → иначе ФИО из МТС → пустая форма. */
const buildInitialForm = (info: IMtsPdInfo): IFormState => {
  const emp = info.employee;
  if (emp && (emp.lastName || emp.firstName)) {
    return {
      ...EMPTY_FORM,
      surName: emp.lastName ?? '',
      firstName: emp.firstName ?? '',
      secondName: emp.middleName ?? '',
      birthday: emp.birthDate ? emp.birthDate.slice(0, 10) : '',
      citizenship: emp.country && !/росс/i.test(emp.country) ? 'FOREIGN' : 'RU',
    };
  }
  if (info.fullName) {
    return { ...EMPTY_FORM, ...splitFio(info.fullName) };
  }
  return EMPTY_FORM;
};

const validate = (f: IFormState): Record<string, string> => {
  const e: Record<string, string> = {};
  if (!f.surName.trim()) e.surName = 'Укажите фамилию';
  if (!f.firstName.trim()) e.firstName = 'Укажите имя';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.birthday)) e.birthday = 'Укажите дату рождения';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.docDateIssued)) e.docDateIssued = 'Укажите дату выдачи';
  if (f.citizenship === 'RU') {
    if (!/^\d{4}$/.test(f.docSeries)) e.docSeries = 'Серия — 4 цифры';
    if (!/^\d{6}$/.test(f.docNumber)) e.docNumber = 'Номер — 6 цифр';
    if (!/^\d{3}-\d{3}$/.test(f.docIssuerCode)) e.docIssuerCode = 'Код — формат ХХХ-ХХХ';
    if (!f.addrRegion.trim()) e.addrRegion = 'Укажите регион';
    if (!f.addrCity.trim()) e.addrCity = 'Укажите город';
    if (!f.addrStreet.trim()) e.addrStreet = 'Укажите улицу';
    if (!f.addrHome.trim()) e.addrHome = 'Укажите дом';
    if (!/^\d{6}$/.test(f.addrZip)) e.addrZip = 'Индекс — 6 цифр';
  } else {
    if (!f.docNumber.trim()) e.docNumber = 'Укажите номер документа';
    if (!f.docCountryCode) e.docCountryCode = 'Выберите страну';
  }
  return e;
};

const toPerson = (f: IFormState): IMtsPdPerson => ({
  surName: f.surName.trim(),
  firstName: f.firstName.trim(),
  secondName: f.secondName.trim() || undefined,
  gender: f.gender,
  birthday: f.birthday,
  birthPlace: f.birthPlace.trim() || undefined,
  citizenship: f.citizenship,
  document: {
    series: f.docSeries.trim() || undefined,
    number: f.docNumber.trim(),
    dateIssued: f.docDateIssued,
    issuer: f.docIssuer.trim() || undefined,
    issuerCode: f.citizenship === 'RU' ? f.docIssuerCode.trim() : undefined,
    countryCode: f.citizenship === 'FOREIGN' ? f.docCountryCode : undefined,
  },
  address: f.citizenship === 'RU'
    ? {
        region: f.addrRegion.trim(),
        city: f.addrCity.trim(),
        street: f.addrStreet.trim(),
        home: f.addrHome.trim(),
        apartment: f.addrApartment.trim() || undefined,
        zip: f.addrZip.trim(),
      }
    : undefined,
});

/**
 * Внесение/изменение персональных данных пользователя номера. Форма ТРАНЗИТНАЯ:
 * данные уходят напрямую в МТС и не сохраняются на портале; после отправки
 * пользователю номера приходит SMS, подтверждение — через Госуслуги.
 */
/** Внутренняя форма: состояние инициализируется из загруженного info (без эффектов). */
const PdForm: FC<{ msisdn: string; info: IMtsPdInfo; onClose: () => void }> = ({ msisdn, info: pdInfo, onClose }) => {
  const submitM = useSubmitMtsBusinessPersonalData();
  const deleteM = useDeleteMtsBusinessPersonalData();

  const [form, setForm] = useState<IFormState>(() => buildInitialForm(pdInfo));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sentMessageId, setSentMessageId] = useState<string | null>(null);

  const set = <K extends keyof IFormState>(key: K, value: IFormState[K]): void => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => {
      if (!(key in e)) return e;
      const rest = { ...e };
      delete rest[key];
      return rest;
    });
  };

  const isRu = form.citizenship === 'RU';
  const busy = submitM.isPending || deleteM.isPending;

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    const e = validate(form);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      const { messageId } = await submitM.mutateAsync({ msisdn, person: toPerson(form) });
      setSentMessageId(messageId);
    } catch (err) {
      setSubmitError(errText(err, 'Ошибка отправки (возможно нужен 2FA)'));
    }
  };

  const onDelete = async (): Promise<void> => {
    setSubmitError(null);
    if (!window.confirm(`Удалить персональные данные пользователя номера ${msisdn} на стороне МТС? Потребуется 2FA.`)) return;
    try {
      const { messageId } = await deleteM.mutateAsync(msisdn);
      setSentMessageId(messageId);
    } catch (err) {
      setSubmitError(errText(err, 'Ошибка удаления (возможно нужен 2FA)'));
    }
  };

  const field = (
    key: keyof IFormState,
    label: string,
    props: { type?: string; placeholder?: string; format?: (v: string) => string } = {},
  ): ReactElement => (
    <div className={s.field}>
      <label className={s.label}>{label}</label>
      <input
        className={s.input}
        type={props.type ?? 'text'}
        value={form[key] as string}
        placeholder={props.placeholder}
        disabled={busy}
        onChange={e => set(key, (props.format ? props.format(e.target.value) : e.target.value) as IFormState[typeof key])}
      />
      {errors[key] && <span className={s.fieldErr}>{errors[key]}</span>}
    </div>
  );

  const statusLine = pdInfo.unavailable ? null : (
    <div className={s.statusLine}>
      <span className={s.statusLabel}>Сейчас в МТС:</span>
      <span>{pdInfo.fullName ?? 'ФИО не внесены'}</span>
      <PersonalDataStatusBadge status={pdInfo.confirmationStatus ?? null} />
    </div>
  );

  return (
    <>
        {sentMessageId ? (
          <div className={s.done}>
            <div className={s.doneTitle}>Заявка отправлена в МТС</div>
            <p className={s.doneText}>
              Идентификатор заявки: <code>{sentMessageId}</code>. Пользователю номера придёт SMS —
              данные подтверждаются через Госуслуги. Статус в карточке абонента обновится
              автоматически (фоновая проверка каждые несколько минут).
            </p>
            <button className={s.btn} onClick={onClose}>Закрыть</button>
          </div>
        ) : (
          <>
            <div className={s.warn}>
              Данные передаются напрямую в МТС и <b>не сохраняются на портале</b>. После отправки пользователю
              номера придёт SMS; подтверждение — через Госуслуги. Отправка требует 2FA.
            </div>

            {pdInfo.unavailable && <UnavailableNotice />}
            {statusLine}

            <div className={s.segment}>
              <button
                className={`${s.segBtn} ${isRu ? s.segBtnActive : ''}`}
                disabled={busy}
                onClick={() => set('citizenship', 'RU')}
              >
                Гражданин РФ
              </button>
              <button
                className={`${s.segBtn} ${!isRu ? s.segBtnActive : ''}`}
                disabled={busy}
                onClick={() => set('citizenship', 'FOREIGN')}
              >
                Иностранный гражданин
              </button>
            </div>

            <div className={s.row}>
              {field('surName', 'Фамилия')}
              {field('firstName', 'Имя')}
              {field('secondName', 'Отчество')}
            </div>
            <div className={s.row}>
              <div className={s.field}>
                <label className={s.label}>Пол</label>
                <div className={s.segment}>
                  <button className={`${s.segBtn} ${form.gender === 'Male' ? s.segBtnActive : ''}`} disabled={busy} onClick={() => set('gender', 'Male')}>Мужской</button>
                  <button className={`${s.segBtn} ${form.gender === 'Female' ? s.segBtnActive : ''}`} disabled={busy} onClick={() => set('gender', 'Female')}>Женский</button>
                </div>
              </div>
              {field('birthday', 'Дата рождения', { type: 'date' })}
              {field('birthPlace', 'Место рождения', { placeholder: 'г. Москва' })}
            </div>

            <h4 className={s.groupTitle}>{isRu ? 'Паспорт РФ' : 'Документ иностранного гражданина (тип 10)'}</h4>
            <div className={s.row}>
              {isRu
                ? field('docSeries', 'Серия', { placeholder: '1234', format: v => v.replace(/\D/g, '').slice(0, 4) })
                : field('docSeries', 'Серия (если есть)', { placeholder: 'AB' })}
              {field('docNumber', 'Номер', isRu ? { placeholder: '567890', format: v => v.replace(/\D/g, '').slice(0, 6) } : { placeholder: '123456' })}
              {field('docDateIssued', 'Дата выдачи', { type: 'date' })}
            </div>
            <div className={s.row}>
              {field('docIssuer', 'Кем выдан', { placeholder: isRu ? 'ОВД …' : 'Орган выдачи' })}
              {isRu
                ? field('docIssuerCode', 'Код подразделения', { placeholder: '770-000', format: formatIssuerCode })
                : (
                  <div className={s.field}>
                    <label className={s.label}>Страна документа</label>
                    <select className={s.input} value={form.docCountryCode} disabled={busy} onChange={e => set('docCountryCode', e.target.value)}>
                      {PD_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                    {errors.docCountryCode && <span className={s.fieldErr}>{errors.docCountryCode}</span>}
                  </div>
                )}
            </div>

            {isRu && (
              <>
                <h4 className={s.groupTitle}>Адрес регистрации (Россия)</h4>
                <div className={s.row}>
                  {field('addrRegion', 'Регион', { placeholder: 'Москва' })}
                  {field('addrCity', 'Город', { placeholder: 'Москва' })}
                  {field('addrZip', 'Индекс', { placeholder: '000000', format: v => v.replace(/\D/g, '').slice(0, 6) })}
                </div>
                <div className={s.row}>
                  {field('addrStreet', 'Улица', { placeholder: 'Тверская' })}
                  {field('addrHome', 'Дом', { placeholder: '1' })}
                  {field('addrApartment', 'Квартира', { placeholder: '1' })}
                </div>
              </>
            )}

            {submitError && <p className={s.err}>{submitError}</p>}

            <div className={s.actions}>
              <button className={s.btn} onClick={() => { void onSubmit(); }} disabled={busy}>
                {submitM.isPending ? 'Отправка…' : 'Отправить в МТС'}
              </button>
              <button className={s.btnSecondary} onClick={onClose} disabled={busy}>Отмена</button>
              <button className={s.btnDanger} onClick={() => { void onDelete(); }} disabled={busy}>
                Удалить данные в МТС
              </button>
            </div>
          </>
        )}
    </>
  );
};

/**
 * Внесение/изменение персональных данных пользователя номера. Форма ТРАНЗИТНАЯ:
 * данные уходят напрямую в МТС и не сохраняются на портале; после отправки
 * пользователю номера приходит SMS, подтверждение — через Госуслуги.
 */
export const PersonalDataModal: FC<{ msisdn: string; onClose: () => void }> = ({ msisdn, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const info = useMtsBusinessPersonalData(msisdn);

  return (
    <div className={s.overlay} {...overlay}>
      <div className={s.modal}>
        <div className={s.header}>
          <h3 className={s.title}>Персональные данные · {msisdn}</h3>
          <button className={s.close} onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        {info.isLoading && <p className={s.hint}>Загрузка текущего статуса…</p>}
        {info.isError && <p className={s.err}>Не удалось получить данные номера.</p>}
        {info.data && <PdForm msisdn={msisdn} info={info.data} onClose={onClose} />}
      </div>
    </div>
  );
};
