/**
 * Max Channel Plugin for OpenClaw
 *
 * Интегрирует OpenClaw с российским мессенджером Max (max.ru) через официальный
 * клиент @maxhub/max-bot-api. Поддерживает long polling и webhook, личные и
 * групповые чаты, политики доступа (pairing, allowlist, open).
 *
 * @module openclaw-plugin-max
 * @see https://github.com/max-messenger/max-bot-api-client-ts
 * @see https://dev.max.ru/docs-api
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Bot } from "@maxhub/max-bot-api";

/** Идентификатор аккаунта по умолчанию, если не задан другой. */
const DEFAULT_ACCOUNT_ID = "default";

/**
 * Нормализует идентификатор аккаунта: пустая строка или нестрока заменяются на "default".
 * @param {string | null | undefined} id - Исходный идентификатор аккаунта
 * @returns {string} Нормализованный идентификатор (не пустая строка)
 */
function normalizeAccountId(id) {
  if (!id || typeof id !== "string") return DEFAULT_ACCOUNT_ID;
  const t = id.trim();
  return t || DEFAULT_ACCOUNT_ID;
}

/**
 * Возвращает первое значение из списка, отличное от undefined.
 * @param {...*} values - Список значений
 * @returns {* | undefined} Первое определённое значение или undefined
 */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Разрешает конфигурацию аккаунта Max из cfg: объединяет базовые настройки
 * channels.max и (при наличии) channels.max.accounts[accountId].
 *
 * @param {object} cfg - Глобальный конфиг OpenClaw (config)
 * @param {string} [accountId] - Идентификатор аккаунта (если не задан — "default")
 * @returns {object} Объект аккаунта: accountId, token, enabled, name, dmPolicy, allowFrom,
 *   groupPolicy, groupAllowFrom, groups, direct, dms, historyLimit, dmHistoryLimit,
 *   textChunkLimit, chunkMode, streaming, timeoutSeconds, responsePrefix, defaultTo,
 *   configWrites, linkPreview
 */
function resolveAccount(cfg, accountId) {
  const id = normalizeAccountId(accountId ?? null);
  const accounts = cfg?.channels?.max?.accounts ?? {};
  const base = cfg?.channels?.max;
  const account = accounts[id] ?? (id === DEFAULT_ACCOUNT_ID ? base : null);
  const token =
    account?.token ??
    account?.botToken ??
    (id === DEFAULT_ACCOUNT_ID ? base?.token ?? base?.botToken : undefined);
  const enabled = account?.enabled !== false && (id !== DEFAULT_ACCOUNT_ID || base?.enabled !== false);
  return {
    accountId: id,
    token: typeof token === "string" ? token.trim() : undefined,
    enabled,
    name: firstDefined(account?.name, base?.name),
    dmPolicy: firstDefined(account?.dmPolicy, base?.dmPolicy),
    allowFrom: account?.allowFrom ?? base?.allowFrom,
    groupPolicy: firstDefined(account?.groupPolicy, base?.groupPolicy),
    groupAllowFrom: account?.groupAllowFrom ?? base?.groupAllowFrom,
    groups: account?.groups ?? base?.groups,
    direct: account?.direct ?? base?.direct,
    dms: account?.dms ?? base?.dms,
    historyLimit: firstDefined(account?.historyLimit, base?.historyLimit),
    dmHistoryLimit: firstDefined(account?.dmHistoryLimit, base?.dmHistoryLimit),
    textChunkLimit: firstDefined(account?.textChunkLimit, base?.textChunkLimit),
    chunkMode: firstDefined(account?.chunkMode, base?.chunkMode),
    streaming: firstDefined(account?.streaming, base?.streaming),
    timeoutSeconds: firstDefined(account?.timeoutSeconds, base?.timeoutSeconds),
    responsePrefix: firstDefined(account?.responsePrefix, base?.responsePrefix),
    defaultTo: firstDefined(account?.defaultTo, base?.defaultTo),
    configWrites: firstDefined(account?.configWrites, base?.configWrites),
    linkPreview: firstDefined(account?.linkPreview, base?.linkPreview),
  };
}

/**
 * Возвращает список идентификаторов аккаунтов Max из конфига.
 * Если заданы только channels.max.token/botToken без accounts — возвращает ["default"].
 *
 * @param {object} cfg - Глобальный конфиг OpenClaw
 * @returns {string[]} Массив accountId
 */
function listAccountIds(cfg) {
  const accounts = cfg?.channels?.max?.accounts;
  if (!accounts || typeof accounts !== "object") {
    const base = cfg?.channels?.max;
    if (base && (base.token || base.botToken)) {
      return [DEFAULT_ACCOUNT_ID];
    }
    return [];
  }
  const ids = Object.keys(accounts);
  if (ids.length === 0 && (cfg?.channels?.max?.token || cfg?.channels?.max?.botToken)) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids;
}

