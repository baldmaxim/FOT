import { type FC } from 'react';
import type { HrProfileInput, IHrCatalog, IHrFieldMeta } from '../../../types/hrProfile';
import { DATE_FIELDS, FIELD_PLACEHOLDERS, requiresPatentFor, visibleFields } from './hrFormat';
import styles from './HrProfileModal.module.css';

interface IHrProfileFormProps {
  catalog: IHrCatalog;
  value: HrProfileInput;
  onChange: (next: HrProfileInput) => void;
  /** Поля, подставленные из распознавания (подсветка «из документа»). */
  ocrFields?: Record<string, string>;
  /** Скрыть группу (например, в мастере ФИО задаётся отдельно). */
  hideGroups?: Array<IHrFieldMeta['group']>;
  disabled?: boolean;
}

const GROUP_ORDER: Array<IHrFieldMeta['group']> = ['personal', 'contacts', 'documents', 'patent', 'other'];

/** Форма полей профиля — одна на «Реквизиты» и мастер. Поля берутся из каталога сервера. */
export const HrProfileForm: FC<IHrProfileFormProps> = ({ catalog, value, onChange, ocrFields, hideGroups, disabled }) => {
  const requiresPatent = requiresPatentFor(catalog, value.citizenship_id, !!value.has_residence_permit);
  const fields = visibleFields(catalog.fields, requiresPatent);
  const set = (key: string, v: string | boolean | null) => onChange({ ...value, [key]: v });

  const renderField = (f: IHrFieldMeta) => {
    const key = f.key as keyof HrProfileInput;
    const raw = value[key];
    const fromOcr = ocrFields?.[f.key];
    const label = (
      <label htmlFor={`hr-${f.key}`}>
        {f.label}
        {fromOcr && <span className={styles.ocrTag} title={`Распознано из: ${fromOcr}`}>из документа</span>}
      </label>
    );
    if (f.key === 'has_residence_permit') {
      return (
        <div key={f.key} className={`${styles.field} ${styles.fieldCheck}`}>
          <label className={styles.checkLabel}>
            <input type="checkbox" checked={!!raw} disabled={disabled} onChange={e => set(f.key, e.target.checked)} />
            {f.label}
            <span className={styles.hint}>патент и КИГ не требуются</span>
          </label>
        </div>
      );
    }
    if (f.key === 'gender') {
      return (
        <div key={f.key} className={styles.field}>{label}
          <select id={`hr-${f.key}`} value={(raw as string) ?? ''} disabled={disabled} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">—</option><option value="male">Мужской</option><option value="female">Женский</option>
          </select>
        </div>
      );
    }
    if (f.key === 'passport_type') {
      return (
        <div key={f.key} className={styles.field}>{label}
          <select id={`hr-${f.key}`} value={(raw as string) ?? ''} disabled={disabled} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">—</option><option value="russian">Паспорт РФ</option><option value="foreign">Иностранного гражданина</option>
          </select>
        </div>
      );
    }
    if (f.key === 'citizenship_id' || f.key === 'birth_country_id') {
      return (
        <div key={f.key} className={styles.field}>{label}
          <select id={`hr-${f.key}`} value={(raw as string) ?? ''} disabled={disabled} onChange={e => set(f.key, e.target.value || null)}>
            <option value="">—</option>
            {catalog.citizenships.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      );
    }
    if (f.key === 'notes' || f.key === 'registration_address' || f.key === 'passport_issuer') {
      return (
        <div key={f.key} className={`${styles.field} ${styles.fieldWide}`}>{label}
          <textarea id={`hr-${f.key}`} rows={2} value={(raw as string) ?? ''} disabled={disabled} placeholder={FIELD_PLACEHOLDERS[f.key]} onChange={e => set(f.key, e.target.value || null)} />
        </div>
      );
    }
    return (
      <div key={f.key} className={styles.field}>{label}
        <input
          id={`hr-${f.key}`}
          type={DATE_FIELDS.has(f.key) ? 'date' : f.key === 'email' ? 'email' : 'text'}
          inputMode={['inn', 'snils', 'bank_account_number', 'bank_bik', 'phone'].includes(f.key) ? 'numeric' : undefined}
          value={(raw as string) ?? ''}
          disabled={disabled}
          placeholder={FIELD_PLACEHOLDERS[f.key]}
          autoComplete="off"
          onChange={e => set(f.key, e.target.value || null)}
        />
      </div>
    );
  };

  return (
    <div className={styles.form}>
      {GROUP_ORDER.filter(g => !hideGroups?.includes(g)).map(group => {
        const groupFields = fields.filter(f => f.group === group);
        if (groupFields.length === 0) return null;
        return (
          <section key={group} className={styles.formGroup}>
            <h4>{catalog.field_groups[group]}</h4>
            <div className={styles.formGrid}>{groupFields.map(renderField)}</div>
          </section>
        );
      })}
    </div>
  );
};
