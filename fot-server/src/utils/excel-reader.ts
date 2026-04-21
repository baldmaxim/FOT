import ExcelJS from 'exceljs';

export async function readExcelRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const result: string[][] = [];

  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const rowData: string[] = [];
    const values = row.values as ExcelJS.CellValue[];
    for (let c = 1; c < values.length; c++) {
      const cell = worksheet.getCell(row.number, c);
      rowData.push(cell.text ?? '');
    }
    result.push(rowData);
  });

  return result;
}