/**
 * Возвращает идентификатор аккаунта по умолчанию для канала Max:
 * "default", если он есть в списке, иначе первый из списка.
 *
 * @param {object} cfg - Глобальный конфиг OpenClaw
 * @returns {string} accountId
 */
function defaultAccountId(cfg) {
  const ids = listAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Probe Max API with token (getMyInfo). Returns { ok, elapsedMs, bot?: { username } } for doctor/health.
 * @param {string} token - Bot token
 * @param {number} timeoutMs - Timeout in ms
 * @returns {Promise<{ ok: boolean, elapsedMs?: number, bot?: { username: string }, error?: string }>}
 */
async function probeMax(token, timeoutMs) {
  const start = Date.now();
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "missing token", elapsedMs: Date.now() - start };
  }
  const bot = new Bot(token.trim());
  try {
    const info = await Promise.race([
      bot.api.getMyInfo(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), Math.max(100, timeoutMs)),
      ),
    ]);
    const elapsedMs = Date.now() - start;
    const username =
      (info && (typeof info.username === "string" ? info.username : null)) ||
      (info && typeof info.name === "string" ? info.name : null) ||
      "max";
    return { ok: true, elapsedMs, bot: { username } };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    return {
      ok: false,
      error: err?.message ?? String(err),
      elapsedMs,
    };
  }
}

/**
 * Извлекает идентификатор получателя (чат или пользователь) из объекта update Max API.
 *
 * @param {object} update - Объект обновления от Max (message_created и т.д.)
 * @returns {string | null} ID чата/пользователя или null
 */
function getRecipientId(update) {
  const msg = update?.message;
  if (!msg?.recipient) return null;
  const r = msg.recipient;
  const id = r.chat_id ?? r.user_id ?? r.id ?? r.chat?.chat_id ?? r.chat?.id ?? r.user?.user_id ?? r.user?.id;
  return id != null ? String(id) : null;
}

/**
 * Извлекает идентификатор отправителя из update.
 *
 * @param {object} update - Объект обновления от Max
 * @returns {string} user_id отправителя (пустая строка, если не найден)
 */
function getSenderId(update) {
  const msg = update?.message;
  const sender = msg?.sender ?? update?.user;
  if (!sender) return "";
  return String(sender.user_id ?? sender.id ?? sender.user?.user_id ?? sender.user?.id ?? "").trim();
}

/**
 * Определяет тип чата по update: групповой ("group") или личный ("direct").
 *
 * @param {object} update - Объект обновления от Max
 * @returns {"group" | "direct"} Тип чата
 */
function getRecipientType(update) {
  const r = update?.message?.recipient;
  const ct = r?.chat_type ?? r?.type ?? r?.chat?.chat_type ?? r?.chat?.type;
  if (ct === "chat" || ct === "channel" || ct === "group") return "group";
  if (r?.chat_id != null || r?.chat?.chat_id != null) return "group";
  return "direct";
}

/** Плейсхолдеры для вложений в тексте для агента (как в Telegram). */
const MEDIA_PLACEHOLDERS = {
  image: "<media:image>",
  video: "<media:video>",
  audio: "<media:audio>",
  file: "<media:document>",
};

/**
 * Собирает из сообщения Max текст и вложения: плейсхолдеры в Body, URL картинок для replyOptions.images.
 *
 * @param {object} msg - update.message от Max
 * @returns {{ bodyText: string, imageUrls: string[] }}
 */
function buildMaxBodyWithAttachments(msg) {
  const text = (msg?.body?.text ?? "").trim();
  const attachments = msg?.body?.attachments ?? [];
  const imageUrls = [];
  const placeholders = [];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      const type = att?.type ?? "file";
      const url = att?.payload?.url;
      placeholders.push(MEDIA_PLACEHOLDERS[type] ?? MEDIA_PLACEHOLDERS.file);
      if (type === "image" && typeof url === "string" && url.trim()) {
        imageUrls.push(url.trim());
      }
    }
  }
  const bodyText = [text, ...placeholders].filter(Boolean).join("\n");
  return { bodyText: bodyText || (placeholders.length ? placeholders.join(" ") : ""), imageUrls };
}

/** Макс. размер загружаемого файла при отправке по URL (байты). */
const MAX_MEDIA_FETCH_BYTES = 50 * 1024 * 1024; // 50 MB

/** Макс. размер входящего медиа для fetch (аудио/видео до 25MB). */
const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;

const HTTP_URL_RE = /^https?:\/\//i;
const FILE_URL_RE = /^file:\/\//i;
const INLINE_MEDIA_RE = /(?:^|\n)\s*MEDIA:\s*([^\n]+)\s*(?=\n|$)/gi;
const AUDIO_AS_VOICE_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;

