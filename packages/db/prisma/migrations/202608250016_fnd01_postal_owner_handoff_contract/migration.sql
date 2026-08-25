-- Ownership transfer is intentionally performed after migrations by
-- scripts/sql/postal-ownership-handoff.sql using a database-administrator
-- connection. The runtime migration role cannot securely transfer ownership
-- to a role of which it is not a member.
SELECT 1;
