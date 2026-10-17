import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.ts";
import { devHeaderResolver, type ResolveUserId } from "./auth.ts";
import { LocalDiskStore } from "./compliance/storage.ts";

// Real authentication isn't wired yet. Refuse to start rather than run a
// trust API that anyone could call as a broker.
function resolveAuth(): ResolveUserId {
  if (process.env.ALLOW_DEV_AUTH_HEADER === "true" && process.env.NODE_ENV !== "production") {
    console.warn("WARNING: trusting the x-user-id header. Development only.");
    return devHeaderResolver;
  }
  throw new Error("No authentication configured. Wire a session/OIDC resolver into buildApp before starting.");
}

const prisma = new PrismaClient();
// Local disk for development; use S3 / Drive with encryption at rest in production
const fileStore = new LocalDiskStore(process.env.UPLOAD_DIR ?? "./var/uploads");
const app = buildApp({ prisma, resolveUserId: resolveAuth(), fileStore, logger: true });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
