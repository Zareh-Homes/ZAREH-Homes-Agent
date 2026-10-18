-- The login the API connects with: a member of zareh_app, never the owner (see docs/monthly-trust-reconciliation.md).
--   psql "$OWNER_URL" -v pw='<from the secret store>' -f ops/create-app-login.sql
SELECT 'CREATE ROLE zareh_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE zareh_app'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zareh_app_login') \gexec
ALTER ROLE zareh_app_login PASSWORD :'pw';
-- New schema objects are granted by each migration; nothing here widens access
