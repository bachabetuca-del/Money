import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwner, isOwnerChat } from "./owner-policy";

test("owner access requires the configured verified email, not an arbitrary account", () => {
  const user = (emailAddress: string, status: string) => ({
    emailAddresses: [{ emailAddress, verification: { status } }],
  });
  assert.equal(isOwner(user("OWNER@example.com", "verified"), "owner@example.com"), true);
  assert.equal(isOwner(user("other@example.com", "verified"), "owner@example.com"), false);
  assert.equal(isOwner(user("owner@example.com", "unverified"), "owner@example.com"), false);
  assert.equal(isOwner(user("owner@example.com", "verified"), undefined), false);
  assert.equal(isOwner({ emailAddresses: [] }, "owner@example.com"), false);
});

test("Telegram ownership is fail-closed and cannot be replaced by another /start", () => {
  const original = process.env.TELEGRAM_OWNER_CHAT_ID;
  try {
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    assert.equal(isOwnerChat("123456"), false);
    process.env.TELEGRAM_OWNER_CHAT_ID = "123456";
    assert.equal(isOwnerChat("123456"), true);
    assert.equal(isOwnerChat("654321"), false);
    assert.equal(isOwnerChat(null), false);
    process.env.TELEGRAM_OWNER_CHAT_ID = "not-a-chat";
    assert.equal(isOwnerChat("not-a-chat"), false);
  } finally {
    if (original === undefined) delete process.env.TELEGRAM_OWNER_CHAT_ID;
    else process.env.TELEGRAM_OWNER_CHAT_ID = original;
  }
});
