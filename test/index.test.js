/**
 * Unit-тесты для openclaw-plugin-max (чистые функции).
 * Запуск: npm test
 * @see node:test, node:assert
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
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
} from "../src/index.js";

describe("normalizeAccountId", () => {
  it("returns default for null/undefined", () => {
    assert.strictEqual(normalizeAccountId(null), DEFAULT_ACCOUNT_ID);
    assert.strictEqual(normalizeAccountId(undefined), DEFAULT_ACCOUNT_ID);
  });
  it("returns default for empty string", () => {
    assert.strictEqual(normalizeAccountId(""), DEFAULT_ACCOUNT_ID);
    assert.strictEqual(normalizeAccountId("   "), DEFAULT_ACCOUNT_ID);
  });
  it("returns default for non-string", () => {
    assert.strictEqual(normalizeAccountId(123), DEFAULT_ACCOUNT_ID);
    assert.strictEqual(normalizeAccountId({}), DEFAULT_ACCOUNT_ID);
  });
  it("returns trimmed id for non-empty string", () => {
    assert.strictEqual(normalizeAccountId("my-account"), "my-account");
    assert.strictEqual(normalizeAccountId("  my-account  "), "my-account");
  });
});

describe("firstDefined", () => {
  it("returns first non-undefined", () => {
    assert.strictEqual(firstDefined(undefined, 1, 2), 1);
    assert.strictEqual(firstDefined(undefined, undefined, "a"), "a");
  });
  it("returns undefined when all undefined", () => {
    assert.strictEqual(firstDefined(undefined, undefined), undefined);
  });
  it("returns first value including falsy", () => {
    assert.strictEqual(firstDefined(0, 1), 0);
    assert.strictEqual(firstDefined("", "x"), "");
  });
});

describe("resolveAccount", () => {
  it("returns default account from base when no accounts", () => {
    const cfg = {
      channels: {
        max: {
          token: "base-token",
          name: "Base",
          dmPolicy: "pairing",
        },
      },
    };
    const acc = resolveAccount(cfg, "default");
    assert.strictEqual(acc.accountId, "default");
    assert.strictEqual(acc.token, "base-token");
    assert.strictEqual(acc.name, "Base");
    assert.strictEqual(acc.dmPolicy, "pairing");
    assert.strictEqual(acc.enabled, true);
  });

  it("merges account over base", () => {
    const cfg = {
      channels: {
        max: {
          token: "base-token",
          dmPolicy: "open",
          accounts: {
            custom: {
              token: "custom-token",
              name: "Custom",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };
    const acc = resolveAccount(cfg, "custom");
    assert.strictEqual(acc.accountId, "custom");
    assert.strictEqual(acc.token, "custom-token");
    assert.strictEqual(acc.name, "Custom");
    assert.strictEqual(acc.dmPolicy, "allowlist");
  });

  it("accepts botToken as alias for token", () => {
    const cfg = {
      channels: {
        max: { botToken: "bot-token" },
      },
    };
    const acc = resolveAccount(cfg);
    assert.strictEqual(acc.token, "bot-token");
  });

  it("returns enabled false when account.enabled is false", () => {
    const cfg = {
      channels: {
        max: {
          token: "t",
          accounts: { off: { token: "t2", enabled: false } },
        },
      },
    };
    const acc = resolveAccount(cfg, "off");
    assert.strictEqual(acc.enabled, false);
  });
});

describe("listAccountIds", () => {
  it("returns empty when no max config", () => {
    assert.deepStrictEqual(listAccountIds({}), []);
    assert.deepStrictEqual(listAccountIds({ channels: {} }), []);
  });
  it("returns [default] when only base token", () => {
    assert.deepStrictEqual(
      listAccountIds({ channels: { max: { token: "x" } } }),
      ["default"]
    );
  });
  it("returns keys of accounts", () => {
    const cfg = {
      channels: {
        max: {
          accounts: {
            a: { token: "1" },
            b: { token: "2" },
          },
        },
      },
    };
    assert.deepStrictEqual(listAccountIds(cfg), ["a", "b"]);
  });
});

describe("defaultAccountId", () => {
  it("returns default when in list", () => {
    const cfg = { channels: { max: { token: "x" } } };
    assert.strictEqual(defaultAccountId(cfg), "default");
  });
  it("returns first account when no default", () => {
    const cfg = {
      channels: {
        max: {
          accounts: {
            first: { token: "1" },
            second: { token: "2" },
          },
        },
      },
    };
    assert.strictEqual(defaultAccountId(cfg), "first");
  });
});

describe("getRecipientId", () => {
  it("returns null when no message or recipient", () => {
    assert.strictEqual(getRecipientId({}), null);
    assert.strictEqual(getRecipientId({ message: {} }), null);
  });
  it("extracts chat_id", () => {
    assert.strictEqual(
      getRecipientId({ message: { recipient: { chat_id: 12345 } } }),
      "12345"
    );
  });
  it("extracts user_id", () => {
    assert.strictEqual(
      getRecipientId({ message: { recipient: { user_id: 999 } } }),
      "999"
    );
  });
});

describe("getSenderId", () => {
  it("returns empty string when no sender", () => {
    assert.strictEqual(getSenderId({}), "");
    assert.strictEqual(getSenderId({ message: {} }), "");
  });
  it("extracts sender user_id", () => {
    assert.strictEqual(
      getSenderId({ message: { sender: { user_id: 111 } } }),
      "111"
    );
    assert.strictEqual(
      getSenderId({ message: { sender: { id: 222 } } }),
      "222"
    );
  });
});

describe("getRecipientType", () => {
  it("returns group when recipient.type === chat", () => {
    assert.strictEqual(
      getRecipientType({ message: { recipient: { type: "chat" } } }),
      "group"
    );
  });
  it("returns direct otherwise", () => {
    assert.strictEqual(
      getRecipientType({ message: { recipient: { type: "user" } } }),
      "direct"
    );
    assert.strictEqual(getRecipientType({ message: { recipient: {} } }), "direct");
  });
});

describe("normalizeAllowFrom", () => {
  it("parses numeric ids and strips max: prefix", () => {
    const r = normalizeAllowFrom(["123", "max:456", " 789 "]);
    assert.deepStrictEqual(r.entries, ["123", "456", "789"]);
    assert.strictEqual(r.hasWildcard, false);
    assert.strictEqual(r.hasEntries, true);
  });
  it("detects wildcard", () => {
    const r = normalizeAllowFrom(["1", "*"]);
    assert.strictEqual(r.hasWildcard, true);
    assert.ok(!r.entries.includes("*"));
  });
  it("empty list", () => {
    const r = normalizeAllowFrom([]);
    assert.strictEqual(r.entries.length, 0);
    assert.strictEqual(r.hasEntries, false);
  });
});

describe("mergeDmAllowFromSources", () => {
  it("merges allowFrom and store when not allowlist", () => {
    const r = mergeDmAllowFromSources(["1", "2"], ["3"], "pairing");
    assert.deepStrictEqual(r, ["1", "2", "3"]);
  });
  it("excludes store when dmPolicy is allowlist", () => {
    const r = mergeDmAllowFromSources(["1"], ["2"], "allowlist");
    assert.deepStrictEqual(r, ["1"]);
  });
});

describe("isSenderInAllow", () => {
  it("returns false when no entries", () => {
    assert.strictEqual(isSenderInAllow({ entries: [], hasWildcard: false, hasEntries: false }, "1"), false);
  });
  it("returns true when hasWildcard", () => {
    assert.strictEqual(isSenderInAllow({ entries: [], hasWildcard: true, hasEntries: true }, "any"), true);
  });
  it("returns true when senderId in entries", () => {
    const allow = normalizeAllowFrom(["111", "222"]);
    assert.strictEqual(isSenderInAllow(allow, "111"), true);
    assert.strictEqual(isSenderInAllow(allow, "222"), true);
  });
  it("returns false when senderId not in entries", () => {
    const allow = normalizeAllowFrom(["111"]);
    assert.strictEqual(isSenderInAllow(allow, "999"), false);
    assert.ok(!isSenderInAllow(allow, "")); // пустой senderId — не в списке (функция возвращает falsy)
  });
});

describe("buildMaxBodyWithAttachments", () => {
  it("returns text only when no attachments", () => {
    const r = buildMaxBodyWithAttachments({ body: { text: "Hello" } });
    assert.strictEqual(r.bodyText, "Hello");
    assert.deepStrictEqual(r.imageUrls, []);
  });
  it("appends media placeholders and collects image URLs", () => {
    const r = buildMaxBodyWithAttachments({
      body: {
        text: "Check this",
        attachments: [
          { type: "image", payload: { url: "https://example.com/1.jpg" } },
          { type: "video", payload: { url: "https://example.com/v.mp4" } },
        ],
      },
    });
    assert.ok(r.bodyText.includes("Check this"));
    assert.ok(r.bodyText.includes("<media:image>"));
    assert.ok(r.bodyText.includes("<media:video>"));
    assert.deepStrictEqual(r.imageUrls, ["https://example.com/1.jpg"]);
  });
  it("returns only placeholders when no text", () => {
    const r = buildMaxBodyWithAttachments({
      body: { attachments: [{ type: "audio", payload: {} }] },
    });
    assert.strictEqual(r.bodyText, "<media:audio>");
    assert.deepStrictEqual(r.imageUrls, []);
  });
});
