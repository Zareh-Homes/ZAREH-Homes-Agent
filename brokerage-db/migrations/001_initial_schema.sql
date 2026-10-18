-- 001 – Initial schema (the original v1 data model), generated from it with prisma migrate diff.
-- Everything after it is a numbered migration. Applied by brokerage-db/migrate.sh.

BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('ADMIN', 'MANAGING_BROKER', 'FILE_REVIEWER', 'AGENT');

-- CreateEnum
CREATE TYPE "public"."ListingStatus" AS ENUM ('ACTIVE', 'PENDING', 'CLOSED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."PropertyType" AS ENUM ('DETACHED', 'SEMI_DETACHED', 'TOWNHOUSE', 'CONDO_APARTMENT', 'CONDO_TOWNHOUSE', 'PRE_CONSTRUCTION', 'MULTIPLEX', 'COMMERCIAL', 'LAND', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."DealSide" AS ENUM ('LISTING', 'BUYER', 'DUAL', 'LANDLORD', 'TENANT');

-- CreateEnum
CREATE TYPE "public"."DealStatus" AS ENUM ('CONDITIONAL', 'FIRM', 'CLOSED', 'COLLAPSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."DepositStatus" AS ENUM ('NOT_DUE', 'AWAITING', 'RECEIVED', 'HELD_ELSEWHERE', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."DepositHolder" AS ENUM ('OUR_BROKERAGE', 'COOP_BROKERAGE', 'LAWYER', 'BUILDER');

-- CreateEnum
CREATE TYPE "public"."DealAgentRole" AS ENUM ('PRIMARY', 'CO_AGENT', 'REFERRAL');

-- CreateEnum
CREATE TYPE "public"."PartyRole" AS ENUM ('SELLER', 'BUYER', 'LANDLORD', 'TENANT', 'SELLER_LAWYER', 'BUYER_LAWYER', 'COOP_BROKERAGE');

-- CreateEnum
CREATE TYPE "public"."TrustEntryType" AS ENUM ('DEPOSIT_RECEIVED', 'DISBURSEMENT_TO_GENERAL', 'DISBURSEMENT_TO_COOP', 'REFUND_TO_PAYER', 'REVERSAL');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('CHEQUE', 'BANK_DRAFT', 'EFT', 'WIRE');

-- CreateEnum
CREATE TYPE "public"."DocumentStatus" AS ENUM ('MISSING', 'PENDING', 'APPROVED', 'REJECTED', 'WAIVED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "role" "public"."UserRole" NOT NULL DEFAULT 'AGENT',
    "recoRegistrationNo" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Listing" (
    "id" UUID NOT NULL,
    "mlsNumber" TEXT,
    "streetAddress" TEXT NOT NULL,
    "unit" TEXT,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL DEFAULT 'ON',
    "postalCode" TEXT,
    "propertyType" "public"."PropertyType" NOT NULL,
    "listPrice" DECIMAL(12,2) NOT NULL,
    "status" "public"."ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "listingDate" DATE NOT NULL,
    "expiryDate" DATE,
    "listingAgentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Transaction" (
    "id" UUID NOT NULL,
    "dealNumber" TEXT NOT NULL,
    "side" "public"."DealSide" NOT NULL,
    "status" "public"."DealStatus" NOT NULL DEFAULT 'CONDITIONAL',
    "listingId" UUID,
    "streetAddress" TEXT NOT NULL,
    "unit" TEXT,
    "city" TEXT NOT NULL,
    "mlsNumber" TEXT,
    "salePrice" DECIMAL(12,2) NOT NULL,
    "offerDate" DATE NOT NULL,
    "conditionsDueDate" DATE,
    "firmDate" DATE,
    "closeDate" DATE NOT NULL,
    "depositAmount" DECIMAL(12,2) NOT NULL,
    "depositDueDate" DATE,
    "depositHolder" "public"."DepositHolder" NOT NULL,
    "depositStatus" "public"."DepositStatus" NOT NULL DEFAULT 'AWAITING',
    "totalGci" DECIMAL(12,2) NOT NULL,
    "commissionRatePct" DECIMAL(5,3),
    "coopBrokerageName" TEXT,
    "coopAgentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TransactionAgent" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "public"."DealAgentRole" NOT NULL DEFAULT 'PRIMARY',
    "splitPct" DECIMAL(5,2) NOT NULL,
    "grossShare" DECIMAL(12,2) NOT NULL,
    "brokerageFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPayout" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "TransactionAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TransactionParty" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "role" "public"."PartyRole" NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "fintracIdVerifiedAt" TIMESTAMP(3),
    "fintracIdMethod" TEXT,

    CONSTRAINT "TransactionParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TrustAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TrustLedgerEntry" (
    "id" UUID NOT NULL,
    "trustAccountId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "entryType" "public"."TrustEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "public"."PaymentMethod" NOT NULL,
    "referenceNo" TEXT,
    "receiptNumber" INTEGER,
    "counterparty" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "memo" TEXT,
    "reversesEntryId" UUID,
    "enteredById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "bankMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TrustReconciliation" (
    "id" UUID NOT NULL,
    "trustAccountId" UUID NOT NULL,
    "periodEnd" DATE NOT NULL,
    "bankBalance" DECIMAL(12,2) NOT NULL,
    "ledgerBalance" DECIMAL(12,2) NOT NULL,
    "outstandingItems" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isBalanced" BOOLEAN NOT NULL,
    "completedById" UUID NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "TrustReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DocumentType" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "formNumber" TEXT,
    "requiredFor" "public"."DealSide"[],
    "forListing" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DocumentSlot" (
    "id" UUID NOT NULL,
    "documentTypeId" UUID NOT NULL,
    "listingId" UUID,
    "transactionId" UUID,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'MISSING',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "dueDate" DATE,
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DocumentFile" (
    "id" UUID NOT NULL,
    "slotId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_recoRegistrationNo_key" ON "public"."User"("recoRegistrationNo");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "public"."User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_mlsNumber_key" ON "public"."Listing"("mlsNumber");

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "public"."Listing"("status");

-- CreateIndex
CREATE INDEX "Listing_listingAgentId_status_idx" ON "public"."Listing"("listingAgentId", "status");

-- CreateIndex
CREATE INDEX "Listing_city_idx" ON "public"."Listing"("city");

-- CreateIndex
CREATE INDEX "Listing_listingDate_idx" ON "public"."Listing"("listingDate");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_dealNumber_key" ON "public"."Transaction"("dealNumber");

-- CreateIndex
CREATE INDEX "Transaction_status_idx" ON "public"."Transaction"("status");

-- CreateIndex
CREATE INDEX "Transaction_closeDate_idx" ON "public"."Transaction"("closeDate");

-- CreateIndex
CREATE INDEX "Transaction_listingId_idx" ON "public"."Transaction"("listingId");

-- CreateIndex
CREATE INDEX "Transaction_depositStatus_depositDueDate_idx" ON "public"."Transaction"("depositStatus", "depositDueDate");

-- CreateIndex
CREATE INDEX "TransactionAgent_userId_idx" ON "public"."TransactionAgent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAgent_transactionId_userId_key" ON "public"."TransactionAgent"("transactionId", "userId");

-- CreateIndex
CREATE INDEX "TransactionParty_transactionId_role_idx" ON "public"."TransactionParty"("transactionId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "TrustLedgerEntry_receiptNumber_key" ON "public"."TrustLedgerEntry"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TrustLedgerEntry_reversesEntryId_key" ON "public"."TrustLedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "TrustLedgerEntry_transactionId_effectiveDate_idx" ON "public"."TrustLedgerEntry"("transactionId", "effectiveDate");

-- CreateIndex
CREATE INDEX "TrustLedgerEntry_trustAccountId_effectiveDate_idx" ON "public"."TrustLedgerEntry"("trustAccountId", "effectiveDate");

-- CreateIndex
CREATE INDEX "TrustLedgerEntry_bankMatchedAt_idx" ON "public"."TrustLedgerEntry"("bankMatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustReconciliation_trustAccountId_periodEnd_key" ON "public"."TrustReconciliation"("trustAccountId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_name_key" ON "public"."DocumentType"("name");

-- CreateIndex
CREATE INDEX "DocumentSlot_status_idx" ON "public"."DocumentSlot"("status");

-- CreateIndex
CREATE INDEX "DocumentSlot_reviewerId_status_idx" ON "public"."DocumentSlot"("reviewerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSlot_transactionId_documentTypeId_key" ON "public"."DocumentSlot"("transactionId", "documentTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSlot_listingId_documentTypeId_key" ON "public"."DocumentSlot"("listingId", "documentTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFile_slotId_version_key" ON "public"."DocumentFile"("slotId", "version");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "public"."AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."Listing" ADD CONSTRAINT "Listing_listingAgentId_fkey" FOREIGN KEY ("listingAgentId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionAgent" ADD CONSTRAINT "TransactionAgent_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionAgent" ADD CONSTRAINT "TransactionAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TransactionParty" ADD CONSTRAINT "TransactionParty_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_trustAccountId_fkey" FOREIGN KEY ("trustAccountId") REFERENCES "public"."TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "public"."TrustLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_trustAccountId_fkey" FOREIGN KEY ("trustAccountId") REFERENCES "public"."TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentSlot" ADD CONSTRAINT "DocumentSlot_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "public"."DocumentType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentSlot" ADD CONSTRAINT "DocumentSlot_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentSlot" ADD CONSTRAINT "DocumentSlot_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentSlot" ADD CONSTRAINT "DocumentSlot_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentFile" ADD CONSTRAINT "DocumentFile_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "public"."DocumentSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DocumentFile" ADD CONSTRAINT "DocumentFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
