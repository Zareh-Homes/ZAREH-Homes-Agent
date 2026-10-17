/**
 * FINTRAC record metadata: the structured fields a FINTRAC upload must carry.
 * Pure validators; today's date is passed in.
 *
 * Individual: government-issued photo ID method, plus the identity facts the
 * record must hold (name, address, date of birth, occupation) and the
 * third-party determination.
 *
 * Corporation: confirmation of existence from an authoritative source,
 * directors, beneficial owners (25 %+ directly or indirectly), ownership /
 * control structure and the third-party determination.
 */

import { Reader } from "../lib/reader.ts";

export const ID_TYPES = [
  "DRIVERS_LICENCE",
  "PASSPORT",
  "PERMANENT_RESIDENT_CARD",
  "PROVINCIAL_PHOTO_ID_CARD",
  "SECURE_CERTIFICATE_OF_INDIAN_STATUS",
  "OTHER_GOVERNMENT_PHOTO_ID",
] as const;

export const VERIFICATION_MODES = ["IN_PERSON", "REMOTE_AUTHENTICATED"] as const;

export const CORPORATE_SOURCES = [
  "CERTIFICATE_OF_CORPORATE_STATUS",
  "GOVERNMENT_REGISTRY_RECORD",
  "OTHER_AUTHORITATIVE_RECORD",
] as const;

/** FINTRAC beneficial ownership threshold */
export const BENEFICIAL_OWNER_MIN_PERCENT = 25;

export interface ThirdParty {
  name: string;
  address: string;
  relationship: string;
}

export interface FintracIndividualRecord {
  schema: "FINTRAC_INDIVIDUAL_V1";
  verificationDate: string;
  verificationMode: (typeof VERIFICATION_MODES)[number];
  fullLegalName: string;
  dateOfBirth: string;
  address: string;
  occupation: string;
  idType: (typeof ID_TYPES)[number];
  idNumber: string;
  issuingJurisdiction: string;
  expiryDate: string;
  thirdPartyDetermination: boolean; // true = client is acting on behalf of a third party
  thirdParty: ThirdParty | null;
}

export interface BeneficialOwner {
  fullName: string;
  address: string;
  ownershipPercent: number;
}

export interface FintracCorporateRecord {
  schema: "FINTRAC_CORPORATE_V1";
  verificationDate: string;
  corporationLegalName: string;
  registrationNumber: string;
  jurisdictionOfIncorporation: string;
  registeredAddress: string;
  natureOfBusiness: string;
  verificationSource: (typeof CORPORATE_SOURCES)[number];
  verificationSourceReference: string;
  directors: string[];
  beneficialOwners: BeneficialOwner[];
  noBeneficialOwnerReason: string | null; // when nobody holds 25 %+
  seniorManagingOfficer: string | null; // required alongside noBeneficialOwnerReason
  controlStructure: string;
  thirdPartyDetermination: boolean;
  thirdParty: ThirdParty | null;
}

export type FintracRecord = FintracIndividualRecord | FintracCorporateRecord;

const ID_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]{2,29}$/;

function readThirdParty(r: Reader): { thirdPartyDetermination: boolean; thirdParty: ThirdParty | null } {
  const thirdPartyDetermination = r.bool("thirdPartyDetermination");
  if (!thirdPartyDetermination) {
    r.check(!r.has("thirdParty"), "thirdParty", "must be left out when thirdPartyDetermination is false");
    return { thirdPartyDetermination, thirdParty: null };
  }
  if (!r.has("thirdParty")) {
    r.fail("thirdParty", "is required when thirdPartyDetermination is true (name, address, relationship)");
    return { thirdPartyDetermination, thirdParty: null };
  }
  const t = r.nested("thirdParty", ["name", "address", "relationship"]);
  return {
    thirdPartyDetermination,
    thirdParty: { name: t.text("name", 200), address: t.text("address", 300), relationship: t.text("relationship", 200) },
  };
}

