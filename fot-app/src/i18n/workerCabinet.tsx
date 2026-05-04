import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';

export type WorkerLocale = 'ru' | 'tg' | 'uz';

export const WORKER_LOCALES: ReadonlyArray<{ code: WorkerLocale; label: string }> = [
  { code: 'ru', label: 'Рус' },
  { code: 'tg', label: 'Тоҷ' },
  { code: 'uz', label: 'Uzb' },
];

const STORAGE_KEY = 'workerCabinetLocale';

type Dict = Record<string, string>;

const ru: Dict = {
  'preview.banner.title': 'Режим предпросмотра (super_admin)',
  'preview.banner.hint': 'Вы видите кабинет рабочего. Все действия выполняются от имени вашего учёта super_admin и привязанного employee_id.',
  'notLinked.title': 'Аккаунт не привязан к сотруднику',
  'notLinked.hint': 'Обратитесь к администратору — загрузка чека от патента пока недоступна.',
  'profile.label.employee': 'Сотрудник',
  'profile.label.department': 'Отдел',
  'profile.label.site': 'Участок',
  'profile.label.hireDate': 'Дата приёма на работу',
  'profile.loading': 'Загрузка…',
  'patent.label.expiry': 'Срок действия патента',
  'patent.helper.notSet': 'Срок патента не указан.',
  'patent.helper.expired': 'Срок истёк {n} дн. назад. Обновите патент как можно скорее.',
  'patent.helper.expiresToday': 'Срок истекает сегодня. Обновите патент.',
  'patent.helper.expiresSoon': 'Осталось {n} дн. Не забудьте обновить.',
  'patent.helper.daysLeft': 'Осталось {n} дн.',
  'patent.button.upload': 'Загрузить чек от патента',
  'patent.button.uploading': 'Загрузка…',
  'receipts.title': 'Мои чеки от патента',
  'receipts.empty': 'Пока нет загруженных чеков.',
  'receipts.loading': 'Загрузка…',
  'receipts.label.paymentDate': 'Дата платежа: {value}',
  'receipts.label.uploaded': 'Загружено: {value}',
  'receipts.label.period': 'Период: {from} — {to}',
  'receipts.openOriginal': 'Открыть оригинал',
  'recognition.pending': 'В очереди',
  'recognition.processing': 'Распознаётся…',
  'recognition.done': 'Распознан',
  'recognition.needsReview': 'Требует проверки',
  'recognition.failed': 'Ошибка распознавания',
  'logout': 'Выйти из системы',
  'language.label': 'Язык',
  'upload.modal.title': 'Загрузка чека от патента',
  'upload.modal.periodHint': 'Укажите период, за который оплачен патент (с какого по какое число).',
  'upload.modal.periodFrom': 'С (начало периода)',
  'upload.modal.periodTo': 'По (конец периода)',
  'upload.modal.fileLabel': 'Файл чека',
  'upload.modal.selectFile': 'Выбрать файл (фото или PDF)',
  'upload.modal.changeFile': 'Сменить файл',
  'upload.modal.errorPeriodOrder': 'Дата «по» должна быть не раньше даты «с».',
  'upload.modal.errorMissing': 'Заполните период и выберите файл чека.',
  'upload.modal.cancel': 'Отмена',
  'upload.modal.submit': 'Загрузить',
  'status.uploading.title': 'Загружаем чек на сервер…',
  'status.uploading.subtitle': 'Пожалуйста, не закрывайте страницу.',
  'status.uploaded.title': 'Чек загружен',
  'status.uploaded.subtitle': 'Идёт проверка. Чек появится в списке после распознавания.',
  'status.error.title': 'Не удалось загрузить',
  'status.error.subtitleDefault': 'Попробуйте ещё раз.',
  'status.close': 'Закрыть',
  'toast.error.employeeLoad': 'Не удалось загрузить данные сотрудника',
  'toast.error.receiptsLoad': 'Не удалось загрузить чеки',
  'toast.error.uploadFailed': 'Не удалось загрузить чек',
};

