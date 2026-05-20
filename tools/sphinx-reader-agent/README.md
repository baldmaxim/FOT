# Sphinx Reader Agent

Локальный USB-агент настольного ридера выдачи карт **«Сфинкс»** (Sphinx Reader
SDK Rev20). Полный аналог агента **Sigur Reader EH**: читает Wiegand-26 со
считывателя и пробрасывает его в портал ФОТ через `ws://localhost:8765`.

Контракт WS идентичен Sigur Reader EH, поэтому **правок фронта/бэка не требуется**
(потребитель — `fot-app/src/hooks/useCardReader.ts`; поиск карты — через реестр
Sigur, как и раньше). Один агент за раз держит порт `8765`: оператор запускает
тот, чей считыватель физически подключён.

## ⚠️ 32-битный процесс — обязательно

`vendor/spnxreader.dll` — **PE32 (x86)**. Грузить её можно только из
**32-битного** Node:

- зависимости ставить 32-битным Node: `node-v*-win-x86`;
- упаковка: `npm run pkg` (таргет `node18-win-x86`).

На x64-Node `koffi.load` упадёт — это ожидаемо; WS-сервер при этом поднимется
и отдаст статус «Драйвер не загружен» (удобно для отладки контракта).

## Состав

```
src/contract.js     WS-сообщения (паритет с Sigur Reader EH)
src/sphinx-sdk.js    FFI koffi → spnxreader.dll (см. SIGNATURES.md)
src/reader-loop.js   open→poll→decode→debounce, reopen с бэк-оффом
src/server.js        WS-сервер 127.0.0.1:8765 (только loopback)
src/index.js         точка входа, окно статуса (консоль)
vendor/              spnxreader.dll + FTD2XX.dll (из Debug20.7z)
config.json          порт, endianness W26, таймаут опроса, debounce
SIGNATURES.md        как восстановлены сигнатуры DLL (реверс)
```

## Запуск (32-битный Node)

```bash
npm install
npm start
```

## Сборка дистрибутива

```bash
npm run pkg          # → dist/sphinx-reader-agent.exe (node18-win-x86)
```

Рядом с `.exe` должны лежать `vendor/spnxreader.dll`, `vendor/FTD2XX.dll`,
`config.json`. Установщик (`Sphinx Reader Setup x.y.z.exe`) кладёт их вместе,
создаёт ярлык и автозапуск — по образцу инсталлятора Sigur Reader EH.

## Драйвер FTDI

Считыватель «Сфинкс» подключается по USB через чип FTDI. На АРМ оператора
нужен установленный драйвер FTDI (D2XX / VCP) — как и для Sigur Reader EH.

## Калибровка при первом запуске

`config.json`:
- `host` — пусто (дефолт) → слушает оба loopback-адреса `127.0.0.1` и `::1`.
  На Windows 10/11 браузер обычно резолвит `localhost` в IPv6 `::1`, поэтому
  биндинг только на IPv4 (`"127.0.0.1"`) приводит к «Агент не запущен» в UI
  при подключении по `ws://localhost:8765`. Допустимо явно задать
  `"127.0.0.1"` или `"::1"` для отладки; `"0.0.0.0"` / `"::"` НЕ
  использовать — открывает порт наружу.
- `w26.endian` — `big` (дефолт) или `little`. Если карта не находится в Sigur,
  переключить и повторить (бэкенд строит варианты из строки `fac,num` сам).
- `logRawBytes: true` — логирует `rc` и сырые байты буфера для разовой сверки
  с номером, который реально завёл в Sigur Manager.

## Лицензия на vendor/

`spnxreader.dll`, `FTD2XX.dll` — компоненты Sphinx Reader SDK / FTDI,
включены для интеграции по запросу владельца системы. Распространять только
в составе внутреннего инструмента.
