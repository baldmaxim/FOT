import { type FC, useState } from 'react';
import { useMtsBusinessAccounts, useUploadMtsBusinessDetalization } from '../../../hooks/useMtsBusinessData';
import { errText } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

/** Загрузка файла-детализации (XLS/XML) из МТС; из XML извлекаются ФИО. */
export const UploadSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const upload = useUploadMtsBusinessDetalization();
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const onUpload = async (): Promise<void> => {
    setMsg(null);
    if (!file) { setMsg({ ok: false, text: 'Выберите файл (XLS/XML)' }); return; }
    try {
      const r = await upload.mutateAsync({ file, accountId: accountId || undefined, msisdn: msisdn.trim() || undefined });
      const extra = r.autoLinked ? `, автопривязано к сотрудникам: ${r.autoLinked}` : '';
      setMsg({ ok: true, text: `Разобрано: ${r.parsed}, добавлено: ${r.inserted}, пропущено (дубли): ${r.skipped}${extra}` });
      setFile(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка обработки файла') });
    }
  };

  return (
    <>
      <p className={styles.hint}>
        Файл-отчёт из МТС (Excel или XML). Свой номер берётся из файла; привязка к лицевому счёту — для дашборда по ЛС.
        <b> Из XML дополнительно извлекаются ФИО владельцев номеров и автопривязываются к сотрудникам.</b>
      </p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Файл</label>
          <input className={styles.input} type="file" accept=".xls,.xlsx,.xml,application/vnd.ms-excel,text/xml,application/xml"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт (аккаунт)</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">— не привязывать —</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Номер (если не в файле)</label>
          <input className={styles.input} type="text" value={msisdn} onChange={e => setMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={onUpload} disabled={upload.isPending || !file}>Загрузить</button>
      </div>
      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
    </>
  );
};
