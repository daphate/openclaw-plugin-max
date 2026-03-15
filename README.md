# Max Channel Plugin for OpenClaw

Плагин добавляет поддержку российского мессенджера [Max](https://max.ru) в [OpenClaw](https://github.com/openclaw/openclaw). Использует официальный клиент [@maxhub/max-bot-api](https://github.com/max-messenger/max-bot-api-client-ts).

**Возможности:** личные и групповые чаты, long polling и webhook, политики доступа (pairing, allowlist, open), несколько аккаунтов. Поддержка медиа: приём и отправка голосовых, фото, видео, файлов (как в Telegram). При обработке сообщения агентом показывается индикатор «печатает» (typing_on) вместо эмодзи реакций (в Max API нет реакций на сообщения).

В OpenClaw плагины каналов устанавливаются в каталог **extensions** (глобально или в workspace). OpenClaw по умолчанию подхватывает плагины из этих каталогов без дополнительной настройки путей.

---

## Установка

### 1. Требования

- **Node.js** не ниже **18** (рекомендуется 20 LTS) — для запуска плагина и тестов.
- **OpenClaw** с поддержкой плагинов и каналов.
- Токен бота Max: [business.max.ru](https://business.max.ru/self) → Чат-боты → Интеграция → Получить токен.

### 2. Установка Node.js (если ещё не установлен)

Выберите один из способов.

**Через nvm (удобно для разработки):**

```bash
# Установка nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc   # или ~/.zshrc

# Установка Node.js 20 LTS
nvm install 20
nvm use 20
node -v   # должно быть v20.x.x
```

**Через официальный инсталлер:**

- Скачайте установщик с [nodejs.org](https://nodejs.org/) (LTS) и установите по инструкции для вашей ОС.

**Через менеджер пакетов (Linux):**

```bash
# Ubuntu/Debian (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Проверка
node -v
npm -v
```

### 3. Установка плагина в extensions

OpenClaw ищет плагины в каталоге **extensions**:
- **Глобально:** `~/.config/openclaw/extensions/` (или аналог по XDG)
- **В workspace:** `<workspace>/.openclaw/extensions/`

Установите плагин в один из этих каталогов.

**Вариант A: из репозитория (рекомендуется)**

```bash
# Каталог extensions (выберите один)
EXTENSIONS_DIR="$HOME/.config/openclaw/extensions"   # глобально
# или для workspace:
# EXTENSIONS_DIR="/path/to/workspace/.openclaw/extensions"

mkdir -p "$EXTENSIONS_DIR"
cd "$EXTENSIONS_DIR"
git clone https://github.com/daphate/openclaw-plugin-max.git
cd openclaw-plugin-max
```

**Вариант B: скопировать вручную**

Скачайте архив репозитория и распакуйте в каталог extensions, например в `~/.config/openclaw/extensions/openclaw-plugin-max/` или `<workspace>/.openclaw/extensions/openclaw-plugin-max/`.

### 4. Установка зависимостей

В каталоге плагина выполните:

```bash
cd "$EXTENSIONS_DIR/openclaw-plugin-max"
npm install
```

Будет установлена зависимость `@maxhub/max-bot-api` (и транзитивные зависимости). Проверка:

```bash
npm list
# openclaw-plugin-max@1.0.0
# └── @maxhub/max-bot-api@0.2.x
```

### 5. Подключение плагина в OpenClaw

Плагин из каталога **extensions** подхватывается OpenClaw автоматически. В конфиге включите его:

```json
{
  "plugins": {
    "entries": {
      "openclaw-plugin-max": { "enabled": true }
    }
  }
}
```

Либо укажите в списке разрешённых: `"plugins": { "allow": ["openclaw-plugin-max"] }`.

Дополнительно указывать путь к плагину не нужно — каталог **extensions** сканируется по умолчанию.

---

## Настройка канала Max

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

Поле `token` можно заменить на `botToken` — плагин принимает оба варианта.

---

## Использование

- **Отправка сообщений (outbound):**  
  `openclaw messages send --channel max --to <chat_id> "Текст"`
- **Получение и ответы:** бот обрабатывает входящие сообщения при:
  - **Long Polling:** запуск Gateway: `openclaw gateway run` — бот получает обновления через long polling.
  - **Webhook:** в Max укажите URL `https://ваш-домен/plugins/max/webhook` — события приходят по POST.

Параметры: для личных сообщений используется `user_id`, для групповых — `chat_id`; в CLI оба передаются в `--to`.

---

## Медиа и индикатор «думает»

### Входящие медиа

Плагин принимает голосовые сообщения, фото, видео, файлы (как в Telegram). Вложения из `message.body.attachments` передаются агенту:
- **Текст:** в `Body` добавляются плейсхолдеры `<media:image>`, `<media:video>`, `<media:audio>`, `<media:document>`.
- **Картинки:** URL передаются в `replyOptions.images` — агент получает изображения для анализа.
- Сообщения только с вложениями (без текста) обрабатываются.

### Исходящие медиа

Когда агент отвечает с медиа (`payload.mediaUrl` или `payload.mediaUrls`):
- **Картинки:** отправляются по URL без загрузки.
- **Аудио, видео, файлы:** загружаются по URL через Max Upload API, затем отправляются с вложениями.
- Поддерживается `payload.audioAsVoice` — аудио как голосовое сообщение (кружок).
- Лимит размера файла по URL: 50 MB.

### Индикатор «думает»

В Max API нет реакций на сообщения (как в Telegram). Вместо эмодзи используется **индикатор набора** (`typing_on`): пока агент обрабатывает сообщение, в чате отображается «печатает». Индикатор обновляется при вызове инструментов и компакции контекста.

---

## Разработка и тесты

В каталоге плагина:

```bash
npm test
```

Запускаются unit-тесты (Node.js встроенный test runner) для чистых функций: нормализация аккаунтов, разрешения allowFrom, извлечение получателя/отправителя, сбор вложений (`buildMaxBodyWithAttachments`) и т.д.

---

## Бот не отвечает на сообщения

1. **Gateway должен быть запущен:** `openclaw gateway run`.
2. Убедитесь, что каналы не отключены: переменная `OPENCLAW_SKIP_CHANNELS` не должна быть `1`.
3. В логах при запуске Gateway и при отправке сообщения боту смотрите:
   - `[Max] Starting ...` — long polling запущен;
   - `[Max] Received message` — пришло событие от Max;
   - `[Max] Skip: no recipient id` — в update нет корректного получателя;
   - `[Max] channelRuntime unavailable` — нужно запускать через Gateway;
   - `[Max] Dispatch error` — ошибка маршрутизации или агента.
4. В конфиге должен быть настроен агент (например, `agents.main`) и маршрутизация для канала `max`.
5. При webhook проверьте, что Max отправляет события на ваш HTTPS URL.

---

## Ссылки

- Официальный клиент Max: [max-bot-api-client-ts](https://github.com/max-messenger/max-bot-api-client-ts)
- Документация API Max: https://dev.max.ru/docs-api

---

## Лицензия

MIT.
