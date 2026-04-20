# Архитектура Max Channel Plugin for OpenClaw

Плагин интегрирует мессенджер Max в OpenClaw как канал доставки сообщений. Реализует спецификацию каналов OpenClaw: обработка входящих обновлений, маршрутизация к агентам, доставка ответов с поддержкой медиа.

---

## Общая структура

```
openclaw-plugin-max/
├── src/
│   └── index.js          # Основной модуль: регистрация, логика обработки
├── test/
│   └── index.test.js     # Unit-тесты чистых функций
├── package.json          # Метаданные, точка входа (./src/index.js)
└── openclaw.plugin.json  # Описание плагина, конфиг-схема
```

---

## Слои архитектуры

### 1. Уровень регистрации (`register()`)

**Файл:** `src/index.js`, строка 895

Точка входа плагина. Экспортирует функцию `default(api)`, которая:

1. Создаёт объект канала `maxChannel` с описанием, возможностями и реализацией
2. Регистрирует канал в OpenClaw: `api.registerChannel({ plugin: maxChannel })`
3. Регистрирует HTTP-маршрут для webhook: `api.registerHttpRoute()` на `/plugins/max/webhook`

**Структура `maxChannel`:**

```javascript
{
  id: "max",
  meta: { ... },           // метаданные для UI
  capabilities: { ... },   // поддерживаемые типы чатов
  pairing: { ... },        // настройки pairing
  config: { ... },         // функции конфига (resolveAccount, listAccountIds, ...)
  configSchema: { ... },   // JSON-schema для валидации
  outbound: { ... },       // sendText, sendMedia
  status: { ... },         // проверка здоровья (probeMax)
  gateway: { ... }         // startAccount (long polling)
}
```

### 2. Уровень конфигурации

**Файции:** `resolveAccount()`, `listAccountIds()`, `defaultAccountId()`, `normalizeAccountId()`

Обработка конфига OpenClaw:

- **`resolveAccount(cfg, accountId)`** — извлечение конфига аккаунта (токен, политики, настройки) из `channels.max` и `channels.max.accounts.<id>` с fallback на базовые значения
- **`listAccountIds(cfg)`** — список всех аккаунтов; если задана только база (token без accounts), возвращает `["default"]`
- **`defaultAccountId(cfg)`** — основной аккаунт для outbound и webhook
- **`normalizeAccountId(id)`** — приведение строк, пустых значений и undefined к `"default"`

**Приоритет параметров:**

```
account[param] > base[param] > (undefined или дефолт)
Пример: dmPolicy = account.dmPolicy ?? base.dmPolicy ?? "pairing"
```

### 3. Уровень обработки входящих сообщений

#### 3.1 Точки входа

**Long polling:** `gateway.startAccount()` создаёт Bot, подписывается на событие `message_created`.

**Webhook:** маршрут `/plugins/max/webhook` принимает POST с JSON-массивом обновлений от Max.

**Оба пути:**  
→ `processMaxUpdate(update, context)`

#### 3.2 Парсинг обновления

**`processMaxUpdate(update, context)`** — основная функция обработки:

1. Извлекает текст и вложения: `buildMaxBodyWithAttachments(msg)` → `{ bodyText, imageUrls }`
2. Скачивает и сохраняет медиа (аудио/видео/файлы): `fetchAndSaveMaxAttachments(msg, channelRuntime, log)`
3. Извлекает ID получателя и отправителя: `getRecipientId()`, `getSenderId()`, `getRecipientType()`
4. Проверяет доступ: `enforceMaxAccess()` → разрешить или запретить + pairing
5. Записывает сессию: `channelRuntime.session.recordInboundSession()`
6. Маршрутизирует к агенту: `channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher()`
7. Доставляет ответ: через callback `deliver()` → `sendToMax()`

**Контекст сообщения** для агента:

```javascript
{
  Body: "текст с плейсхолдерами <media:image>",
  BodyForAgent: "...",
  BodyForCommands: "...",
  From: "user_id",
  To: "chat_id (для групп) или user_id (для DM)",
  SessionKey: "уникальный ключ сессии",
  AccountId: "аккаунт",
  ChatType: "direct" | "group",
  OriginatingChannel: "max",
  Provider: "max",
  MediaPaths: [...],    // пути к загруженным медиа (если есть)
  MediaTypes: [...]     // MIME-типы
}
```

#### 3.3 Парсинг сообщений

**`buildMaxBodyWithAttachments(msg)`** → `{ bodyText, imageUrls }`

Собирает текст и вложения:
- Текст из `message.body.text`
- Плейсхолдеры для каждого вложения: `<media:image>`, `<media:video>`, `<media:audio>`, `<media:document>`
- URL картинок в отдельный массив для vision (inline images)