function isLocalMediaSource(media) {
  if (!media || typeof media !== "string") return false;
  const t = media.trim();
  return (
    FILE_URL_RE.test(t) ||
    t.startsWith("/") ||
    t.startsWith("./") ||
    t.startsWith("../") ||
    t.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(t)
  );
}

async function resolveLocalPath(raw) {
  const t = raw.trim();
  if (FILE_URL_RE.test(t)) {
    try {
      return decodeURIComponent(new URL(t).pathname);
    } catch {
      return path.resolve(t.replace(/^file:\/\//, ""));
    }
  }
  if (t.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, t.slice(1).replace(/^[/\\]/, ""));
  }
  return path.resolve(t);
}

async function loadMediaBuffer(mediaUrl, log) {
  if (!isLocalMediaSource(mediaUrl)) {
    const res = await fetch(mediaUrl.trim());
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType };
  }
  const absPath = await resolveLocalPath(mediaUrl);
  const buf = await fs.readFile(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const extToMime = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  const contentType = extToMime[ext] || "application/octet-stream";
  return { buffer: buf, contentType };
}

/**
 * Разбирает inline-директивы из текста ответа агента:
 * - [[audio_as_voice]]
 * - MEDIA:<url-or-path> (одна на строку)
 *
 * Возвращает очищенный текст, список media URL/путей и признак audioAsVoice.
 *
 * @param {string} text
 * @returns {{ text: string, mediaUrls: string[], audioAsVoice: boolean }}
 */
function parseInlineMediaDirectives(text) {
  const src = String(text ?? "");
  const mediaUrls = [];
  let cleaned = src.replace(AUDIO_AS_VOICE_RE, "").trim();
  cleaned = cleaned.replace(INLINE_MEDIA_RE, (_, raw) => {
    const v = String(raw ?? "").trim();
    if (!v) return "";
    const unquoted =
      (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
        ? v.slice(1, -1).trim()
        : v;
    if (unquoted) mediaUrls.push(unquoted);
    return "";
  });
  // Схлопываем лишние пустые строки после удаления директив.
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text: cleaned,
    mediaUrls,
    audioAsVoice: AUDIO_AS_VOICE_RE.test(src),
  };
}

/** Маппинг типа вложения Max → MIME для типов без URL. */
const ATTACHMENT_TYPE_TO_MIME = {
  audio: "audio/ogg",
  video: "video/mp4",
  image: "image/jpeg",
  file: "application/octet-stream",
};

/**
 * Скачивает вложения по URL и сохраняет в media store. Возвращает пути и MIME для
 * applyMediaUnderstanding (транскрипция аудио, описание изображений и т.д.).
 *
 * @param {object} msg - update.message от Max
 * @param {object} channelRuntime - api.runtime.channel (fetchRemoteMedia, saveMediaBuffer)
 * @param {object} log - logger
 * @returns {Promise<{ mediaPaths: string[], mediaTypes: string[] }>}
 */
async function fetchAndSaveMaxAttachments(msg, channelRuntime, log) {
  const mediaPaths = [];
  const mediaTypes = [];
  const fetchRemoteMedia = channelRuntime?.media?.fetchRemoteMedia;
  const saveMediaBuffer = channelRuntime?.media?.saveMediaBuffer;
  if (!fetchRemoteMedia || !saveMediaBuffer) return { mediaPaths, mediaTypes };

  const attachments = msg?.body?.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length === 0) return { mediaPaths, mediaTypes };

  for (const att of attachments) {
    const url = att?.payload?.url;
    if (!url || typeof url !== "string" || !url.trim()) continue;
    const type = att?.type ?? "file";
    try {
      const fetched = await fetchRemoteMedia({
        url: url.trim(),
        maxBytes: MAX_INBOUND_MEDIA_BYTES,
      });
      if (!fetched?.buffer || fetched.buffer.length === 0) continue;
      const contentType = fetched.contentType?.split(";")[0]?.trim() || ATTACHMENT_TYPE_TO_MIME[type];
      const saved = await saveMediaBuffer(
        fetched.buffer,
        contentType,
        "inbound",
        MAX_INBOUND_MEDIA_BYTES,
        fetched.fileName,
      );
      if (saved?.path) {
        mediaPaths.push(saved.path);
        mediaTypes.push(saved.contentType ?? contentType);
      }
    } catch (e) {
      log?.warn?.(`[Max] Failed to fetch/save attachment ${type}: ${e?.message}`);
    }
  }
  return { mediaPaths, mediaTypes };
}

/**
 * Загружает медиа по URL и отправляет в чат: картинки по url в attachment, остальное — upload + token.
 *
 * @param {number} chatId - ID чата
 * @param {string} text - Текст сообщения
 * @param {string[]} mediaUrls - URL медиа
 * @param {object} api - bot.api (messages.send, upload.*)
 * @param {object} log - logger
 * @param {boolean} [audioAsVoice] - отправлять аудио как голосовое (кружок)
 * @returns {Promise<void>}
 */
