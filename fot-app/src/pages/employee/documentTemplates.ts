export interface IDocumentTemplate {
  url: string;
  fileName: string;
  title: string;
}

/** Бланки заявлений для скачивания (статика из fot-app/public/forms) */
export const DOCUMENT_TEMPLATES: IDocumentTemplate[] = [
  { url: '/forms/hire.docx', fileName: 'Заявление на приём.docx', title: 'Заявление на приём' },
  { url: '/forms/vacation.docx', fileName: 'Заявление на отпуск.docx', title: 'Заявление на отпуск' },
  { url: '/forms/unpaid-leave.docx', fileName: 'Отпуск за свой счёт.docx', title: 'Отпуск за свой счёт' },
  { url: '/forms/dismissal.docx', fileName: 'Заявление на увольнение.docx', title: 'Заявление на увольнение' },
  { url: '/forms/bypass-sheet-itr.xlsx', fileName: 'Обходной лист ИТР.xlsx', title: 'Обходной лист ИТР' },
  { url: '/forms/blank.docx', fileName: 'Бланк заявления.docx', title: 'Бланк пустого заявления' },
];
