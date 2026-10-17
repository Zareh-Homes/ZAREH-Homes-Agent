import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.ts";
import { devHeaderResolver, type ResolveUserId } from "./auth.ts";
import { LocalDiskStore } from "./compliance/storage.ts";
import type { BrokerageProfile } from "./closing/cda-template.ts";

// Real authentication isn't wired yet. Refuse to start rather than run a
// trust API that anyone could call as a broker.
function resolveAuth(): ResolveUserId {
  if (process.env.ALLOW_DEV_AUTH_HEADER === "true" && process.env.NODE_ENV !== "production") {
    console.warn("WARNING: trusting the x-user-id header. Development only.");
    return devHeaderResolver;
  }
  throw new Error("No authentication configured. Wire a session/OIDC resolver into buildApp before starting.");
}

// Printed on every CDA. No defaults: a CDA must never carry made-up brokerage details.
function brokerageProfile(): BrokerageProfile {
  const need = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name} (used on Commission Disbursement Authorizations)`);
    return v;
  };
  return {
    legalName: need("BROKERAGE_LEGAL_NAME"),
    address: need("BROKERAGE_ADDRESS"),
    phone: need("BROKERAGE_PHONE"),
    email: need("BROKERAGE_EMAIL"),
    hstNumber: need("BROKERAGE_HST_NUMBER"),
    recoRegistration: process.env.BROKERAGE_RECO_REGISTRATION ?? null,
    brokerOfRecord: need("BROKER_OF_RECORD"),
  };
}

const prisma = new PrismaClient();
// Local disk for development; use S3 / Drive with encryption at rest in production
const fileStore = new LocalDiskStore(process.env.UPLOAD_DIR ?? "./var/uploads");
const app = buildApp({ prisma, resolveUserId: resolveAuth(), fileStore, brokerage: brokerageProfile(), logger: true });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
