import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.ts";
import { devHeaderResolver } from "./auth.ts";
import { EncryptedStore, LocalDiskStore } from "./compliance/storage.ts";
import type { BrokerageProfile } from "./closing/cda-template.ts";
import { AuthService } from "./security/auth-service.ts";
import { InsecureConfigurationError, loadSecurityConfig } from "./security/config.ts";

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

let security;
try {
  security = loadSecurityConfig();
} catch (err) {
  if (err instanceof InsecureConfigurationError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const prisma = new PrismaClient();

// The application must connect as a restricted role (member of zareh_app), never as the table owner or a superuser
const [db] = await prisma.$queryRaw<{ superuser: boolean; owner: boolean; app_role: boolean }[]>`
  SELECT r.rolsuper AS superuser,
         (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'TrustLedgerEntry') = current_user AS owner,
         pg_has_role(current_user, 'zareh_app', 'MEMBER') AS app_role
    FROM pg_roles r WHERE r.rolname = current_user`;
if (security.production && (db!.superuser || db!.owner || !db!.app_role)) {
  console.error("Refusing to start: connect as a login role that is a member of zareh_app, not as the table owner or a superuser");
  process.exit(1);
}

const uploads = new LocalDiskStore(process.env.UPLOAD_DIR ?? "./var/uploads");
const fileKey = process.env.FILE_ENCRYPTION_KEY ? Buffer.from(process.env.FILE_ENCRYPTION_KEY, "base64") : null;
if (security.production && !fileKey) {
  console.error("Refusing to start: FILE_ENCRYPTION_KEY is required (32 random bytes, base64) to encrypt uploaded documents");
  process.exit(1);
}
const fileStore = fileKey ? new EncryptedStore(uploads, fileKey) : uploads;

if (security.mode === "dev-header") console.warn("WARNING: trusting the x-user-id header. Development only; refused in production.");
const app = buildApp({
  prisma,
  ...(security.mode === "session" ? { auth: new AuthService(prisma, security) } : { resolveUserId: devHeaderResolver, fieldCipher: security.fieldCipher }),
  fileStore,
  brokerage: brokerageProfile(),
  logger: true,
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