async function sendMaxMessageWithMedia(chatId, text, mediaUrls, api, log, audioAsVoice) {
  const attachments = [];
  for (const url of mediaUrls) {
    if (!url || typeof url !== "string") continue;
    const trimmed = url.trim();
    if (!trimmed) continue;
    try {
      const { buffer: buf, contentType } = await loadMediaBuffer(trimmed, log);
      if (buf.length === 0 || buf.length > MAX_MEDIA_FETCH_BYTES) continue;
      const ct = (contentType || "").split(";")[0].trim().toLowerCase();
      const pathname = HTTP_URL_RE.test(trimmed)
        ? (() => {
            try {
              return new URL(trimmed).pathname;
            } catch {
              return "";
            }
          })()
        : "";
      const isImage = /^image\//.test(ct) || /\.(jpe?g|png|gif|webp)$/i.test(pathname || trimmed);
      if (isImage && !isLocalMediaSource(trimmed)) {
        attachments.push({ type: "image", payload: { url: trimmed } });
        continue;
      }
      if (isImage) {
        const up = await api.upload.image({ source: buf });
        const token = Object.values(up?.photos ?? {})[0]?.token;
        if (token) attachments.push({ type: "image", payload: { token } });
        continue;
      }
      const isAudio = /^audio\//.test(ct) || /\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(trimmed);
      const isVideo = /^video\//.test(ct) || /\.(mp4|webm|mov)$/i.test(trimmed);
      if (isAudio) {
        const up = await api.upload.audio({ source: buf });
        const token = up?.token;
        if (token) attachments.push({ type: "audio", payload: { token } });
      } else if (isVideo) {
        const up = await api.upload.video({ source: buf });
        const token = up?.token;
        if (token) attachments.push({ type: "video", payload: { token } });
      } else {
        const up = await api.upload.file({ source: buf });
        const token = up?.token;
        if (token) attachments.push({ type: "file", payload: { token } });
      }
    } catch (e) {
      log?.warn?.(`[Max] Media load/upload failed for ${trimmed.slice(0, 80)}: ${e?.message}`);
    }
  }
  const body = { text: text || null, attachments: attachments.length ? attachments : undefined };
  await api.raw.messages.send({ chat_id: chatId, ...body });
}

/**
 * Отправляет сообщение в чат Max: только текст или текст + медиа (загрузка по URL при необходимости).
 *
 * @param {string} toId - ID чата (число как строка)
 * @param {string} text - Текст
 * @param {object} [opts] - { mediaUrls, api, log, audioAsVoice }
 */
async function sendToMaxImpl(toId, text, opts, sendTextOnly) {
  const num = parseInt(String(toId), 10);
  if (isNaN(num)) {
    opts?.log?.warn?.(`[Max] Skip send: invalid toId ${toId}`);
    return;
  }
  const mediaUrls = opts?.mediaUrls ?? [];
  if (mediaUrls.length === 0) {
    await sendTextOnly(num, text ?? "");
    return;
  }
  if (!opts?.api) {
    opts?.log?.warn?.("[Max] No api for media send, falling back to text only");
    await sendTextOnly(num, text ?? "");
    return;
  }
  try {
    await sendMaxMessageWithMedia(
      num,
      text ?? "",
      mediaUrls,
      opts.api,
      opts.log,
      opts.audioAsVoice === true,
    );
    opts?.log?.info?.(`[Max] Sent reply with media to chat ${num}`);
  } catch (err) {
    opts?.log?.warn?.(`[Max] Send with media failed: ${err?.message}`);
    try {
      await sendTextOnly(num, text ?? "");
    } catch (e2) {
      opts?.log?.warn?.(`[Max] Fallback text send failed: ${e2?.message}`);
    }
  }
}

/**
 * Нормализует список allowFrom: числовые Max user ID, опциональный префикс "max:" удаляется.
 * Поддерживается wildcard "*" (разрешить всех).
 *
 * @param {string[] | undefined} list - Сырой список (например ["123", "max:456", "*"])
 * @returns {{ entries: string[], hasWildcard: boolean, hasEntries: boolean }}
 */
function normalizeAllowFrom(list) {
  const raw = (list ?? []).map((v) => String(v).trim()).filter(Boolean);
  const hasWildcard = raw.includes("*");
  const entries = raw
    .filter((v) => v !== "*")
    .map((v) => v.replace(/^max:/i, ""))
    .filter((v) => /^\d+$/.test(v));
  return { entries, hasWildcard, hasEntries: raw.length > 0 };
}

