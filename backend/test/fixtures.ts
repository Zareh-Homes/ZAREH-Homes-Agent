import type { BrokerageProfile } from "../src/closing/cda-template.ts";

/** Fictional brokerage details for tests only. */
export const TEST_BROKERAGE: BrokerageProfile = {
  legalName: "Test Brokerage Inc.",
  address: "1 Test St, Oakville ON",
  phone: "905-555-0100",
  email: "deals@brokerage.test",
  hstNumber: "111222333RT0001",
  recoRegistration: null,
  brokerOfRecord: "Test Broker",
};

/** Builds a multipart/form-data body without any extra dependency. */
export function multipart(file: { name: string; type: string; bytes: Buffer } | null, metadata?: unknown) {
  const boundary = `----zareh${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  if (metadata !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${typeof metadata === "string" ? metadata : JSON.stringify(metadata)}\r\n`,
    ));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ));
    chunks.push(file.bytes, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/**
 * Marks trust entries as cleared by a broker's pre-cutover attestation, for tests
 * about other rules. The real statement-and-match flow is in bank.int.test.ts.
 */
export async function attestCleared(
  app: { inject: (opts: object) => Promise<{ statusCode: number; body: string }> },
  brokerId: string,
  entryIds: string[],
): Promise<void> {
  const res = await app.inject({
    method: "POST", url: "/api/bank/pre-cutover", headers: { "x-user-id": brokerId },
    payload: { trustEntryIds: entryIds, note: "Test: treated as cleared before any statement was imported" },
  });
  if (res.statusCode !== 201) throw new Error(`attestCleared failed: ${res.statusCode} ${res.body}`);
}