const tg: Dict = {
  'preview.banner.title': 'Реҷаи пешнамоиш (super_admin)',
  'preview.banner.hint': 'Шумо кабинети коргарро мебинед. Ҳамаи амалҳо аз номи ҳисоби super_admin ва employee_id-и пайвасташуда иҷро мешаванд.',
  'notLinked.title': 'Ҳисоб ба коргар пайваст карда нашудааст',
  'notLinked.hint': 'Ба маъмур муроҷиат кунед — ҳоло боргузории чек аз патент дастрас нест.',
  'profile.label.employee': 'Коргар',
  'profile.label.department': 'Шуъба',
  'profile.label.site': 'Қитъа',
  'profile.label.hireDate': 'Санаи қабул ба кор',
  'profile.loading': 'Боргирӣ…',
  'patent.label.expiry': 'Мӯҳлати амали патент',
  'patent.helper.notSet': 'Мӯҳлати патент муайян нашудааст.',
  'patent.helper.expired': 'Мӯҳлат {n} рӯз пеш ба охир расид. Патентро ҳарчи зудтар нав кунед.',
  'patent.helper.expiresToday': 'Мӯҳлат имрӯз ба охир мерасад. Патентро нав кунед.',
  'patent.helper.expiresSoon': '{n} рӯз боқӣ мондааст. Навсозиро фаромӯш накунед.',
  'patent.helper.daysLeft': '{n} рӯз боқӣ мондааст.',
  'patent.button.upload': 'Чеки патентро бор кунед',
  'patent.button.uploading': 'Боргузорӣ…',
  'receipts.title': 'Чекҳои патенти ман',
  'receipts.empty': 'Ҳоло чек боргузорӣ нашудааст.',
  'receipts.loading': 'Боргирӣ…',
  'receipts.label.paymentDate': 'Санаи пардохт: {value}',
  'receipts.label.uploaded': 'Боргузорӣ: {value}',
  'receipts.label.period': 'Давра: {from} — {to}',
  'receipts.openOriginal': 'Кушодани асл',
  'recognition.pending': 'Дар навбат',
  'recognition.processing': 'Шинохта мешавад…',
  'recognition.done': 'Шинохта шуд',
  'recognition.needsReview': 'Тафтиш лозим аст',
  'recognition.failed': 'Хатои шинохт',
  'logout': 'Баромадан аз система',
  'language.label': 'Забон',
  'upload.modal.title': 'Боргузории чеки патент',
  'upload.modal.periodHint': 'Давраро нишон диҳед, ки барои он патент пардохт шудааст (аз кадом то кадом сана).',
  'upload.modal.periodFrom': 'Аз (оғози давра)',
  'upload.modal.periodTo': 'То (анҷоми давра)',
  'upload.modal.fileLabel': 'Файли чек',
  'upload.modal.selectFile': 'Файлро интихоб кунед (акс ё PDF)',
  'upload.modal.changeFile': 'Файлро иваз кунед',
  'upload.modal.errorPeriodOrder': 'Санаи «то» бояд аз санаи «аз» барвақтар набошад.',
  'upload.modal.errorMissing': 'Давраро пур кунед ва файли чекро интихоб кунед.',
  'upload.modal.cancel': 'Бекор кардан',
  'upload.modal.submit': 'Боргузорӣ',
  'status.uploading.title': 'Чек ба сервер боргузорӣ мешавад…',
  'status.uploading.subtitle': 'Лутфан, саҳифаро напӯшонед.',
  'status.uploaded.title': 'Чек боргузорӣ шуд',
  'status.uploaded.subtitle': 'Тафтиш меравад. Чек пас аз шинохт дар рӯйхат пайдо мешавад.',
  'status.error.title': 'Боргузорӣ нашуд',
  'status.error.subtitleDefault': 'Боз як бор кӯшиш кунед.',
  'status.close': 'Пӯшидан',
  'toast.error.employeeLoad': 'Маълумоти коргарро бор карда натавонистем',
  'toast.error.receiptsLoad': 'Чекҳоро бор карда натавонистем',
  'toast.error.uploadFailed': 'Чекро бор карда натавонистем',
};

