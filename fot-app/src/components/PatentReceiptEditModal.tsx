import { type FC, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Save, RefreshCw } from 'lucide-react';
import {
  patentReceiptService,
  type IPatentReceiptDetail,
  type IPatentReceiptPatch,
  type PaymentMethod,
} from '../services/patentReceiptService';
import { settingsService, type IOpenRouterModelInfo } from '../services/settingsService';
import styles from './PatentReceiptEditModal.module.css';

interface IProps {
  receiptId: number;
  onClose: () => void;
  onSaved?: () => void;
}

interface IFormState {
  payment_date: string;
  payment_amount: string;
  commission: string;
  total_amount: string;
  payer_full_name: string;
  payer_inn: string;
  payer_passport: string;
  document_number: string;
  patent_number: string;
  patent_issue_date: string;
  kbk: string;
  oktmo: string;
  uin: string;
  recipient_name: string;
  recipient_inn: string;
  recipient_kpp: string;
  recipient_bank_bic: string;
  recipient_account: string;
  payer_bank_name: string;
  payment_method: PaymentMethod;
  needs_review: boolean;
}

const toForm = (r: IPatentReceiptDetail): IFormState => ({
  payment_date: r.payment_date || '',
  payment_amount: r.payment_amount || '',
  commission: r.commission || '',
  total_amount: r.total_amount || '',
  payer_full_name: r.payer_full_name || '',
  payer_inn: r.payer_inn || '',
  payer_passport: r.payer_passport || '',
  document_number: r.document_number || '',
  patent_number: r.patent_number || '',
  patent_issue_date: r.patent_issue_date || '',
  kbk: r.kbk || '',
  oktmo: r.oktmo || '',
  uin: r.uin || '',
  recipient_name: r.recipient_name || '',
  recipient_inn: r.recipient_inn || '',
  recipient_kpp: r.recipient_kpp || '',
  recipient_bank_bic: r.recipient_bank_bic || '',
  recipient_account: r.recipient_account || '',
  payer_bank_name: r.payer_bank_name || '',
  payment_method: (r.payment_method as PaymentMethod) ?? null,
  needs_review: r.needs_review,
});

const toPatch = (form: IFormState): IPatentReceiptPatch => ({
  payment_date: form.payment_date || null,
  payment_amount: form.payment_amount ? Number(form.payment_amount) : null,
  commission: form.commission ? Number(form.commission) : null,
  total_amount: form.total_amount ? Number(form.total_amount) : null,
  payer_full_name: form.payer_full_name || null,
  payer_inn: form.payer_inn || null,
  payer_passport: form.payer_passport || null,
  document_number: form.document_number || null,
  patent_number: form.patent_number || null,
  patent_issue_date: form.patent_issue_date || null,
  kbk: form.kbk || null,
  oktmo: form.oktmo || null,
  uin: form.uin || null,
  recipient_name: form.recipient_name || null,
  recipient_inn: form.recipient_inn || null,
  recipient_kpp: form.recipient_kpp || null,
  recipient_bank_bic: form.recipient_bank_bic || null,
  recipient_account: form.recipient_account || null,
  payer_bank_name: form.payer_bank_name || null,
  payment_method: form.payment_method,
  needs_review: form.needs_review,
});

