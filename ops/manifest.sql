-- Facts a restored database must reproduce exactly (JSON on one line)
SELECT json_build_object(
  'migrations', (SELECT COALESCE(json_agg(filename ORDER BY filename), '[]') FROM zareh_meta.schema_migrations),
  'rows', (SELECT json_object_agg(t, n) FROM (
      SELECT 'User' t, COUNT(*) n FROM "User" UNION ALL SELECT 'Transaction', COUNT(*) FROM "Transaction"
      UNION ALL SELECT 'TrustLedgerEntry', COUNT(*) FROM "TrustLedgerEntry" UNION ALL SELECT 'BankTransaction', COUNT(*) FROM "BankTransaction"
      UNION ALL SELECT 'TrustReconciliation', COUNT(*) FROM "TrustReconciliation" UNION ALL SELECT 'ClosingStatement', COUNT(*) FROM "ClosingStatement"
      UNION ALL SELECT 'PayoutEvent', COUNT(*) FROM "PayoutEvent" UNION ALL SELECT 'AuditLog', COUNT(*) FROM "AuditLog"
      UNION ALL SELECT 'DocumentFile', COUNT(*) FROM "DocumentFile") x),
  'trustBalance', (SELECT COALESCE(SUM(amount * direction), 0)::text FROM "TrustLedgerEntry"),
  'trustByAccount', (SELECT COALESCE(json_object_agg(a, b), '{}') FROM (SELECT "trustAccountId"::text a, SUM(amount * direction)::text b FROM "TrustLedgerEntry" GROUP BY 1) y),
  'lastReceiptNumber', (SELECT MAX("receiptNumber") FROM "TrustLedgerEntry"),
  'appendOnlyTriggers', (SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%immutable%'),
  'appRoleGrants', (SELECT COUNT(*) FROM information_schema.role_table_grants WHERE grantee = 'zareh_app')
);