/**
 * Объединяет источники списка разрешённых отправителей для DM:
 * конфиг allowFrom и (если dmPolicy не "allowlist") store (pairing).
 *
 * @param {string[] | undefined} allowFrom - Список из конфига
 * @param {string[]} [storeAllowFrom] - Список из хранилища pairing
 * @param {string} [dmPolicy] - "allowlist" | "pairing" | "open" | "disabled"
 * @returns {string[]} Объединённый массив числовых ID
 */
function mergeDmAllowFromSources(allowFrom, storeAllowFrom, dmPolicy) {
  const fromStore = dmPolicy === "allowlist" ? [] : (storeAllowFrom ?? []);
  return [...(allowFrom ?? []), ...fromStore].map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Проверяет, разрешён ли отправитель senderId по правилам allow
 * (entries + hasWildcard из normalizeAllowFrom).
 *
 * @param {{ entries: string[], hasWildcard: boolean, hasEntries: boolean }} allow - Результат normalizeAllowFrom
 * @param {string} [senderId] - ID отправителя
 * @returns {boolean}
 */
function isSenderInAllow(allow, senderId) {
  if (!allow.hasEntries) return false;
  if (allow.hasWildcard) return true;
  return senderId && allow.entries.includes(String(senderId));
}

/**
 * Проверяет доступ к чату/диалогу: групповые правила (groupPolicy, groupAllowFrom),
 * личные (dmPolicy, allowFrom, pairing). При pairing при отказе создаёт запрос и
 * при необходимости отправляет сообщение с кодом pairing.
 *
 * @param {object} params - Контекст: isGroup, fromId, toId, account, cfg, channelRuntime, log, sendToMax
 * @returns {Promise<{ allowed: boolean }>}
 */
async function enforceMaxAccess(params) {
  const {
    isGroup,
    fromId,
    toId,
    account,
    cfg,
    channelRuntime,
    log,
    sendToMax,
  } = params;
  const dmPolicy = account?.dmPolicy ?? "pairing";
  const groupPolicy = account?.groupPolicy ?? "open";

  if (isGroup) {
    const groupConfig = account?.groups?.[String(toId)];
    const effectiveGroupPolicy = firstDefined(groupConfig?.groupPolicy, groupPolicy);
    if (effectiveGroupPolicy === "disabled") {
      log?.debug?.(`[Max] Blocked: group policy disabled`);
      return { allowed: false };
    }
    if (groupConfig?.enabled === false) {
      log?.debug?.(`[Max] Blocked: group ${toId} disabled`);
      return { allowed: false };
    }
    if (effectiveGroupPolicy === "open") return { allowed: true };
    const groupAllowFrom = groupConfig?.allowFrom ?? account?.groupAllowFrom ?? account?.allowFrom ?? [];
    const allow = normalizeAllowFrom(groupAllowFrom);
    if (!isSenderInAllow(allow, fromId)) {
      log?.debug?.(`[Max] Blocked: group allowlist, sender ${fromId} not in list`);
      return { allowed: false };
    }
    return { allowed: true };
  }

  const directConfig =
    account?.direct?.[String(fromId)] ??
    account?.direct?.[String(toId)] ??
    account?.dms?.[String(fromId)];
  const effectiveDmPolicy = firstDefined(directConfig?.dmPolicy, dmPolicy);
  if (directConfig?.enabled === false) {
    log?.debug?.(`[Max] Blocked: direct/chat disabled`);
    return { allowed: false };
  }

  if (effectiveDmPolicy === "disabled") {
    log?.debug?.(`[Max] Blocked: DM policy disabled`);
    return { allowed: false };
  }
  if (effectiveDmPolicy === "open") return { allowed: true };

  const dmAllowFrom = directConfig?.allowFrom ?? account?.allowFrom;
  let storeAllowFrom = [];
  if (channelRuntime?.pairing?.readAllowFromStore) {
    try {
      storeAllowFrom = await channelRuntime.pairing.readAllowFromStore({
        channel: "max",
        accountId: account.accountId,
      });
    } catch (e) {
      log?.warn?.(`[Max] readAllowFromStore: ${e?.message}`);
    }
  }
  const merged = mergeDmAllowFromSources(dmAllowFrom, storeAllowFrom, effectiveDmPolicy);
  const effectiveAllow = normalizeAllowFrom(merged);

  if (isSenderInAllow(effectiveAllow, fromId)) return { allowed: true };

  if (effectiveDmPolicy === "pairing" && channelRuntime?.pairing?.upsertPairingRequest) {
    try {
      const { code, created } = await channelRuntime.pairing.upsertPairingRequest({
        channel: "max",
        accountId: account.accountId,
        id: String(fromId),
        meta: {},
      });
      if (created && channelRuntime.pairing.buildPairingReply) {
        const text = channelRuntime.pairing.buildPairingReply({
          channel: "max",
          idLine: `Your Max user id: ${fromId}`,
          code,
        });
        await sendToMax(fromId, text, { chatKind: "direct" });
      }
    } catch (e) {
      log?.warn?.(`[Max] Pairing: ${e?.message}`);
    }
    return { allowed: false };
  }

  log?.debug?.(`[Max] Blocked: DM allowlist, sender ${fromId} not allowed`);
  return { allowed: false };
}

/**
 * Обрабатывает одно обновление от Max (message_created): извлекает текст и получателя,
 * проверяет доступ (enforceMaxAccess), маршрутизирует к агенту, записывает сессию и
 * доставляет ответ через dispatchReplyWithBufferedBlockDispatcher.
 *
 * @param {object} update - Объект обновления от Max API
 * @param {object} context - cfg, accountId, api, channelRuntime, log, sendToMax
 * @returns {Promise<void>}
 */
async function processMaxUpdate(update, { cfg, accountId, api, channelRuntime, log, sendToMax, sendAction }) {
  if (update.update_type !== "message_created" || !update.message) return;

  const msg = update.message;
  const { bodyText, imageUrls } = buildMaxBodyWithAttachments(msg);
  const { mediaPaths, mediaTypes } = await fetchAndSaveMaxAttachments(msg, channelRuntime, log);
  const toId = getRecipientId(update);
  const fromId = getSenderId(update);

  if (!toId) {
    log?.warn?.(`[Max] Skip: no recipient id (recipient keys: ${Object.keys(update?.message?.recipient ?? {}).join(", ")})`);
    return;
  }
  if (!bodyText.trim()) {
    return;
  }

  const chatKind = getRecipientType(update);
  const replyPeerId = chatKind === "group" ? toId : fromId;
  const rt = channelRuntime;

  if (!replyPeerId) {
    log?.warn?.("[Max] Skip: no reply peer id");
    return;
  }

  if (
    !rt?.routing?.resolveAgentRoute ||
    !rt?.reply?.dispatchReplyWithBufferedBlockDispatcher ||
    !rt?.session?.recordInboundSession
  ) {
    log?.warn?.(`[Max] channelRuntime unavailable — run via Gateway: openclaw gateway run`);
    return;
  }

  const account = resolveAccount(cfg, accountId);
  const access = await enforceMaxAccess({
    isGroup: chatKind === "group",
    fromId,
    toId,
    account,
    cfg,
    channelRuntime: rt,
    log,
    sendToMax,
  });
  if (!access.allowed) return;

  const chatIdNum = parseInt(String(replyPeerId), 10);
  if (isNaN(chatIdNum)) return;

  /** Показать «думает» (как эмодзи в Telegram): в Max нет реакций, используем typing_on. */
  const setThinking = () => {
    if (sendAction) sendAction(chatIdNum, "typing_on").catch((e) => log?.warn?.(`[Max] sendAction: ${e?.message}`));
  };

  try {
    const route = rt.routing.resolveAgentRoute({
      cfg,
      channel: "max",
      accountId,
      peer: { kind: chatKind, id: String(replyPeerId) },
    });
    const sessionKey = rt.routing.buildAgentSessionKey({
      agentId: route.agentId,
      channel: "max",
      accountId,
      peer: { kind: chatKind, id: String(replyPeerId) },
      dmScope: "main",
    });
    const ctxPayload = {
      Body: bodyText,
      BodyForAgent: bodyText,
      BodyForCommands: bodyText,
      RawBody: bodyText,
      From: fromId,
      To: replyPeerId,
      SessionKey: sessionKey,
      AccountId: accountId,
      ChatType: chatKind,
      OriginatingChannel: "max",
      Provider: "max",
      ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths, MediaTypes: mediaTypes }),
    };

    await rt.session.recordInboundSession({
      storePath: rt.session.resolveStorePath(cfg?.session?.store, { agentId: route.agentId }),
      sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => log?.warn?.(`[Max] recordInboundSession: ${err.message}`),
    });

    setThinking();

    await rt.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload) => {
          const textRaw =
            payload?.text ??
            (Array.isArray(payload?.blocks)
              ? (payload.blocks.find((b) => b?.type === "text")?.text ?? "")
              : "") ??
            payload?.summary ??
            "";
          const parsed = parseInlineMediaDirectives(textRaw);
          const payloadMediaUrls = payload?.mediaUrls?.length
            ? payload.mediaUrls
            : payload?.mediaUrl
              ? [payload.mediaUrl]
              : [];
          const mediaUrls = [...new Set([...payloadMediaUrls, ...parsed.mediaUrls])];
          await sendToMax(replyPeerId, parsed.text, {
            mediaUrls,
            api,
            log,
            audioAsVoice: payload?.audioAsVoice || parsed.audioAsVoice,
            chatKind,
          });
        },
      },
      replyOptions: {
        images: imageUrls.length > 0 ? imageUrls.map((url) => ({ url })) : undefined,
        onToolStart: () => setThinking(),
        onCompactionStart: () => setThinking(),
        onCompactionEnd: () => setThinking(),
      },
    });
  } catch (err) {
    log?.warn?.(`[Max] Dispatch error: ${err.message}`);
  }
}

