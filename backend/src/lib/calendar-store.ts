/**
 * The brokerage's business-day calendar: statutory Ontario holidays plus the
 * proclaimed days staff have entered, and the Civic Holiday only if the
 * broker of record has turned on CIVIC_HOLIDAY_IS_HOLIDAY (with counsel's
 * confirmation that s.87 lists it).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { BusinessCalendar } from "./ontario-calendar.ts";

export async function loadBusinessCalendar(db: PrismaClient | Prisma.TransactionClient): Promise<BusinessCalendar> {
  const [proclaimed, [{ civic }]] = await Promise.all([
    db.proclaimedHoliday.findMany({ select: { date: true, name: true } }),
    db.$queryRaw<{ civic: boolean }[]>`SELECT policy_enabled('CIVIC_HOLIDAY_IS_HOLIDAY') AS civic`,
  ]);
  return new BusinessCalendar({
    civicHoliday: civic,
    proclaimed: proclaimed.map((p) => ({ date: p.date.toISOString().slice(0, 10), name: p.name })),
  });
}
