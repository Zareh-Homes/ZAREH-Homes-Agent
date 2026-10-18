/**
 * FINTRAC records hold identity numbers, dates of birth and addresses. Those
 * fields are encrypted (AES-256-GCM) before they're stored and decrypted only
 * for staff who open the full record; every such view is audited. The last
 * four characters of the ID number are kept in clear for the masked summary.
 */

import type { FieldCipher } from "../security/crypto.ts";
import type { FintracRecord } from "./fintrac.ts";

type Stored = Record<string, unknown>;

export function sealFintrac(record: FintracRecord, cipher: FieldCipher): Stored {
  if (record.schema === "FINTRAC_INDIVIDUAL_V1") {
    return {
      ...record,
      idNumber: cipher.encrypt(record.idNumber),
      idNumberLast4: record.idNumber.replace(/[\s-]/g, "").slice(-4),
      dateOfBirth: cipher.encrypt(record.dateOfBirth),
      address: cipher.encrypt(record.address),
      ...(record.thirdParty ? { thirdParty: { ...record.thirdParty, address: cipher.encrypt(record.thirdParty.address) } } : {}),
    };
  }
  return {
    ...record,
    beneficialOwners: record.beneficialOwners.map((o) => ({ ...o, address: cipher.encrypt(o.address) })),
    ...(record.thirdParty ? { thirdParty: { ...record.thirdParty, address: cipher.encrypt(record.thirdParty.address) } } : {}),
  };
}

/** Decrypts the sealed fields; rows stored before encryption pass through unchanged. */
export function openFintrac(stored: Stored | null, cipher: FieldCipher): FintracRecord | null {
  if (!stored) return null;
  const open = (v: unknown) => (cipher.isSealed(v) ? cipher.decrypt(v) : v);
  const out: Stored = { ...stored };
  for (const k of ["idNumber", "dateOfBirth", "address"]) if (k in out) out[k] = open(out[k]);
  delete out.idNumberLast4;
  if (out.thirdParty && typeof out.thirdParty === "object") {
    const tp = out.thirdParty as Stored;
    out.thirdParty = { ...tp, address: open(tp.address) };
  }
  if (Array.isArray(out.beneficialOwners)) {
    out.beneficialOwners = (out.beneficialOwners as Stored[]).map((o) => ({ ...o, address: open(o.address) }));
  }
  return out as unknown as FintracRecord;
}
