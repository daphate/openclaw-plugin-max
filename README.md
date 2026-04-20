# Max Channel Plugin for OpenClaw

Плагин добавляет поддержку российского мессенджера [Max](https://max.ru) в [OpenClaw](https://github.com/openclaw/openclaw). Использует официальный клиент [@maxhub/max-bot-api](https://github.com/max-messenger/max-bot-api-client-ts).

**Возможности:** личные и групповые чаты, long polling и webhook, политики доступа (pairing, allowlist, open), несколько аккаунтов. Поддержка медиа: приём и отправка голосовых, фото, видео, файлов (как в Telegram). При обработке сообщения агентом показывается индикатор «печатает» (typing_on) вместо эмодзи реакций (в Max API нет реакций на сообщения).

---

## Быстрый старт

### 1. Требования

- **Node.js** не ниже **18** (рекомендуется 20 LTS)
- **OpenClaw** с поддержкой плагинов
- Токен бота Max: [business.max.ru](https://business.max.ru/self) → Чат-боты → Интеграция → Получить токен

### 2. Установка плагина

В каталоге **extensions** OpenClaw (глобально или в workspace):

```bash
EXTENSIONS_DIR="$HOME/.config/openclaw/extensions"   # глобально
# или для workspace:
# EXTENSIONS_DIR="/path/to/workspace/.openclaw/extensions"

mkdir -p "$EXTENSIONS_DIR"
cd "$EXTENSIONS_DIR"
git clone https://github.com/daphate/openclaw-plugin-max.git
cd openclaw-plugin-max
npm install
```

### 3. Конфигурация

В `openclaw.json` или `openclaw.yaml`:

```yaml
channels:
  max:
    enabled: true
    token: "YOUR_BOT_TOKEN"
    # или для нескольких аккаунтов:
    accounts:
      default:
        token: "YOUR_BOT_TOKEN"
      secondary:
        token: "ANOTHER_TOKEN"
```

Поле `token` можно заменить на `botToken`.

### 4. Запуск

```bash
# Long polling (получение обновлений через опрос)
openclaw gateway run

# Или настроить webhook в Max: https://ваш-домен/plugins/max/webhook
```

---

## Переменные окружения и конфигурация

Все параметры задаются в конфиге OpenClaw, переменные окружения не требуются. Плагин считывает:

- `channels.max.token` или `channels.max.botToken` — токен бота (обязателен)
- `channels.max.enabled` — включить канал (по умолчанию `true`)
- `channels.max.dmPolicy` — политика доступа DM: `pairing` (по умолчанию), `allowlist`, `open`, `disabled`
- `channels.max.allowFrom` — список user_id для allowlist
- `channels.max.groupPolicy` — политика доступа групп: `open` (по умолчанию), `disabled`, `allowlist`
- `channels.max.groupAllowFrom` — список user_id для групп
- `channels.max.groups` — настройки по группам (включение/отключение, разрешения)
- `channels.max.direct` / `channels.max.dms` — настройки по персоналиям
- `channels.max.accounts` — конфиг для нескольких аккаунтов

**Multi-account:** каждый аккаунт в `channels.max.accounts.<id>` может иметь свой токен и настройки.

---

## Медиа

### Входящие медиа

Плагин принимает и передаёт агенту:
- **Текст с вложениями:** плейсхолдеры в Body (`<media:image>`, `<media:video>`, `<media:audio>`, `<media:document>`)
- **Картинки:** передаются как URLs для vision (inline images для анализа агентом)
- **Аудио/видео/файлы:** загружаются в media store и передаются в `MediaPaths`/`MediaTypes` для обработки (транскрипция, описание)

### Исходящие медиа

Агент может отправить медиа:

```python
# Через payload.mediaUrl(s)
payload.mediaUrl = "https://example.com/image.jpg"
payload.mediaUrls = ["audio.mp3", "video.mp4"]

# Или через inline-директивы в тексте
MEDIA:https://example.com/photo.jpg
MEDIA:/local/path/audio.ogg
```

**Поддерживаемые форматы:**
- Картинки: JPEG, PNG, GIF, WebP (отправляются по URL, без загрузки)
- Аудио: OGG, Opus, MP3, M4A, WAV, WebM
- Видео: MP4, WebM, MOV
- Файлы: любой формат

**Параметры:**
- `[[audio_as_voice]]` — отправить аудио как голосовое сообщение (кружок)
- Лимит размера по URL: 50 MB

### Индикатор «думает»

В Max нет реакций. Вместо эмодзи используется **typing indicator** (`typing_on`), который обновляется при обработке инструментов и компакции контекста.

---

## Управление доступом

### Политики (dmPolicy / groupPolicy)

- **pairing** — требует подтверждения через pairing code (DM по умолчанию)
- **allowlist** — только пользователи из `allowFrom`
- **open** — все пользователи (группы по умолчанию)
- **disabled** — запретить полностью

### Пример конфига с разными политиками

```yaml
channels:
  max:
    token: "bot_token"
    dmPolicy: "pairing"         # DM требует pairing
    allowFrom: [123, 456]       # или может быть в allowlist
    groupPolicy: "open"         # группы открыты
    groups:
      "-1001234567890":         # group chat_id (отрицательное число)
        enabled: true
        groupPolicy: "allowlist"
        allowFrom: [111, 222]
    direct:
      "999":                     # user_id
        enabled: false          # отключить чат с пользователем 999
```

---

## Разработка и тесты

```bash
# Запуск unit-тестов
npm test

# Проверить зависимости
npm list
npm audit
```

Тесты проверяют чистые функции: нормализацию аккаунтов, парсинг вложений, проверку разрешений и т.д.

---

## Диагностика

### Бот не отвечает

1. **Gateway запущен?** `openclaw gateway run`
2. **Плагин активен?** В логах должно быть `[Max] Starting ...` при старте
3. **Токен верный?** Проверить в конфиге `channels.max.token`
4. **Доступ разрешён?** Проверить `dmPolicy`, `allowFrom`, `pairing`
5. **Webhook?** Если используется webhook, убедиться, что Max отправляет события на `https://ваш-домен/plugins/max/webhook`

### Логи (при запуске Gateway)

```
[Max] Starting ...                           # плагин инициализирован
[Max] Received message                       # пришло сообщение
[Max] Skip: no recipient id                  # ошибка парсинга recipient
[Max] Blocked: DM allowlist, sender not in list  # доступ запрещён
[Max] Dispatch error: ...                    # ошибка маршрутизации/агента
[Max] Sent reply with media to chat ...      # ответ отправлен успешно
```

---

## Ключевые файлы

| Файл | Назначение |
|------|-----------|
| `src/index.js` | Основная реализация: регистрация канала, обработка обновлений, отправка сообщений |
| `test/index.test.js` | Unit-тесты (Node.js test runner) |
| `package.json` | Метаданные, зависимости, точка входа |
| `openclaw.plugin.json` | Описание плагина для OpenClaw (версия, описание, схема конфига) |
| `SECURITY.md` | Анализ безопасности |
| `ARCHITECTURE.md` | Архитектура и слои плагина |

---

## Ссылки

- [Max мессенджер](https://max.ru)
- [OpenClaw](https://github.com/openclaw/openclaw)
- [Max Bot API](https://github.com/max-messenger/max-bot-api-client-ts)
- [Max Platform API docs](https://dev.max.ru/docs-api)
- [Business Max](https://business.max.ru)

---

## Лицензия

MIT