/** @param prefix where the metadata sits in the request, for error paths */
export function validateFintracIndividual(raw: unknown, today: string, prefix = "metadata"): FintracIndividualRecord {
  const r = new Reader(raw, [
    "verificationDate", "verificationMode", "fullLegalName", "dateOfBirth", "address", "occupation",
    "idType", "idNumber", "issuingJurisdiction", "expiryDate", "thirdPartyDetermination", "thirdParty",
  ], prefix);

  const record: FintracIndividualRecord = {
    schema: "FINTRAC_INDIVIDUAL_V1",
    verificationDate: r.pastDate("verificationDate", today),
    verificationMode: r.has("verificationMode") ? r.oneOf("verificationMode", VERIFICATION_MODES) : "IN_PERSON",
    fullLegalName: r.text("fullLegalName", 200, 2),
    dateOfBirth: r.pastDate("dateOfBirth", today),
    address: r.text("address", 300),
    occupation: r.text("occupation", 200),
    idType: r.oneOf("idType", ID_TYPES),
    idNumber: r.text("idNumber", 30),
    issuingJurisdiction: r.text("issuingJurisdiction", 100),
    expiryDate: r.date("expiryDate"),
    ...readThirdParty(r),
  };

  if (record.idNumber) {
    r.check(ID_NUMBER.test(record.idNumber), "idNumber", "must be 3–30 letters, digits, spaces or dashes");
  }
  // The ID has to be valid on the day it was used to verify the client
  if (record.expiryDate && record.verificationDate) {
    r.check(
      record.expiryDate >= record.verificationDate,
      "expiryDate",
      `ID was already expired on the verification date (${record.verificationDate})`,
    );
  }
  if (record.dateOfBirth && record.verificationDate) {
    r.check(record.dateOfBirth < record.verificationDate, "dateOfBirth", "must be before the verification date");
  }
  r.done();
  return record;
}

export function validateFintracCorporate(raw: unknown, today: string, prefix = "metadata"): FintracCorporateRecord {
  const r = new Reader(raw, [
    "verificationDate", "corporationLegalName", "registrationNumber", "jurisdictionOfIncorporation",
    "registeredAddress", "natureOfBusiness", "verificationSource", "verificationSourceReference", "directors",
    "beneficialOwners", "noBeneficialOwnerReason", "seniorManagingOfficer", "controlStructure",
    "thirdPartyDetermination", "thirdParty",
  ], prefix);

  const owners = r.has("beneficialOwners")
    ? r.objects("beneficialOwners", ["fullName", "address", "ownershipPercent"], { max: 4 })
    : [];

  const record: FintracCorporateRecord = {
    schema: "FINTRAC_CORPORATE_V1",
    verificationDate: r.pastDate("verificationDate", today),
    corporationLegalName: r.text("corporationLegalName", 300, 2),
    registrationNumber: r.text("registrationNumber", 50),
    jurisdictionOfIncorporation: r.text("jurisdictionOfIncorporation", 100),
    registeredAddress: r.text("registeredAddress", 300),
    natureOfBusiness: r.text("natureOfBusiness", 300),
    verificationSource: r.oneOf("verificationSource", CORPORATE_SOURCES),
    verificationSourceReference: r.text("verificationSourceReference", 300),
    directors: r.textList("directors", 50, 200),
    beneficialOwners: owners.map((o) => ({
      fullName: o.text("fullName", 200),
      address: o.text("address", 300),
      ownershipPercent: o.percent("ownershipPercent", BENEFICIAL_OWNER_MIN_PERCENT, 100),
    })),
    noBeneficialOwnerReason: r.optionalText("noBeneficialOwnerReason", 1000),
    seniorManagingOfficer: r.optionalText("seniorManagingOfficer", 200),
    controlStructure: r.text("controlStructure", 2000),
    ...readThirdParty(r),
  };

  if (record.beneficialOwners.length === 0) {
    // Nobody at 25 %+: FINTRAC still wants the reason and the most senior managing officer
    r.check(record.noBeneficialOwnerReason !== null, "noBeneficialOwnerReason",
      "is required when no beneficial owners are listed");
    r.check(record.seniorManagingOfficer !== null, "seniorManagingOfficer",
      "is required when no beneficial owners are listed");
  } else {
    const total = record.beneficialOwners.reduce((sum, o) => sum + o.ownershipPercent, 0);
    r.check(total <= 100, "beneficialOwners", "ownership adds up to more than 100%");
  }
  r.done();
  return record;
}

/** Last 4 of the ID number, for views that shouldn't show the whole thing. */
export function maskIdNumber(idNumber: string): string {
  const compact = idNumber.replace(/[\s-]/g, "");
  return `•••• ${compact.slice(-4)}`;
}
