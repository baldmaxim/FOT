import { describe, it, expect } from 'vitest';
import {
  buildChangePersonalDataBody,
  parsePersonalDataInfo,
  parsePersonalDataFull,
  normalizePersonalDataStatus,
  type IPersonalDataInput,
} from './mts-business-personal-data.service.js';

// Чистые функции контракта PersonalData/ChangePersonalData (§5.12
// MTS_BUSINESS_API_INTEGRATION.md) — без сети и БД.

const RU_INPUT: IPersonalDataInput = {
  surName: 'Иванов',
  firstName: 'Иван',
  secondName: 'Иванович',
  gender: 'Male',
  birthday: '1990-01-01',
  birthPlace: 'Москва',
  citizenship: 'RU',
  document: {
    series: '1234',
    number: '567890',
    dateIssued: '2010-01-01',
    issuer: 'ОВД Тест',
    issuerCode: '770-000',
  },
  address: {
    region: 'Москва',
    city: 'Москва',
    street: 'Тверская',
    home: '1',
    apartment: '2',
    zip: '101000',
  },
};

describe('buildChangePersonalDataBody', () => {
  it('гражданин РФ: DocumentType 21, Country RU, адрес строго «Россия», MessageId в SubscriberInformation', () => {
    const body = buildChangePersonalDataBody('79001234567', RU_INPUT, 'msg-guid-1') as {
      request: { Items: Array<Record<string, unknown>> };
      SubscriberInformation: Record<string, unknown>;
    };

    expect(body.SubscriberInformation).toEqual({
      MessageId: 'msg-guid-1',
      ReplyToURL: 'DB:',
      SubscriberName: 'MobileAPI',
      OperatorType: 'MTSBusinessAPI',
    });
    expect(body.request.Items).toHaveLength(1);

    const item = body.request.Items[0] as { Msisdn: string; UserData: Record<string, unknown> };
    expect(item.Msisdn).toBe('79001234567');

    const ud = item.UserData;
    expect(ud.Action).toBe('Create');
    expect(ud.LegalCategory).toEqual({ Code: '1' });
    expect(ud.Birthday).toBe('1990-01-01T00:00:00');
    expect(ud.Gender).toBe('Male');
    expect(ud.IsEntrepreneur).toBe(false);

    const ident = (ud.Identifications as Array<Record<string, unknown>>)[0];
    expect(ident.DocumentType).toEqual({ Code: '21' });
    expect(ident.Country).toEqual({ Code: 'RU' });
    expect(ident.DocumentSeries).toBe('1234');
    expect(ident.DocumentNumber).toBe('567890');
    expect(ident.DateIssued).toBe('2010-01-01T00:00:00');
    expect(ident.IssuerCode).toBe('770-000');

    const addr = (ud.Addresses as Array<Record<string, unknown>>)[0];
    expect(addr.Country).toBe('Россия'); // «РФ»/«Российская Федерация» МТС отклоняет
    expect(addr.AddressTypes).toBe('RegAddress');
    expect(addr.Zip).toBe('101000');

    const name = (ud.Names as Array<Record<string, unknown>>)[0];
    expect(name).toEqual({
      Action: 'Create', FirstName: 'Иван', SecondName: 'Иванович', SurName: 'Иванов', Language: { Code: '1' },
    });
  });

  it('иностранный гражданин: DocumentType 10, страна из документа, без адреса и IssuerCode', () => {
    const input: IPersonalDataInput = {
      surName: 'Ivanov', firstName: 'Ivan',
      gender: 'Male', birthday: '1990-01-01',
      citizenship: 'FOREIGN',
      document: { number: '123456', dateIssued: '2020-01-01', countryCode: 'UZ', issuer: 'Issuer' },
    };
    const body = buildChangePersonalDataBody('79001234567', input, 'msg-guid-2') as {
      request: { Items: Array<{ UserData: Record<string, unknown> }> };
    };
    const ud = body.request.Items[0].UserData;
    const ident = (ud.Identifications as Array<Record<string, unknown>>)[0];
    expect(ident.DocumentType).toEqual({ Code: '10' });
    expect(ident.Country).toEqual({ Code: 'UZ' });
    expect(ident.IssuerCode).toBeUndefined();
    expect(ident.DocumentSeries).toBeUndefined();
    expect(ud.Addresses).toBeUndefined();
    const name = (ud.Names as Array<Record<string, unknown>>)[0];
    expect(name.SecondName).toBe(''); // отчества нет — пустая строка, как в примере МТС
  });

  it('удаление: Items без UserData', () => {
    const body = buildChangePersonalDataBody('79001234567', null, 'msg-guid-3') as {
      request: { Items: Array<Record<string, unknown>> };
    };
    expect(body.request.Items).toEqual([{ Msisdn: '79001234567' }]);
  });
});