const uz: Dict = {
  'preview.banner.title': 'Koʻrib chiqish rejimi (super_admin)',
  'preview.banner.hint': 'Siz ishchi kabinetini koʻrasiz. Barcha amallar sizning super_admin hisobingiz va bogʻlangan employee_id nomidan bajariladi.',
  'notLinked.title': 'Hisob xodimga bogʻlanmagan',
  'notLinked.hint': 'Administratorga murojaat qiling — hozircha patent chekini yuklash imkoni yoʻq.',
  'profile.label.employee': 'Xodim',
  'profile.label.department': 'Boʻlim',
  'profile.label.site': 'Uchastka',
  'profile.label.hireDate': 'Ishga qabul sanasi',
  'profile.loading': 'Yuklanmoqda…',
  'patent.label.expiry': 'Patent amal qilish muddati',
  'patent.helper.notSet': 'Patent muddati koʻrsatilmagan.',
  'patent.helper.expired': 'Muddat {n} kun oldin tugagan. Patentni iloji boricha tezroq yangilang.',
  'patent.helper.expiresToday': 'Muddat bugun tugaydi. Patentni yangilang.',
  'patent.helper.expiresSoon': '{n} kun qoldi. Yangilashni unutmang.',
  'patent.helper.daysLeft': '{n} kun qoldi.',
  'patent.button.upload': 'Patent chekini yuklash',
  'patent.button.uploading': 'Yuklanmoqda…',
  'receipts.title': 'Mening patent cheklarim',
  'receipts.empty': 'Hozircha yuklangan cheklar yoʻq.',
  'receipts.loading': 'Yuklanmoqda…',
  'receipts.label.paymentDate': 'Toʻlov sanasi: {value}',
  'receipts.label.uploaded': 'Yuklangan: {value}',
  'receipts.label.period': 'Davr: {from} — {to}',
  'receipts.openOriginal': 'Asl nusxani ochish',
  'recognition.pending': 'Navbatda',
  'recognition.processing': 'Tanib olinmoqda…',
  'recognition.done': 'Tanib olindi',
  'recognition.needsReview': 'Tekshirish kerak',
  'recognition.failed': 'Tanib olishda xatolik',
  'logout': 'Tizimdan chiqish',
  'language.label': 'Til',
  'upload.modal.title': 'Patent chekini yuklash',
  'upload.modal.periodHint': 'Patent qaysi davr uchun toʻlanganini koʻrsating (qaysi sanadan qaysi sanagacha).',
  'upload.modal.periodFrom': 'Dan (davr boshi)',
  'upload.modal.periodTo': 'Gacha (davr oxiri)',
  'upload.modal.fileLabel': 'Chek fayli',
  'upload.modal.selectFile': 'Faylni tanlang (rasm yoki PDF)',
  'upload.modal.changeFile': 'Faylni almashtirish',
  'upload.modal.errorPeriodOrder': '«Gacha» sanasi «dan» sanasidan oldin boʻlmasligi kerak.',
  'upload.modal.errorMissing': 'Davrni toʻldiring va chek faylini tanlang.',
  'upload.modal.cancel': 'Bekor qilish',
  'upload.modal.submit': 'Yuklash',
  'status.uploading.title': 'Chek serverga yuklanmoqda…',
  'status.uploading.subtitle': 'Iltimos, sahifani yopmang.',
  'status.uploaded.title': 'Chek yuklandi',
  'status.uploaded.subtitle': 'Tekshiruv ketmoqda. Chek tanib olingach roʻyxatda paydo boʻladi.',
  'status.error.title': 'Yuklab boʻlmadi',
  'status.error.subtitleDefault': 'Qayta urinib koʻring.',
  'status.close': 'Yopish',
  'toast.error.employeeLoad': 'Xodim maʼlumotlarini yuklab boʻlmadi',
  'toast.error.receiptsLoad': 'Cheklarni yuklab boʻlmadi',
  'toast.error.uploadFailed': 'Chekni yuklab boʻlmadi',
};

const DICTS: Record<WorkerLocale, Dict> = { ru, tg, uz };

interface IWorkerLocaleContext {
  locale: WorkerLocale;
  setLocale: (locale: WorkerLocale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const WorkerLocaleContext = createContext<IWorkerLocaleContext | null>(null);

const isWorkerLocale = (value: unknown): value is WorkerLocale =>
  value === 'ru' || value === 'tg' || value === 'uz';

const readInitialLocale = (): WorkerLocale => {
  if (typeof window === 'undefined') return 'ru';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isWorkerLocale(stored)) return stored;
  } catch {
    /* ignore */
  }
  return 'ru';
};

const interpolate = (template: string, params?: Record<string, string | number>): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    const v = params[name];
    return v === undefined || v === null ? '' : String(v);
  });
};

export const WorkerLocaleProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<WorkerLocale>(() => readInitialLocale());

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
  }, [locale]);

  const setLocale = useCallback((next: WorkerLocale) => setLocaleState(next), []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    const dict = DICTS[locale] || ru;
    const template = dict[key] ?? ru[key] ?? key;
    return interpolate(template, params);
  }, [locale]);

  const value = useMemo<IWorkerLocaleContext>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return (
    <WorkerLocaleContext.Provider value={value}>
      {children}
    </WorkerLocaleContext.Provider>
  );
};

export const useWorkerLocale = (): IWorkerLocaleContext => {
  const ctx = useContext(WorkerLocaleContext);
  if (!ctx) throw new Error('useWorkerLocale must be used within WorkerLocaleProvider');
  return ctx;
};
