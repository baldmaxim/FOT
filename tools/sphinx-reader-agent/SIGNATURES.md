# Происхождение сигнатур spnxreader.dll

Заголовков SDK (`spnxsdk/*.h`), `.lib`, исходника `cpp_example.cpp` и мануала
в архиве `Debug20.7z` нет — только output debug-сборки. Сигнатуры ниже
**восстановлены реверс-инжинирингом** самой DLL и примера `cpp_example.exe`.

## Факты

- `spnxreader.dll` — **PE32 (x86), 32-битная**. Хост-процесс обязан быть 32-бит.
- Экспортируемые C-функции (таблица экспортов):
  `SpnxReaderOpen`, `SpnxReaderClose`, `SpnxReaderReceiveW26`, `SpnxReaderReceiveW26T`.
  Имена без декорации `@N` → **`__cdecl`** (у `__stdcall` было бы `_Name@N`,
  как у JNI-экспортов `_Java_spnxsdk_SpnxReader_*Impl@N`).

## Дизассемблер экспорт-стабов DLL

- `SpnxReaderOpen`: пролог, вызов фабрики, при успехе `*[ebp+8] = obj; return 1`,
  иначе `return 0`. Завершается `ret` (без `ret N`) → cdecl, 1 аргумент.
  ⇒ `int SpnxReaderOpen(void **pHandle)`.
- `SpnxReaderClose`: читает `[ebp+8]` как указатель-на-слот, дергает метод
  объекта + деструктор, в конце `mov dword [slot], 0`. `ret`.
  ⇒ `void SpnxReaderClose(void **pHandle)`.
- `SpnxReaderReceiveW26`: 3 аргумента (`[ebp+8]`,`[ebp+0C]`,`[ebp+10]`),
  вызывает `obj->vtbl[2](arg2,arg3)`. `ret`.
- `SpnxReaderReceiveW26T`: 4 аргумента (+`[ebp+14]`), `obj->vtbl[3](arg2,arg3,arg4)`.
  Лишний 4-й аргумент vs ReceiveW26 = таймаут.

## Call-site в cpp_example.exe (решающее доказательство)

```
lea   eax,[ebp-8]      ; &handle
push  eax
call  [SpnxReaderOpen]
add   esp,4            ; caller чистит стек → __cdecl, 1 арг
cmp   eax,1            ; успех == 1
...
push  3                ; arg3 = 3   (длина буфера: W26 = 24 бита = 3 байта)
lea   eax,[ebp-14h]    ; arg2 = &buf (локальный буфер вызывающего)
push  eax
mov   ecx,[ebp-8]      ; arg1 = handle (значение, записанное Open)
push  ecx
call  [SpnxReaderReceiveW26]
```

## Итоговые сигнатуры

```c
int  SpnxReaderOpen(void **pHandle);                            // 1 = успех; *pHandle = объект
void SpnxReaderClose(void **pHandle);                           // обнуляет *pHandle
int  SpnxReaderReceiveW26 (void *handle, unsigned char *buf, int len);            // пример: len=3
int  SpnxReaderReceiveW26T(void *handle, unsigned char *buf, int len, int toMs);  // + таймаут (мс)
```

## Открытые вопросы (калибруются на живом считывателе)

1. **Endianness номера** в 3-байтовом буфере: `buf[0]`=facility,
   `buf[1..2]`=номер (BE/LE). Дефолт `big`, флаг `config.w26.endian`.
   Точное значение проверяется сверкой с реестром карт Sigur (lookup найдёт
   карту — бэкенд сам строит много вариантов из строки `fac,num`).
2. **Семантика возврата** `ReceiveW26T`: эвристика — `rc>0` и буфер ненулевой
   ⇒ карта; `rc==0` ⇒ нет карты/таймаут; `rc<0` ⇒ ошибка связи (переоткрытие).
   `config.logRawBytes=true` логирует `rc`+байты для разовой калибровки.