describe('parsePersonalDataInfo', () => {
  it('основная схема: ФИО в name, статус в characteristic', () => {
    const resp = [{
      name: 'Иванов Иван Иванович',
      characteristic: [
        { name: 'SomethingElse', value: 'x' },
        { name: 'PersonalDataConfirmation', value: 'Activated' },
      ],
    }];
    expect(parsePersonalDataInfo(resp)).toEqual({
      fullName: 'Иванов Иван Иванович',
      confirmationStatus: 'Activated',
    });
  });

  it('fallback-схема: SurName/FirstName/SecondName', () => {
    const resp = [{ SurName: 'Иванов', FirstName: 'Иван', SecondName: 'Иванович' }];
    expect(parsePersonalDataInfo(resp).fullName).toBe('Иванов Иван Иванович');
  });

  it('пустой ответ (персданные не внесены) — null-поля, не ошибка', () => {
    expect(parsePersonalDataInfo([])).toEqual({ fullName: null, confirmationStatus: null });
    expect(parsePersonalDataInfo(null)).toEqual({ fullName: null, confirmationStatus: null });
  });

  it('статус без ФИО (Anonymous)', () => {
    const resp = [{ characteristic: [{ name: 'PersonalDataConfirmation', value: 'Anonymous' }] }];
    expect(parsePersonalDataInfo(resp)).toEqual({ fullName: null, confirmationStatus: 'Anonymous' });
  });

  it('плейсхолдер «null null» из МТС (корп. SIM без владельца) → fullName null', () => {
    expect(parsePersonalDataInfo([{ name: 'null null' }]).fullName).toBeNull();
    expect(parsePersonalDataInfo([{ name: 'NULL' }]).fullName).toBeNull();
    expect(parsePersonalDataInfo([{ name: '  undefined   undefined ' }]).fullName).toBeNull();
    // реальное имя не трогаем
    expect(parsePersonalDataInfo([{ name: 'Нуллинов Пётр' }]).fullName).toBe('Нуллинов Пётр');
  });
});

describe('parsePersonalDataFull', () => {
  it('форма ответа PersonalDataInfo: ФИО, дата рождения, документ, статус', () => {
    const resp = [{
      name: 'Иванов Иван Иванович',
      birthDate: '1990-01-01',
      identifiedBy: [{
        type: 'IdentityDocument',
        documentType: 'Паспорт РФ',
        documentSeries: '1234',
        documentNo: '567890',
        issuedBy: 'ОВД Тест',
        issuedDate: '2010-01-01',
        issuingCountry: 'RU',
      }],
      characteristic: [{ name: 'PersonalDataConfirmation', value: 'Activated' }],
    }];
    expect(parsePersonalDataFull(resp)).toEqual({
      fullName: 'Иванов Иван Иванович',
      birthDate: '1990-01-01',
      confirmationStatus: 'Activated',
      documents: [{
        documentType: 'Паспорт РФ',
        documentSeries: '1234',
        documentNo: '567890',
        issuedBy: 'ОВД Тест',
        issuedDate: '2010-01-01',
        issuingCountry: 'RU',
      }],
    });
  });

  it('корп. SIM без владельца («null null», без документов) → пустой профиль', () => {
    const resp = [{ name: 'null null', characteristic: [{ name: 'PersonalDataConfirmation', value: 'Anonymous' }] }];
    expect(parsePersonalDataFull(resp)).toEqual({
      fullName: null, birthDate: null, confirmationStatus: 'Anonymous', documents: [],
    });
  });

  it('пустой ответ — все поля пустые, не ошибка', () => {
    expect(parsePersonalDataFull([])).toEqual({
      fullName: null, birthDate: null, confirmationStatus: null, documents: [],
    });
  });
});

describe('normalizePersonalDataStatus', () => {
  it.each([
    ['Completed', 'completed'],
    ['SUCCESS', 'completed'],
    ['InProgress', 'in_progress'],
    ['WaitingForCheck', 'in_progress'],
    ['Faulted', 'faulted'],
    ['Rejected', 'faulted'],
    ['Отказ', 'faulted'],
    ['что-то новое', 'unknown'],
    [null, 'unknown'],
  ] as const)('%s → %s', (raw, expected) => {
    expect(normalizePersonalDataStatus(raw)).toBe(expected);
  });
});