export const PatentReceiptEditModal: FC<IProps> = ({ receiptId, onClose, onSaved }) => {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['patent-receipt', receiptId],
    queryFn: () => patentReceiptService.get(receiptId),
  });

  const orSettingsQuery = useQuery({
    queryKey: ['openrouter-settings'],
    queryFn: () => settingsService.getOpenRouterSettings(),
  });

  const [form, setForm] = useState<IFormState | null>(null);
  const [overrideModel, setOverrideModel] = useState<string>('');

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (patch: IPatentReceiptPatch) => patentReceiptService.update(receiptId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patent-receipts'] });
      void queryClient.invalidateQueries({ queryKey: ['patent-receipt', receiptId] });
      onSaved?.();
    },
  });

  const recognizeMutation = useMutation({
    mutationFn: () => patentReceiptService.recognize(data!.document_id, overrideModel || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patent-receipts'] });
      void queryClient.invalidateQueries({ queryKey: ['patent-receipt', receiptId] });
    },
  });

  const update = (key: keyof IFormState, value: string | boolean | null) => {
    setForm(prev => (prev ? { ...prev, [key]: value as never } : prev));
  };

  const handleSave = () => {
    if (!form) return;
    saveMutation.mutate(toPatch(form));
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Чек НДФЛ за патент</h3>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {isLoading || !data || !form ? (
          <div className={styles.empty}>Загрузка…</div>
        ) : (
          <div className={styles.body}>
            <div className={styles.left}>
              {data.documents?.mime_type?.startsWith('image/') && data.download_url ? (
                <img src={data.download_url} alt="чек" className={styles.preview} />
              ) : data.download_url ? (
                <iframe title="receipt" src={data.download_url} className={styles.previewFrame} />
              ) : (
                <div className={styles.previewPlaceholder}>Превью недоступно</div>
              )}
              {data.download_url && (
                <a href={data.download_url} target="_blank" rel="noreferrer" className={styles.downloadLink}>
                  Открыть оригинал
                </a>
              )}
              <div className={styles.metaBox}>
                <div><span>Модель:</span> {data.recognition_model || '—'}</div>
                <div><span>Уверенность:</span> {data.confidence ? Number(data.confidence).toFixed(2) : '—'}</div>
                <div><span>Цена распознавания:</span> {data.cost_usd ? `$${Number(data.cost_usd).toFixed(5)}` : '—'}</div>
                <div><span>Источник:</span> {data.source_type || '—'}</div>
                {data.manually_edited && <div className={styles.manualTag}>Правлено вручную</div>}
              </div>
              <div className={styles.recognizeBox}>
                <select value={overrideModel} onChange={e => setOverrideModel(e.target.value)}>
                  <option value="">Текущая ({orSettingsQuery.data?.model || '—'})</option>
                  {(orSettingsQuery.data?.allowedModels || []).map((m: IOpenRouterModelInfo) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button
                  className={styles.btnSecondary}
                  onClick={() => recognizeMutation.mutate()}
                  disabled={recognizeMutation.isPending}
                >
                  <RefreshCw size={14} /> {recognizeMutation.isPending ? 'Распознаём…' : 'Распознать заново'}
                </button>
              </div>
              {recognizeMutation.isSuccess && recognizeMutation.data && !recognizeMutation.data.ok && (
                <div className={styles.errorMsg}>Ошибка: {recognizeMutation.data.error}</div>
              )}
            </div>

            <div className={styles.right}>
              <div className={styles.formGrid}>
                <Field label="Дата платежа" type="date" value={form.payment_date} onChange={v => update('payment_date', v)} />
                <Field label="Сумма ₽" type="number" value={form.payment_amount} onChange={v => update('payment_amount', v)} />
                <Field label="Комиссия ₽" type="number" value={form.commission} onChange={v => update('commission', v)} />
                <Field label="Итого ₽" type="number" value={form.total_amount} onChange={v => update('total_amount', v)} />

                <Field label="Плательщик (ФИО)" value={form.payer_full_name} onChange={v => update('payer_full_name', v)} fullWidth />
                <Field label="Паспорт" value={form.payer_passport} onChange={v => update('payer_passport', v)} />
                <Field label="ИНН плательщика" value={form.payer_inn} onChange={v => update('payer_inn', v)} />
                <Field label="№ операции" value={form.document_number} onChange={v => update('document_number', v)} />
                <Field label="УИН" value={form.uin} onChange={v => update('uin', v)} />

                <Field label="№ патента" value={form.patent_number} onChange={v => update('patent_number', v)} />
                <Field label="Дата выдачи патента" type="date" value={form.patent_issue_date} onChange={v => update('patent_issue_date', v)} />
                <Field label="КБК" value={form.kbk} onChange={v => update('kbk', v)} />
                <Field label="ОКТМО" value={form.oktmo} onChange={v => update('oktmo', v)} />

                <Field label="Получатель" value={form.recipient_name} onChange={v => update('recipient_name', v)} fullWidth />
                <Field label="ИНН получателя" value={form.recipient_inn} onChange={v => update('recipient_inn', v)} />
                <Field label="КПП получателя" value={form.recipient_kpp} onChange={v => update('recipient_kpp', v)} />
                <Field label="БИК получателя" value={form.recipient_bank_bic} onChange={v => update('recipient_bank_bic', v)} />
                <Field label="Счёт получателя" value={form.recipient_account} onChange={v => update('recipient_account', v)} />

                <Field label="Банк плательщика" value={form.payer_bank_name} onChange={v => update('payer_bank_name', v)} fullWidth />

                <label className={styles.field}>
                  <span>Способ оплаты</span>
                  <select
                    value={form.payment_method ?? ''}
                    onChange={e => update('payment_method', (e.target.value || null) as PaymentMethod)}
                  >
                    <option value="">—</option>
                    <option value="cash">Наличные</option>
                    <option value="card">Карта</option>
                    <option value="transfer">Перевод</option>
                  </select>
                </label>

                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={form.needs_review}
                    onChange={e => update('needs_review', e.target.checked)}
                  />
                  <span>Требует проверки</span>
                </label>
              </div>
            </div>
          </div>
        )}

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>Закрыть</button>
          <button
            className={styles.btnPrimary}
            onClick={handleSave}
            disabled={saveMutation.isPending || !form}
          >
            <Save size={14} /> {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface IFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  fullWidth?: boolean;
}

const Field: FC<IFieldProps> = ({ label, value, onChange, type = 'text', fullWidth }) => (
  <label className={`${styles.field} ${fullWidth ? styles.fieldFull : ''}`}>
    <span>{label}</span>
    <input type={type} value={value} onChange={e => onChange(e.target.value)} />
  </label>
);
