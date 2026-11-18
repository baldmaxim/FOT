import { describe, expect, it } from 'vitest';

import { assertArgsForKind, parseXmlSqlArgs } from '../../../scripts/lib/payouts-xml-args.js';

// Аргументы генератора build-payouts-xml-sql.ts: вид выплаты и ИНН — только для выгрузки «ЗП к выплате» и обязательны
// для неё; флаги ведомостей ЗУП (перенос, ручные решения, исключение и замена видов) с ней не принимаются.

const BASE = ['--file', '/x/a.xml', '--month', '2026-10'];
const TO_PAY = [...BASE, '--payment-method', 'Зарплата за месяц', '--organization-inn', '7736255508'];

describe('аргументы генератора выплат из XML', () => {
  it('разбор: вид и ИНН, умолчания каталогов и базы', () => {
    const args = parseXmlSqlArgs([...TO_PAY, '--tag', 'zp-k-vyplate'], '/home/u');
    expect(args).toMatchObject({
      files: ['/x/a.xml'], month: '2026-10', tag: 'zp-k-vyplate', paymentMethod: 'Зарплата за месяц', organizationInn: '7736255508',
      outDir: '/home/u', envFile: '/home/u/.config/mcp/env', database: 'FOT_Prod',
    });
    expect(parseXmlSqlArgs(BASE, '/home/u')).toMatchObject({ paymentMethod: null, organizationInn: null });
  });

  it('стоп: вид без ИНН и наоборот, чужой ИНН, неизвестный флаг', () => {
    expect(() => parseXmlSqlArgs([...BASE, '--payment-method', 'Премии'], '/h')).toThrow(/указываются вместе/);
    expect(() => parseXmlSqlArgs([...BASE, '--organization-inn', '7736255508'], '/h')).toThrow(/указываются вместе/);
    expect(() => parseXmlSqlArgs([...BASE, '--payment-method', 'Премии', '--organization-inn', '1234567890'], '/h'))
      .toThrow(/--organization-inn 1234567890: принимаются только/);
    expect(() => parseXmlSqlArgs([...BASE, '--inn', '7736255508'], '/h')).toThrow(/Неизвестный или пустой аргумент «--inn»/);
  });

  it('«ЗП к выплате»: вид и ИНН обязательны; перенос, ручные решения, исключение и замена видов — нет', () => {
    expect(() => assertArgsForKind('to_pay', parseXmlSqlArgs(TO_PAY, '/h'))).not.toThrow();
    expect(() => assertArgsForKind('to_pay', parseXmlSqlArgs(BASE, '/h'))).toThrow(/нужны --payment-method и --organization-inn/);
    for (const extra of [['--move-doc', '1'], ['--link', 'Иванов=5'], ['--unmatched', 'Иванов'], ['--skip-method', 'Премии'],
      ['--replace-method', 'Премии']]) {
      expect(() => assertArgsForKind('to_pay', parseXmlSqlArgs([...TO_PAY, ...extra], '/h')))
        .toThrow(new RegExp(`${extra[0]} не применяется к выгрузке «ЗП к выплате»`));
    }
  });

  it('ведомости ЗУП: вид и ИНН из файла — флаги запрещены', () => {
    expect(() => assertArgsForKind('zup_month', parseXmlSqlArgs(BASE, '/h'))).not.toThrow();
    expect(() => assertArgsForKind('zup_month', parseXmlSqlArgs(TO_PAY, '/h'))).toThrow(/только для выгрузки «ЗП к выплате»/);
  });
});
