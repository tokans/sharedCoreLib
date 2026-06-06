/**
 * Emergency / ICE contact-extraction primitives — app-agnostic.
 *
 * Deterministic keyword + regex matching (no LLM — a hard constraint of the
 * suite): does an action read as "call/contact someone", and pull a dialable
 * `tel:` / `mailto:` href out of a free-text contact string. The APP supplies its
 * own ICE-card fields, disclaimer copy, and which records carry contacts; this
 * module only provides the pure extraction helpers.
 */

/** Verbs/phrases that signal an action involves reaching a person. */
export const CONTACT_PHRASES = [
  "call",
  "contact",
  "phone",
  "ring",
  "dial",
  "reach out",
  "reach",
  "speak to",
  "speak with",
  "talk to",
  "get in touch",
  "notify",
  "inform",
  "tell",
  "email",
  "message",
  "whatsapp",
];

/**
 * True when a note reads as "call/contact someone". Whole-word, case-insensitive
 * matching so "recall" or "information" don't false-trigger. Pass custom phrases
 * to extend/replace the default set.
 */
export function mentionsContact(
  action: string | null | undefined,
  phrases: string[] = CONTACT_PHRASES,
): boolean {
  if (!action) return false;
  const h = action.toLowerCase();
  return phrases.some((p) =>
    new RegExp(`(^|[^a-z])${p.replace(/\s+/g, "\\s+")}([^a-z]|$)`).test(h),
  );
}

/**
 * Pull the first phone-number-looking run of digits out of a free-text contact
 * string, returning a `tel:` href, or null when there's nothing dialable. Keeps a
 * leading '+'; requires at least 7 digits so stray numbers don't masquerade.
 */
export function telHref(contact: string | null | undefined): string | null {
  if (!contact) return null;
  const m = contact.match(/\+?[\d][\d\s().-]{6,}\d/);
  if (!m) return null;
  const plus = m[0].trim().startsWith("+");
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `tel:${plus ? "+" : ""}${digits}`;
}

/** Pull the first email out of a free-text contact string as a `mailto:` href, or null. */
export function mailtoHref(contact: string | null | undefined): string | null {
  if (!contact) return null;
  const m = contact.match(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/i);
  return m ? `mailto:${m[0]}` : null;
}

/** True when a record is ready to act on: an action that needs a contact has one. */
export function hasActionableContact(rec: {
  contact: string | null;
  emergency_action: string | null;
}): boolean {
  return mentionsContact(rec.emergency_action) && !!rec.contact?.trim();
}
