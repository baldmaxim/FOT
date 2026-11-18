/**
 * Аргументы build-payouts-xml-sql.ts и их согласованность с видом выгрузки. Чистые функции — тестируются без БД.
 *
 * Выгрузка «ЗП к выплате» (payroll-1c-payouts.to-pay-xml.ts) не несёт вида выплаты и ИНН: --payment-method и
 * --organization-inn для неё обязательны, а для выгрузки ведомостей ЗУП запрещены (там они из файла). Сотрудник в ней —
 * только по коду физлица 1С, поэтому ручные решения (--link, --unmatched), перенос (--move-doc), исключение и замена
 * видов (--skip-method, --replace-method) с ней не принимаются.
 */
import * as path from 'node:path';

import { PAYOUT_XML_ORGANIZATION_INNS } from '../../src/services/payroll/payroll-1c-payouts.parser.js';
import type { PayoutXmlKind } from '../../src/services/payroll/payroll-1c-payouts.to-pay-xml.js';

export interface IXmlSqlArgs {
  files: string[]; month: string; skipMethods: string[]; replaceMethod: string | null; outDir: string; envFile: string;
  database: string; tag: string | null; moveDocs: string[]; links: string[]; unmatched: string[];
  /** Только для «ЗП к выплате». */
  paymentMethod: string | null;
  organizationInn: string | null;
}

/** Повторяемые флаги — списком, остальные — по одному разу. */
const REPEATABLE = ['--file', '--skip-method', '--move-doc', '--link', '--unmatched'] as const;
const SINGLE = [
  '--month', '--replace-method', '--out-dir', '--env-file', '--database', '--tag', '--payment-method', '--organization-inn',
] as const;

export const parseXmlSqlArgs = (argv: readonly string[], homeDir: string): IXmlSqlArgs => {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>(REPEATABLE.map(name => [name, []]));
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    const known = (REPEATABLE as readonly string[]).includes(name) || (SINGLE as readonly string[]).includes(name);
    if (!known || value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`Неизвестный или пустой аргумент «${name}»`);
    }
    if (values.has(name)) throw new Error(`«${name}» указан дважды`);
    const list = lists.get(name);
    if (list) list.push(value);
    else values.set(name, value);
  }
  const listOf = (name: (typeof REPEATABLE)[number]): string[] => lists.get(name) ?? [];
  const files = listOf('--file');
  const skipMethods = listOf('--skip-method');
  const month = values.get('--month');
  if (files.length === 0 || !month || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Нужны --file <xml> и --month YYYY-MM');
  const replaceMethod = values.get('--replace-method') ?? null;
  if (replaceMethod !== null && skipMethods.length > 0) throw new Error('--replace-method и --skip-method вместе не используются');
  const paymentMethod = values.get('--payment-method')?.trim() ?? null;
  const organizationInn = values.get('--organization-inn')?.trim() ?? null;
  if ((paymentMethod === null) !== (organizationInn === null)) {
    throw new Error('--payment-method и --organization-inn указываются вместе');
  }
  if (paymentMethod !== null && paymentMethod.length > 100) throw new Error('--payment-method: не длиннее 100 знаков');
  if (organizationInn !== null && !PAYOUT_XML_ORGANIZATION_INNS.includes(organizationInn)) {
    throw new Error(`--organization-inn ${organizationInn}: принимаются только ${PAYOUT_XML_ORGANIZATION_INNS.join(', ')}`);
  }
  return {
    files,
    month,
    skipMethods,
    replaceMethod,
    tag: values.get('--tag') ?? null,
    moveDocs: listOf('--move-doc'),
    links: listOf('--link'),
    unmatched: listOf('--unmatched'),
    outDir: values.get('--out-dir') ?? homeDir,
    envFile: values.get('--env-file') ?? path.join(homeDir, '.config', 'mcp', 'env'),
    database: values.get('--database') ?? 'FOT_Prod',
    paymentMethod,
    organizationInn,
  };
};

/** Флаги, которые не согласуются с видом выгрузки, — ошибка (все сразу). */
export const assertArgsForKind = (kind: PayoutXmlKind, args: IXmlSqlArgs): void => {
  const problems: string[] = [];
  if (kind === 'to_pay') {
    if (args.paymentMethod === null || args.organizationInn === null) {
      problems.push('выгрузка «ЗП к выплате» без вида выплаты и ИНН — нужны --payment-method и --organization-inn');
    }
    const forbidden: Array<[string, boolean]> = [
      ['--move-doc', args.moveDocs.length > 0],
      ['--link', args.links.length > 0],
      ['--unmatched', args.unmatched.length > 0],
      ['--skip-method', args.skipMethods.length > 0],
      ['--replace-method', args.replaceMethod !== null],
    ];
    for (const [flag, used] of forbidden) {
      if (used) problems.push(`${flag} не применяется к выгрузке «ЗП к выплате» (сотрудник — только по id_all)`);
    }
  } else if (args.paymentMethod !== null || args.organizationInn !== null) {
    problems.push('--payment-method и --organization-inn — только для выгрузки «ЗП к выплате»: в ведомостях ЗУП они из файла');
  }
  if (problems.length > 0) throw new Error(`Аргументы не подходят к файлам:\n  ${problems.join('\n  ')}`);
};
