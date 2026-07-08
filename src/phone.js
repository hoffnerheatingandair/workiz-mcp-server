// Normalizes phone numbers to E.164 (e.g. "+14125551234"), assuming a US/CA
// number when no country code is present. Used as the match key when
// reconciling GHL contacts with Workiz clients.
export function toE164(raw, defaultCountry = "US") {
  if (!raw) return null;
  const trimmed = String(raw).trim();

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (defaultCountry === "US") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }

  return `+${digits}`;
}

// Strips the country code off an E.164 number so it matches Workiz's plain-
// digit phone field (e.g. "+14125551234" -> "4125551234"). Only strips a
// US/CA "+1" prefix, since Workiz's Phone field has no separate country-code
// field; other country codes are left as digits-with-code.
export function fromE164ToWorkizPhone(e164) {
  if (!e164) return null;
  const digits = e164.replace(/^\+/, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}