**`getRecipientId(update)`, `getSenderId(update)`, `getRecipientType(update)`**

Извлекают ID получателя, отправителя и тип чата из объекта update Max API.

### 4. Уровень управления доступом

**`enforceMaxAccess(params)`** — проверка прав доступа:

1. **Групповые чаты:** если `groupPolicy === "disabled"`, запретить; если `"open"`, разрешить; если `"allowlist"`, проверить `groupAllowFrom`
2. **Личные чаты:** если `dmPolicy === "open"`, разрешить; если `"disabled"`, запретить
3. **Pairing:** если `dmPolicy === "pairing"` и пользователь не в списке:
   - Создать/обновить pairing request: `channelRuntime.pairing.upsertPairingRequest()`
   - Отправить код подтверждения: `buildPairingReply()` → `sendToMax()`

**Функции поддержки:**

- **`normalizeAllowFrom(list)`** → `{ entries: [...], hasWildcard, hasEntries }` — парсинг списков разрешений, поддержка `"*"` (wildcard)
- **`mergeDmAllowFromSources(allowFrom, storeAllowFrom, dmPolicy)`** — объединение конфига и pairing store (только если не `allowlist`)
- **`isSenderInAllow(allow, senderId)`** — проверка наличия отправителя в списке

### 5. Уровень отправки исходящих сообщений

#### 5.1 Outbound API

**`outbound.sendText()`** — основной метод отправки текста:

- Использует `Bot(token).api.sendMessageToUser()` или `.sendMessageToChat()` в зависимости от ID (положительный = user, отрицательный = chat)

**`outbound.sendMedia()`** — отправка с медиа:

- Вызывает `sendMaxMessageWithMedia()` с URL медиа

#### 5.2 Доставка от агента

**Callback `deliver()` в `dispatchReplyWithBufferedBlockDispatcher()`:**

1. Парсит текст: `parseInlineMediaDirectives(textRaw)` → `{ text, mediaUrls, audioAsVoice }`
2. Объединяет медиа-URLs из payload и директив
3. Вызывает `sendToMax(toId, text, { mediaUrls, api, ... })`

#### 5.3 Отправка с медиа

**`sendMaxMessageWithMedia(chatId, text, mediaUrls, api, ...)`**

Для каждого медиа-URL:

1. Загружает буфер: `loadMediaBuffer(url, log)` (локальные файлы или fetch по HTTP)
2. Детектирует тип (MIME):
   - **Картинки**: отправляет по URL без загрузки (свойство `payload.url`)
   - **Аудио**: upload через Max API, fallback на file upload при ошибке
   - **Видео/Файлы**: upload через соответствующие методы
3. Собирает attachments-объекты: `[{ type: "image", payload: { url: "..." } }, ...]`
4. Отправляет: `api.raw.messages.send({ chat_id/user_id, body: { text, attachments } })`

**Обход бага в SDK:**

Функция `uploadAudioDirect()` воспроизводит корректный flow загрузки аудио вручную, обходя баг в `@maxhub/max-bot-api` (метод `uploadFromBuffer` не возвращает token).

#### 5.4 Индикатор обработки

**`setThinking()`** — отправляет `typing_on` при:

- Начале обработки сообщения
- Вызове инструментов агентом
- Компакции контекста

Это эквивалент эмодзи-реакций в Telegram (которых нет в Max API).

### 6. Уровень статуса и мониторинга

**`status.probeAccount()`** — проверка здоровья:

- Вызывает `Bot.api.getMyInfo()` с таймаутом 
- Возвращает `{ ok, elapsedMs, bot?: { username }, error?: string }`

**`status.buildAccountSnapshot()`** — описание текущего состояния аккаунта

### 7. Экспорты для тестов

Функции экспортируются для unit-тестирования:

```javascript
export {
  normalizeAccountId,
  firstDefined,
  resolveAccount,
  listAccountIds,
  defaultAccountId,
  getRecipientId,
  getSenderId,
  getRecipientType,
  normalizeAllowFrom,
  mergeDmAllowFromSources,
  isSenderInAllow,
  buildMaxBodyWithAttachments,
  DEFAULT_ACCOUNT_ID,
}
```

---

## Поток данных

### Входящее сообщение от пользователя