/**
 * Регистрирует канал Max в OpenClaw: метаданные, конфиг, outbound, status, gateway (long polling)
 * и HTTP-маршрут для webhook.
 *
 * @param {object} api - API плагинов OpenClaw (logger, registerChannel, registerHttpRoute, config, runtime)
 * @returns {void}
 */
export default function register(api) {
  api.logger.info("Initializing Max channel plugin...");

  const maxChannel = {
    id: "max",
    meta: {
      id: "max",
      label: "Max",
      selectionLabel: "Max (Platform API)",
      docsPath: "/channels/max",
      blurb: "Integration with the Russian messenger Max (max.ru).",
      aliases: ["max-messenger"],
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    pairing: {
      idLabel: "userId",
    },
    config: {
      listAccountIds,
      resolveAccount,
      defaultAccountId,
      isConfigured: (account) => Boolean(account?.token),
      unconfiguredReason: (account) =>
        account?.token ? undefined : "Token not set (channels.max.accounts.<id>.token or botToken)",
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.token),
      }),
    },
    configSchema: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          token: { type: "string", minLength: 1 },
          botToken: { type: "string", minLength: 1 },
          defaultAccount: { type: "string" },
          name: { type: "string" },
          dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
          allowFrom: { type: "array" },
          groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
          groupAllowFrom: { type: "array" },
          groups: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                allowFrom: { type: "array" },
                groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
                requireMention: { type: "boolean" },
                systemPrompt: { type: "string" },
              },
            },
          },
          direct: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                allowFrom: { type: "array" },
                dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
                systemPrompt: { type: "string" },
              },
            },
          },
          dms: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                allowFrom: { type: "array" },
                systemPrompt: { type: "string" },
              },
            },
          },
          historyLimit: { type: "number" },
          dmHistoryLimit: { type: "number" },
          textChunkLimit: { type: "number" },
          chunkMode: { type: "string", enum: ["length", "newline"] },
          streaming: { type: "string", enum: ["off", "partial", "block", "progress"] },
          timeoutSeconds: { type: "number" },
          responsePrefix: { type: "string" },
          defaultTo: { type: "string" },
          configWrites: { type: "boolean" },
          linkPreview: { type: "boolean" },
          accounts: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                token: { type: "string" },
                botToken: { type: "string" },
                name: { type: "string" },
                dmPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
                allowFrom: { type: "array" },
                groupPolicy: { type: "string", enum: ["open", "disabled", "allowlist"] },
                groupAllowFrom: { type: "array" },
                groups: { type: "object" },
                direct: { type: "object" },
                dms: { type: "object" },
                historyLimit: { type: "number" },
                dmHistoryLimit: { type: "number" },
                textChunkLimit: { type: "number" },
                chunkMode: { type: "string", enum: ["length", "newline"] },
                streaming: { type: "string" },
                timeoutSeconds: { type: "number" },
                responsePrefix: { type: "string" },
                defaultTo: { type: "string" },
                configWrites: { type: "boolean" },
                linkPreview: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    outbound: {
      deliveryMode: "direct",
      textChunkLimit: 4000,
      sendText: async ({ cfg, to, text, accountId }) => {
        api.logger.debug(`[Max] Sending message to ${to}`);

        const account = resolveAccount(cfg, accountId);
        const token = account?.token;
        if (!token) {
          api.logger.error("[Max] Missing token. Set channels.max.accounts.<id>.token or botToken.");
          return {
            ok: false,
            error: "Missing token",
            channel: "max",
            messageId: "",
          };
        }

        try {
          const bot = new Bot(token);
          const toNum = parseInt(String(to).trim(), 10);
          if (isNaN(toNum)) {
            api.logger.error(`[Max] Invalid recipient id: ${to}`);
            return { ok: false, error: "Invalid recipient id", channel: "max", messageId: "" };
          }

          // Negative IDs are group chats; positive IDs are user DMs
          const result = toNum < 0
            ? await bot.api.sendMessageToChat(toNum, text ?? "")
            : await bot.api.sendMessageToUser(toNum, text ?? "");

          const messageId = result?.body?.mid ?? `max-${Date.now()}`;
          api.logger.debug("[Max] Message sent successfully");
          return {
            ok: true,
            channel: "max",
            messageId: String(messageId),
          };
        } catch (err) {
          api.logger.error(`[Max] API error: ${err.message}`);
          return {
            ok: false,
            error: err.message,
            channel: "max",
            messageId: "",
          };
        }
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
        if (!mediaUrl?.trim()) {
          throw new Error("[Max] sendMedia called without mediaUrl");
        }
        const account = resolveAccount(cfg, accountId);
        const token = account?.token;
        if (!token) {
          throw new Error("[Max] Missing token for sendMedia");
        }
        const bot = new Bot(token);
        const toNum = parseInt(String(to).trim(), 10);
        if (isNaN(toNum)) {
          throw new Error(`[Max] Invalid recipient id: ${to}`);
        }
        const isLikelyAudio = /\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(mediaUrl);
        await sendMaxMessageWithMedia(
          toNum,
          text ?? "",
          [mediaUrl.trim()],
          bot.api,
          api.logger,
          isLikelyAudio,
        );
        api.logger.debug("[Max] Media sent successfully");
        return { channel: "max", messageId: `max-media-${Date.now()}` };
      },
    },
    status: {
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        configured: false,
      },
      buildAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.token),
      }),
      probeAccount: async ({ account, timeoutMs }) =>
        probeMax(account?.token, timeoutMs),
    },
    gateway: {
      startAccount: async (ctx) => {
        const { cfg, accountId, account, abortSignal, log, channelRuntime } = ctx;
        const token = account?.token;
        if (!token) {
          throw new Error(
            `Max token missing for account "${accountId}" (set channels.max.accounts.${accountId}.token or botToken).`
          );
        }

        log?.info?.(`[Max] Starting (official @maxhub/max-bot-api) for account ${accountId}`);

        const bot = new Bot(token);

        bot.catch((err, botCtx) => {
          log?.warn?.(`[Max] Bot error: ${err.message}`);
        });

        const makeSendTextOnly = (chatKind) => (num, t) => {
          if (chatKind === "group") return bot.api.sendMessageToChat(num, t ?? "");
          return bot.api.sendMessageToUser(num, t ?? "");
        };
        const sendToMax = async (toId, text, opts) => {
          await sendToMaxImpl(toId, text, opts, makeSendTextOnly(opts?.chatKind ?? "direct"));
        };
        const sendAction = (chatId, action) => bot.api.sendAction(chatId, action);

        bot.on("message_created", async (botCtx) => {
          log?.info?.(`[Max] Received message`);
          await processMaxUpdate(botCtx.update, {
            cfg,
            accountId,
            api: bot.api,
            channelRuntime,
            log,
            sendToMax,
            sendAction,
          });
        });

        if (abortSignal) {
          abortSignal.addEventListener("abort", () => bot.stop(), { once: true });
        }

        await bot.start();
      },
    },
  };

  api.registerChannel({ plugin: maxChannel });

  /** Максимальный размер тела webhook (байты), защита от DoS. */
  const WEBHOOK_BODY_LIMIT = 512 * 1024; // 512 KB

  api.registerHttpRoute({
    path: "/plugins/max/webhook",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const chunks = [];
      let total = 0;
      try {
        for await (const c of req) {
          total += c.length;
          if (total > WEBHOOK_BODY_LIMIT) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
          chunks.push(c);
        }
      } catch (err) {
        api.logger.warn(`[Max] Webhook read error: ${err?.message}`);
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "Bad request" }));
        return;
      }
      const body = Buffer.concat(chunks).toString("utf-8");
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      api.logger.debug(`[Max] Webhook received: ${data.update_type ?? "unknown"}`);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));

      const cfg = api.config;
      const accountId = defaultAccountId(cfg);
      const account = resolveAccount(cfg, accountId);
      const channelRuntime = api.runtime?.channel;

      if (account?.token && channelRuntime) {
        const bot = new Bot(account.token);
        const makeSendTextOnlyWh = (chatKind) => (num, t) => {
          if (chatKind === "group") return bot.api.sendMessageToChat(num, t ?? "");
          return bot.api.sendMessageToUser(num, t ?? "");
        };
        const sendToMax = async (toId, text, opts) => {
          await sendToMaxImpl(toId, text, opts, makeSendTextOnlyWh(opts?.chatKind ?? "direct"));
        };
        const sendAction = (chatId, action) => bot.api.sendAction(chatId, action);
        const updates = Array.isArray(data) ? data : [data];
        for (const u of updates) {
          processMaxUpdate(u, {
            cfg,
            accountId,
            api: bot.api,
            channelRuntime,
            log: api.logger,
            sendToMax,
            sendAction,
          }).catch((err) => api.logger.warn(`[Max] Webhook process error: ${err.message}`));
        }
      }
    },
  });

  api.logger.info("Max channel plugin initialized (@maxhub/max-bot-api).");
}

// Экспорт для автотестов (unit-тесты чистых функций)
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
};
