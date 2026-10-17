import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../src/errors.ts";
import { maskIdNumber, validateFintracCorporate, validateFintracIndividual } from "../src/compliance/fintrac.ts";
import { canTransition, canUpload, requiredSlots, type DocumentTypeRule } from "../src/compliance/rules.ts";
import { contentMatchesMime } from "../src/compliance/storage.ts";
import { validateCreateDeal, validateReview } from "../src/compliance/validation.ts";

const TODAY = "2026-10-17";

const TYPES: DocumentTypeRule[] = [
  { id: "t-200", code: "FORM_200", requiredFor: ["LISTING", "DUAL"], slotScope: "DEAL", isActive: true },
  { id: "t-aps", code: "APS", requiredFor: ["BUYER", "DUAL"], slotScope: "DEAL", isActive: true },
  { id: "t-320", code: "FORM_320", requiredFor: ["BUYER", "DUAL"], slotScope: "DEAL", isActive: true },
  { id: "t-ind", code: "FINTRAC_INDIVIDUAL", requiredFor: ["BUYER", "LISTING", "DUAL"], slotScope: "CLIENT_INDIVIDUAL", isActive: true },
  { id: "t-corp", code: "FINTRAC_CORPORATE", requiredFor: ["BUYER", "LISTING", "DUAL"], slotScope: "CLIENT_CORPORATION", isActive: true },
];

const codes = (specs: { code: string; partyId: string | null }[]) => specs.map((s) => `${s.code}${s.partyId ? `:${s.partyId}` : ""}`);

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError, String(err));
    return err.issues.map((i) => i.field).sort();
  }
  assert.fail("expected a ValidationError");
}

// ── 1. Mandatory slots ───────────────────────────────────────────────────────

test("buyer deal: APS, Form 320 and a FINTRAC ID record per individual buyer", () => {
  const specs = requiredSlots("BUYER", [
    { id: "b1", role: "BUYER", entityType: "INDIVIDUAL" },
    { id: "b2", role: "BUYER", entityType: "INDIVIDUAL" },
    { id: "s1", role: "SELLER", entityType: "INDIVIDUAL" }, // the other side: not our client
  ], TYPES);
  assert.deepEqual(codes(specs), ["APS", "FORM_320", "FINTRAC_INDIVIDUAL:b1", "FINTRAC_INDIVIDUAL:b2"]);
});

test("seller deal: Form 200, FINTRAC ID record, and the corporate record only when the seller is a corporation", () => {
  assert.deepEqual(
    codes(requiredSlots("LISTING", [{ id: "s1", role: "SELLER", entityType: "INDIVIDUAL" }], TYPES)),
    ["FORM_200", "FINTRAC_INDIVIDUAL:s1"],
  );
  assert.deepEqual(
    codes(requiredSlots("LISTING", [
      { id: "s1", role: "SELLER", entityType: "INDIVIDUAL" },
      { id: "c1", role: "SELLER", entityType: "CORPORATION" },
    ], TYPES)),
    ["FORM_200", "FINTRAC_INDIVIDUAL:s1", "FINTRAC_CORPORATE:c1"],
  );
});

test("inactive document types and lease sides add nothing", () => {
  const inactive = TYPES.map((t) => ({ ...t, isActive: t.code !== "FORM_320" }));
  assert.ok(!codes(requiredSlots("BUYER", [], inactive)).includes("FORM_320"));
  assert.deepEqual(requiredSlots("TENANT", [{ id: "t1", role: "TENANT", entityType: "INDIVIDUAL" }], TYPES), []);
});

// ── 3. Lifecycle ─────────────────────────────────────────────────────────────

test("lifecycle: Missing -> Pending Review -> Approved | Needs Revision -> Pending Review", () => {
  assert.ok(canTransition("MISSING", "PENDING_REVIEW"));
  assert.ok(canTransition("PENDING_REVIEW", "APPROVED"));
  assert.ok(canTransition("PENDING_REVIEW", "NEEDS_REVISION"));
  assert.ok(canTransition("NEEDS_REVISION", "PENDING_REVIEW"));
  assert.ok(!canTransition("MISSING", "APPROVED"));       // can't approve nothing
  assert.ok(!canTransition("NEEDS_REVISION", "APPROVED")); // needs a new upload first
  assert.ok(!canTransition("APPROVED", "PENDING_REVIEW")); // approved is final
  assert.ok(canUpload("NEEDS_REVISION") && !canUpload("APPROVED"));
});

// ── 2. FINTRAC metadata ──────────────────────────────────────────────────────

const individual = {
  verificationDate: "2026-10-15",
  fullLegalName: "Maria Elena Santos",
  dateOfBirth: "1988-04-02",
  address: "12 King St W, Hamilton ON L8P 1A1",
  occupation: "Registered nurse",
  idType: "DRIVERS_LICENCE",
  idNumber: "S1234-56789-80402",
  issuingJurisdiction: "Ontario, Canada",
  expiryDate: "2029-04-02",
  thirdPartyDetermination: false,
};

test("FINTRAC individual: a complete record passes and defaults to in-person verification", () => {
  const record = validateFintracIndividual(individual, TODAY);
  assert.equal(record.schema, "FINTRAC_INDIVIDUAL_V1");
  assert.equal(record.verificationMode, "IN_PERSON");
  assert.equal(record.thirdParty, null);
  assert.equal(maskIdNumber(record.idNumber), "•••• 0402");
});