```
Max API (message_created)
    ↓
Bot.on("message_created") или /webhook POST
    ↓
processMaxUpdate(update, context)
    ├─→ buildMaxBodyWithAttachments() → bodyText, imageUrls
    ├─→ fetchAndSaveMaxAttachments() → mediaPaths, mediaTypes
    ├─→ getRecipientId/getSenderId/getRecipientType()
    ├─→ enforceMaxAccess() → allowed: boolean
    └─→ (если allowed)
        ├─→ channelRuntime.session.recordInboundSession()
        ├─→ channelRuntime.routing.resolveAgentRoute() → агент
        └─→ channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher()
            └─→ deliver(payload)
                ├─→ parseInlineMediaDirectives(text)
                └─→ sendToMax(peerId, text, { mediaUrls, ... })
                    └─→ sendMaxMessageWithMedia(chatId, text, mediaUrls, ...)
                        └─→ Max API (messages.send)
```

### Исходящее сообщение (outbound)

```
openclaw messages send --channel max --to <id> "text"
    ↓
outbound.sendText({ cfg, to, text, accountId })
    ├─→ resolveAccount(cfg, accountId) → токен, настройки
    └─→ Bot(token).api.sendMessageToUser/Chat(id, text)
        └─→ Max API
```

---

## Ключевые абстракции и расширения

### Аккаунты

- **Single account:** конфиг `channels.max.token` → аккаунт `"default"`
- **Multi-account:** конфиг `channels.max.accounts.<id>` → отдельный Bot для каждого
- **Fallback:** параметры аккаунта наследуют значения базового конфига

### Политики доступа

- **DM (Direct Messages):** `dmPolicy` = pairing, allowlist, open, disabled
- **Группы:** `groupPolicy` = open, disabled, allowlist
- **Гранулярность:** можно задать политику глобально, по аккаунту, по группе или по персоне

### Паiring

При политике `dmPolicy: "pairing"`:
- Неизвестный пользователь получает код подтверждения
- Код сохраняется в store: `channelRuntime.pairing.readAllowFromStore()`
- После подтверждения user_id добавляется в allowlist

### Медиа

- **Картинки:** по URL (без загрузки, экономия трафика)
- **Аудио/видео/файлы:** upload через Max API (загружаются на сервер Max)
- **Inline медиа:** директивы в тексте `MEDIA:<url>` и `[[audio_as_voice]]`

---

## Внешние интеграции

| Компонент | Откуда | Использование |
|-----------|--------|---------------|
| `@maxhub/max-bot-api` | NPM | Bot, polling, API вызовы |
| OpenClaw API | ctx | logger, config, routing, session, reply, pairing |
| Max Platform API | HTTPS | messages.send, upload, getMyInfo, sendAction |

---

## Точки расширения

### Новые события

Добавить подписку в `gateway.startAccount()`:

```javascript
bot.on("message_updated", async (botCtx) => {
  // обработка
});
```

### Новые медиа-типы

Расширить `MEDIA_PLACEHOLDERS` и `sendMaxMessageWithMedia()`:

```javascript
MEDIA_PLACEHOLDERS.newtype = "<media:newtype>";
// и в sendMaxMessageWithMedia(): 
// if (isNewType) { attachments.push(...); }
```

### Кастомная политика доступа

Переопределить логику `enforceMaxAccess()` — например, интеграция с внешней БД разрешений.

### Кастомный медиа-upload

Заменить `api.upload.*` на собственную реализацию в `sendMaxMessageWithMedia()`.

---

## Безопасность

- **Валидация ID:** `parseInt(String(toId), 10)` с проверкой `isNaN`
- **Размеры:** лимит webhook-тела 512 KB, медиа 50 MB
- **Доступ:** `enforceMaxAccess()` блокирует неавторизованные чаты
- **Токены:** берутся из конфига, не логируются, не передаются в сообщения
- **Код:** нет `eval`, `Function`, `child_process`; только импорт официального SDK

---

## Тестирование

**Unit-тесты** (`test/index.test.js`):

- Нормализация аккаунтов и ID
- Парсинг allowFrom-списков и проверка разрешений
- Извлечение ID и типов чатов из updates
- Сборка вложений (buildMaxBodyWithAttachments)

**Запуск:**

```bash
npm test
```

**Integration-тесты** (требуют реального токена Max):

- Создать файл `test/integration.test.js` (не в репо)
- Использовать переменные окружения для токена
- Отправить тестовое сообщение, проверить ответ

---

## Производительность

- **Concurrency:** каждое обновление обрабатывается асинхронно; `dispatchReplyWithBufferedBlockDispatcher` может буферизировать ответы
- **Timeout:** по умолчанию нет; можно задать `channels.max.timeoutSeconds` в конфиге
- **Chunking:** текст может быть разбит на куски через `textChunkLimit` и `chunkMode`
- **Streaming:** поддержка `streaming: "partial"` | `"block"` | `"progress"` (см. конфиг-схему)

---

## История версий

- **1.0.0** — первоначальный релиз с поддержкой Max Platform API, long polling/webhook, медиа, pairing и multi-account
