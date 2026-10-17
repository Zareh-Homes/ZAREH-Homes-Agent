import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { loadActor, type Actor, type ResolveUserId } from "../auth.ts";
import { ValidationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { validatePathUuid } from "../trust/validation.ts";
import {
  addParty,
  createDeal,
  getDealDocuments,
  getFile,
  listNotifications,
  markNotificationRead,
  reviewDocument,
  uploadDocument,
  type ComplianceDeps,
} from "./service.ts";
import { MAX_UPLOAD_BYTES } from "./storage.ts";
import { parseMetadataField, validateAddParty, validateCreateDeal, validateReview } from "./validation.ts";

export interface ComplianceRouteOptions extends ComplianceDeps {
  resolveUserId: ResolveUserId;
  today?: () => string;
}

type Params = Record<string, string>;

/**
 * POST /api/deals                                   open a deal; mandatory slots are added
 * POST /api/deals/:dealId/parties                   add a client; FINTRAC slots follow
 * GET  /api/deals/:dealId/documents                 checklist + completion summary
 * POST /api/documents/slots/:slotId/files           upload (multipart: file + metadata JSON)
 * POST /api/documents/slots/:slotId/review          APPROVED | NEEDS_REVISION (broker / compliance)
 * GET  /api/documents/files/:fileId                 file details (+ full FINTRAC record for staff)
 * GET  /api/documents/files/:fileId/content         the file itself
 * GET  /api/notifications?unread=true               my notifications
 * POST /api/notifications/:id/read                  mark read
 * GET  /api/notifications/stream                    live notifications (Server-Sent Events)
 */
export async function complianceRoutes(app: FastifyInstance, opts: ComplianceRouteOptions): Promise<void> {
  const { prisma, hub } = opts;
  const deps: ComplianceDeps = { prisma: opts.prisma, store: opts.store, hub: opts.hub };
  const today = opts.today ?? (() => todayInToronto());
  const actorOf = async (request: FastifyRequest): Promise<Actor> =>
    loadActor(prisma, await opts.resolveUserId(request));

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 64 * 1024, parts: 3 },
  });

  app.post("/api/deals", async (request, reply) => {
    const actor = await actorOf(request);
    return reply.code(201).send(await createDeal(deps, actor, validateCreateDeal(request.body)));
  });

  app.post<{ Params: Params }>("/api/deals/:dealId/parties", async (request, reply) => {
    const actor = await actorOf(request);
    const dealId = validatePathUuid(request.params.dealId, "dealId");
    return reply.code(201).send(await addParty(deps, actor, dealId, validateAddParty(request.body)));
  });

  app.get<{ Params: Params }>("/api/deals/:dealId/documents", async (request) => {
    const actor = await actorOf(request);
    return getDealDocuments(prisma, actor, validatePathUuid(request.params.dealId, "dealId"));
  });

  // Validation middleware for uploads: exactly one `file` part, optional `metadata` JSON field
  app.post<{ Params: Params }>("/api/documents/slots/:slotId/files", async (request, reply) => {
    const actor = await actorOf(request);
    const slotId = validatePathUuid(request.params.slotId, "slotId");
    if (!request.isMultipart()) {
      throw new ValidationError([{ field: "body", message: "must be multipart/form-data with a `file` part" }]);
    }

    let file: { fileName: string; mimeType: string; bytes: Buffer } | undefined;
    let metadataText: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file") throw new ValidationError([{ field: part.fieldname, message: "is not a recognised file field" }]);
        file = { fileName: part.filename.slice(0, 255), mimeType: part.mimetype, bytes: await part.toBuffer() };
      } else if (part.fieldname === "metadata") {
        metadataText = String(part.value);
      } else {
        throw new ValidationError([{ field: part.fieldname, message: "is not a recognised field" }]);
      }
    }
    if (!file) throw new ValidationError([{ field: "file", message: "is required" }]);

    const result = await uploadDocument(deps, actor, slotId, { ...file, metadata: parseMetadataField(metadataText) }, today());
    return reply.code(201).send(result);
  });

  app.post<{ Params: Params }>("/api/documents/slots/:slotId/review", async (request) => {
    const actor = await actorOf(request);
    const slotId = validatePathUuid(request.params.slotId, "slotId");
    return reviewDocument(deps, actor, slotId, validateReview(request.body));
  });

  app.get<{ Params: Params }>("/api/documents/files/:fileId", async (request) => {
    const actor = await actorOf(request);
    return (await getFile(deps, actor, validatePathUuid(request.params.fileId, "fileId"))).file;
  });

  app.get<{ Params: Params }>("/api/documents/files/:fileId/content", async (request, reply) => {
    const actor = await actorOf(request);
    const { file, bytes } = await getFile(deps, actor, validatePathUuid(request.params.fileId, "fileId"));
    const safeName = file.fileName.replace(/[^\w.\- ]+/g, "_");
    return reply
      .header("content-type", file.mimeType)
      .header("content-disposition", `inline; filename="${safeName}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(await bytes());
  });

  app.get<{ Querystring: { unread?: string } }>("/api/notifications", async (request) => {
    const actor = await actorOf(request);
    return listNotifications(prisma, actor, request.query.unread === "true");
  });

  app.post<{ Params: Params }>("/api/notifications/:id/read", async (request) => {
    const actor = await actorOf(request);
    return markNotificationRead(prisma, actor, validatePathUuid(request.params.id, "id"));
  });

  app.get("/api/notifications/stream", async (request, reply) => {
    const actor = await actorOf(request);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 5000\n\nevent: ready\ndata: {}\n\n");

    const unsubscribe = hub.subscribe(actor.id, (n) => {
      res.write(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