test("FINTRAC individual: expired ID, future verification, missing fields and bad ID type are all reported", () => {
  assert.deepEqual(issuesOf(() => validateFintracIndividual({ ...individual, expiryDate: "2026-10-14" }, TODAY)), ["metadata.expiryDate"]);
  assert.deepEqual(
    issuesOf(() => validateFintracIndividual({
      ...individual, verificationDate: "2026-10-20", idType: "LIBRARY_CARD", occupation: "", idNumber: "#!",
    }, TODAY)),
    ["metadata.idNumber", "metadata.idType", "metadata.occupation", "metadata.verificationDate"],
  );
});

test("FINTRAC individual: third-party flag true requires the third party's details", () => {
  assert.deepEqual(
    issuesOf(() => validateFintracIndividual({ ...individual, thirdPartyDetermination: true }, TODAY)),
    ["metadata.thirdParty"],
  );
  assert.deepEqual(
    issuesOf(() => validateFintracIndividual({ ...individual, thirdPartyDetermination: "no" }, TODAY)),
    ["metadata.thirdPartyDetermination"],
  );
  const withThirdParty = validateFintracIndividual({
    ...individual,
    thirdPartyDetermination: true,
    thirdParty: { name: "Santos Holdings Inc.", address: "1 Bay St, Toronto", relationship: "Purchasing for her company" },
  }, TODAY);
  assert.equal(withThirdParty.thirdParty?.name, "Santos Holdings Inc.");
});

const corporate = {
  verificationDate: "2026-10-15",
  corporationLegalName: "2468013 Ontario Inc.",
  registrationNumber: "2468013",
  jurisdictionOfIncorporation: "Ontario",
  registeredAddress: "100 Main St E, Stoney Creek ON",
  natureOfBusiness: "Real estate holding",
  verificationSource: "CERTIFICATE_OF_CORPORATE_STATUS",
  verificationSourceReference: "Ontario Business Registry profile report, 2026-10-15",
  directors: ["Paul Chen"],
  beneficialOwners: [{ fullName: "Paul Chen", address: "8 Elm Ave, Grimsby ON", ownershipPercent: 100 }],
  controlStructure: "Single shareholder and director",
  thirdPartyDetermination: false,
};

test("FINTRAC corporate: owners must hold 25%+, total ≤ 100%, or a reason plus senior officer", () => {
  assert.equal(validateFintracCorporate(corporate, TODAY).beneficialOwners.length, 1);
  assert.deepEqual(
    issuesOf(() => validateFintracCorporate({
      ...corporate,
      beneficialOwners: [
        { fullName: "A", address: "x", ownershipPercent: 60 },
        { fullName: "B", address: "y", ownershipPercent: 50 },
      ],
    }, TODAY)),
    ["metadata.beneficialOwners"],
  );
  assert.deepEqual(
    issuesOf(() => validateFintracCorporate({
      ...corporate, beneficialOwners: [{ fullName: "A", address: "x", ownershipPercent: 10 }],
    }, TODAY)),
    ["metadata.beneficialOwners[0].ownershipPercent"],
  );
  assert.deepEqual(
    issuesOf(() => validateFintracCorporate({ ...corporate, beneficialOwners: [] }, TODAY)),
    ["metadata.noBeneficialOwnerReason", "metadata.seniorManagingOfficer"],
  );
});

// ── 4. Review rules ──────────────────────────────────────────────────────────

test("review: Needs Revision requires a comment that says what to fix", () => {
  const fileId = "6f1c1f43-7c55-4b8e-9d1a-0d6a1f0b9a01";
  assert.deepEqual(issuesOf(() => validateReview({ decision: "NEEDS_REVISION", fileId })), ["comment"]);
  assert.deepEqual(issuesOf(() => validateReview({ decision: "NEEDS_REVISION", comment: "fix it", fileId })), ["comment"]);
  assert.equal(validateReview({ decision: "NEEDS_REVISION", comment: "FINTRAC ID expired", fileId }).comment, "FINTRAC ID expired");
  assert.equal(validateReview({ decision: "APPROVED", fileId }).comment, null);
});

test("deal: a buyer deal needs a buyer client and exactly one primary agent", () => {
  const agentId = "6f1c1f43-7c55-4b8e-9d1a-0d6a1f0b9a01";
  const base = {
    side: "BUYER", streetAddress: "1 Main", city: "Hamilton", salePrice: "700000", offerDate: "2026-10-10",
    closeDate: "2026-12-01", depositAmount: "35000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "17500",
    agents: [{ userId: agentId, role: "PRIMARY", splitPct: 80 }],
    parties: [{ role: "SELLER", fullName: "Other Side" }],
  };
  assert.deepEqual(issuesOf(() => validateCreateDeal(base)), ["parties"]);
  assert.deepEqual(
    issuesOf(() => validateCreateDeal({
      ...base, parties: [{ role: "BUYER", fullName: "Jo Buyer" }], agents: [{ userId: agentId, role: "CO_AGENT", splitPct: 80 }],
    })),
    ["agents"],
  );
});

test("uploads: file content must match its declared type", () => {
  assert.ok(contentMatchesMime(Buffer.from("%PDF-1.7\n..."), "application/pdf"));
  assert.ok(!contentMatchesMime(Buffer.from("MZ\x90\x00 not a pdf"), "application/pdf"));
});
