type OwnerUser = {
  emailAddresses: Array<{
    emailAddress: string;
    verification: { status: string } | null;
  }>;
};

export function isOwner(user: OwnerUser, ownerEmail: string | undefined) {
  const expected = ownerEmail?.trim().toLowerCase();
  return Boolean(expected && user.emailAddresses.some(email =>
    email.verification?.status === "verified" &&
    email.emailAddress.trim().toLowerCase() === expected));
}

export function ownerChatId() {
  const value = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  return value && /^-?\d+$/.test(value) ? value : null;
}

export function isOwnerChat(chatId: string | null | undefined) {
  const owner = ownerChatId();
  return Boolean(owner && chatId === owner);
}
