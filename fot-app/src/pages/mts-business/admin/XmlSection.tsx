import { type FC, useMemo, useState } from 'react';
import {
  useMtsBusinessAccounts,
  useMtsBusinessRequests,
  useOrderMtsBusinessDetalization,
  useRefreshMtsBusinessStatus,
  useUploadMtsBusinessDetalization,
  useMtsBusinessUploadsCount,
  useClearMtsBusinessUploads,
} from '../../../hooks/useMtsBusinessData';
import { NumberFioPicker } from '../NumberFioPicker';
import { errText, toISODate, fmtLast } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const REQUEST_STATUS_LABELS: Record<string, string> = {
  completed: 'готово',
  in_progress: 'в обработке',
  faulted: 'ошибка',
  unknown: 'неизвестно',
};

/**
 * Детализация XML: заказ документа на почту по счёту (МТС формирует XML и шлёт
 * на email), статусы заявок и ручная загрузка файла (до 300 МБ). Дедуп при
 * загрузке — по dedup_hash в БД: записи, уже подтянутые API-синком, пропускаются
 * (файл дополняет БД, а не дублирует). «Очистить загруженный XML» — отладка,
 * удаляет только записи ручных загрузок (метка 'upload:%'), API-записи целы.
 */
export const XmlSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const requests = useMtsBusinessRequests(true);
  const order = useOrderMtsBusinessDetalization();
  const refreshStatus = useRefreshMtsBusinessStatus();
  const upload = useUploadMtsBusinessDetalization();
  const uploadsCount = useMtsBusinessUploadsCount(true);
  const clearUploads = useClearMtsBusinessUploads();

  const now = useMemo(() => new Date(), []);
  const active = (accounts.data ?? []).filter(a => a.isActive);

  // === Заказ на почту ===
  const [orderAccountId, setOrderAccountId] = useState('');
  const [scope, setScope] = useState<'msisdn' | 'account'>('msisdn');
  const [orderMsisdns, setOrderMsisdns] = useState<string[]>([]);
  const [orderFrom, setOrderFrom] = useState(toISODate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [orderTo, setOrderTo] = useState(toISODate(now));
  const [delivery, setDelivery] = useState('');
  const [orderMsg, setOrderMsg] = useState<Msg>(null);

  const effOrderAccountId = orderAccountId || active[0]?.id || '';
  const orderAccount = active.find(a => a.id === effOrderAccountId);

  const onOrder = async (): Promise<void> => {
    setOrderMsg(null);
    if (!effOrderAccountId) { setOrderMsg({ ok: false, text: 'Сначала добавьте аккаунт' }); return; }
    const targets = scope === 'account'
      ? [orderAccount?.accountNumber ?? ''].filter(Boolean)
      : orderMsisdns;
    if (targets.length === 0) {
      setOrderMsg({
        ok: false,
        text: scope === 'account'
          ? 'У выбранного аккаунта не заполнен номер лицевого счёта'
          : 'Выберите хотя бы один номер',
      });
      return;
    }
    try {
      const r = await order.mutateAsync({
        accountId: effOrderAccountId,
        scope,
        targets,
        dateFrom: orderFrom,
        dateTo: orderTo,
        deliveryAddress: delivery.trim(),
      });
      setOrderMsg({ ok: true, text: `Заявка принята МТС (ID ${r.messageId}) — XML придёт на почту, статус ниже в списке` });
    } catch (e) {
      setOrderMsg({ ok: false, text: errText(e, 'Ошибка заказа детализации (возможно нужен 2FA)') });
    }
  };

  // === Загрузка файла ===
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploadAccountId, setUploadAccountId] = useState('');
  const [uploadMsisdn, setUploadMsisdn] = useState('');
  const [uploadMsg, setUploadMsg] = useState<Msg>(null);

  const onUpload = async (): Promise<void> => {
    setUploadMsg(null);
    if (!file) { setUploadMsg({ ok: false, text: 'Выберите файл (XML/XLS)' }); return; }
    try {
      const r = await upload.mutateAsync({ file, accountId: uploadAccountId || undefined, msisdn: uploadMsisdn.trim() || undefined });
      const extra = r.autoLinked ? `, автопривязано к сотрудникам: ${r.autoLinked}` : '';
      setUploadMsg({ ok: true, text: `Разобрано: ${r.parsed}, добавлено: ${r.inserted}, пропущено (уже в БД): ${r.skipped}${extra}` });
      setFile(null);
      setFileInputKey(k => k + 1);
    } catch (e) {
      setUploadMsg({ ok: false, text: errText(e, 'Ошибка обработки файла (возможно нужен 2FA)') });
    }
  };

  const onClearUploads = async (): Promise<void> => {
    setUploadMsg(null);
    const n = uploadsCount.data?.count ?? 0;
    if (!window.confirm(`Удалить все записи, загруженные из файлов (${n})? Данные API-синхронизаций не затрагиваются.`)) return;
    try {
      const r = await clearUploads.mutateAsync();
      setUploadMsg({ ok: true, text: `Удалено записей: ${r.deleted}` });
    } catch (e) {
      setUploadMsg({ ok: false, text: errText(e, 'Ошибка очистки (возможно нужен 2FA)') });
    }
  };

  const uploadedTotal = uploadsCount.data?.count ?? 0;

  return (
    <>
      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 0 }}>Заказ XML на почту</h3>
      <p className={styles.hint}>
        МТС формирует XML-документ и отправляет на email. Пустой email — служебный ящик автозабора
        (файл подтянется автоматически).
      </p>
      <div className={styles.rowCompact}>
        <div className={styles.field}>
          <label className={styles.label}>Аккаунт</label>
          <select
            className={`${styles.select} ${styles.selectSm}`}
            style={{ minWidth: 180 }}
            value={orderAccountId}
            onChange={e => { setOrderAccountId(e.target.value); setOrderMsisdns([]); }}
          >
            <option value="">{active.length ? '— выберите —' : 'нет аккаунтов'}</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Что заказать</label>
          <select className={`${styles.select} ${styles.selectSm}`} value={scope} onChange={e => setScope(e.target.value as 'msisdn' | 'account')}>
            <option value="msisdn">По номерам</option>
            <option value="account">Весь лицевой счёт</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Период с</label>
          <input className={`${styles.input} ${styles.inputSm}`} type="date" value={orderFrom} onChange={e => setOrderFrom(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>по</label>
          <input className={`${styles.input} ${styles.inputSm}`} type="date" value={orderTo} onChange={e => setOrderTo(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Email доставки (необязательно)</label>
          <input
            className={`${styles.input} ${styles.inputSm}`}
            style={{ minWidth: 200 }}
            type="email"
            value={delivery}
            onChange={e => setDelivery(e.target.value)}
            placeholder="служебный ящик автозабора"
          />
        </div>
      </div>
      {scope === 'msisdn' && (
        <div className={styles.field} style={{ marginTop: 8 }}>
          <label className={styles.label}>Сотрудники / номера (по ФИО)</label>
          <NumberFioPicker accountId={effOrderAccountId} value={orderMsisdns} onChange={setOrderMsisdns} />
        </div>
      )}
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => { void onOrder(); }} disabled={order.isPending || active.length === 0}>
          {order.isPending ? 'Заказ…' : 'Заказать XML'}
        </button>
      </div>
      {orderMsg && <p className={orderMsg.ok ? styles.ok : styles.err}>{orderMsg.text}</p>}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 12 }}>Заявки</h3>
      {(requests.data ?? []).length === 0 ? (
        <p className={styles.hint}>Заявок нет.</p>
      ) : (
        <div>
          {(requests.data ?? []).map(r => (
            <div key={r.messageId} className={styles.schedRow}>
              <span>
                {fmtLast(r.requestedAt)} · {r.dateFrom}…{r.dateTo} · {r.scope === 'account' ? 'весь ЛС' : `номеров: ${r.targetCount}`}
              </span>
              <span className={styles.schedMeta}>
                <span className={`${styles.badge} ${r.status === 'completed' ? styles.badgeOk : r.status === 'faulted' ? styles.badgeErr : ''}`}>
                  {REQUEST_STATUS_LABELS[r.status] ?? r.status}
                </span>{' '}
                <button
                  className={styles.linkBtn}
                  onClick={() => { void refreshStatus.mutateAsync(r.messageId).catch(() => undefined); }}
                  disabled={refreshStatus.isPending}
                >
                  статус
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 12 }}>Загрузка файла (XML/XLS, до 300 МБ)</h3>
      <p className={styles.hint}>
        Дубли не создаются: записи, уже подтянутые синхронизацией, пропускаются — файл дополняет БД.
        Из XML извлекаются ФИО владельцев номеров и автопривязываются к сотрудникам.
      </p>
      <div className={styles.rowCompact}>
        <div className={styles.field}>
          <label className={styles.label}>Файл</label>
          <input
            key={fileInputKey}
            className={`${styles.input} ${styles.inputSm}`}
            type="file"
            accept=".xls,.xlsx,.xml,application/vnd.ms-excel,text/xml,application/xml"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт (аккаунт)</label>
          <select className={`${styles.select} ${styles.selectSm}`} value={uploadAccountId} onChange={e => setUploadAccountId(e.target.value)}>
            <option value="">— не привязывать —</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Номер (если не в файле)</label>
          <input
            className={`${styles.input} ${styles.inputSm}`}
            type="text"
            value={uploadMsisdn}
            onChange={e => setUploadMsisdn(e.target.value)}
            placeholder="79001234567"
          />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => { void onUpload(); }} disabled={upload.isPending || !file}>
          {upload.isPending ? 'Загрузка…' : 'Загрузить'}
        </button>
        <button
          className={styles.btnSecondary}
          onClick={() => { void onClearUploads(); }}
          disabled={clearUploads.isPending || uploadedTotal === 0}
          title="Удаляет только записи, загруженные из файлов; данные API-синхронизаций не затрагиваются"
        >
          {clearUploads.isPending ? 'Очистка…' : `Очистить загруженный XML (${uploadedTotal})`}
        </button>
      </div>
      {uploadMsg && <p className={uploadMsg.ok ? styles.ok : styles.err}>{uploadMsg.text}</p>}
    </>
  );
};
