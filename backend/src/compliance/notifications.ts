/**
 * In-app notifications. Rows are stored so nothing is lost while a user is
 * offline; connected users also get them instantly over Server-Sent Events.
 *
 * NotificationHub is in-process (the "mock" real-time layer). With more than
 * one server instance, swap it for Postgres LISTEN/NOTIFY or Redis pub/sub.
 */

import { Prisma } from "@prisma/client";

export interface NotificationView {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  dealId: string | null;
  slotId: string | null;
  createdAt: string;
  readAt: string | null;
}

export type Listener = (notification: NotificationView) => void;

export class NotificationHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  publish(notification: NotificationView): void {
    for (const listener of this.listeners.get(notification.userId) ?? []) {
      try {
        listener(notification);
      } catch {
        // one broken connection must not stop the others
      }
    }
  }

  connectedUsers(): number {
    return this.listeners.size;
  }
}

export const NOTIFICATION_COLUMNS = Prisma.sql`
  n.id, n."userId", n.type, n.title, n.body, n."transactionId" AS "dealId", n."slotId",
  to_char(n."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  to_char(n."readAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "readAt"`;

export interface NewNotification {
  userIds: string[];
  type: string;
  title: string;
  body: string;
  dealId: string | null;
  slotId: string | null;
}

/** Stores notifications inside the caller's transaction; publish after commit. */
export async function insertNotifications(
  tx: Prisma.TransactionClient,
  n: NewNotification,
): Promise<NotificationView[]> {
  const out: NotificationView[] = [];
  for (const userId of new Set(n.userIds)) {
    const [row] = await tx.$queryRaw<NotificationView[]>(Prisma.sql`
      INSERT INTO "Notification" AS n (id, "userId", type, title, body, "transactionId", "slotId")
      VALUES (gen_random_uuid(), ${userId}::uuid, ${n.type}, ${n.title}, ${n.body}, ${n.dealId}::uuid, ${n.slotId}::uuid)
      RETURNING ${NOTIFICATION_COLUMNS}`);
    out.push(row!);
  }
  return out;
}
