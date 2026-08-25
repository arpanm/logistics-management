BEGIN;
-- PostgreSQL foreign-key checks take a KEY SHARE lock as the referenced-table
-- owner. Retain UPDATE privilege for that lock; the identity trigger still
-- rejects every runtime INSERT/UPDATE/DELETE regardless of caller-set GUCs.
GRANT UPDATE ON app.postal_directory_versions,app.postal_localities TO logistics_app;
COMMIT;
