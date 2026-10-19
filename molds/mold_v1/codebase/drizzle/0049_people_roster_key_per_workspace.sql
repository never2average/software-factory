-- A person on a roster is keyed by (org_id, email), not email alone (mold_v1-285).
--
-- Workspaces are unaware of each other: the same people may be on several workspaces' rosters, each seeing only its
-- own row. people_roster.email was the table's primary key, so when workspace B added someone workspace A already
-- held, B's insert hit A's row (which B's scope can neither see nor change) and failed with a database error. Here the
-- key becomes (org_id, email), under the name schema.ts gives it. Row-level security (org_isolation) is row-level and
-- is not touched: every workspace still reads and writes only its own rows. No foreign key references people_roster,
-- and manager_email is not one: who someone reports to is checked against the SAME workspace's people by every
-- writer (agent/lib/people-data.ts).
--
-- THIS MIGRATION DOES THE WHOLE CHANGE ON ITS OWN. On a live database the deploy runs the journal first and then a
-- read-only drift dry run of `drizzle-kit push` against schema.ts; after this migration that plan is EMPTY, which
-- scripts/test-roster-key-db.mjs asserts on a database built as the live ones were.
--
-- Idempotent (each step checks what is there), one transaction, and nothing is deleted or rewritten except the key:
--   1. a row with no workspace (org_id NULL; only a database built from the journal alone allows one) takes the
--      workspace its email has an ACCEPTED membership of, when there is exactly one. Nothing is guessed: when any
--      such row has several, none, or only pending invitations, the migration REFUSES, naming how many rows, and
--      changes nothing; an operator files those rows (or removes them) and runs it again;
--   2. org_id becomes NOT NULL;
--   3. email is moved after org_id when it stands before it (every database built so far has it first). drizzle-kit
--      reads a composite key's columns in the order they stand in the table, so with email first the drift plan would
--      drop and re-create the key on every deploy. The old key goes first (it depends on the column); the column is
--      re-added at the end with the old one's exact type and collation and its values copied. It REFUSES, changing
--      nothing, when an index other than the key, or a default, is on the column: those would be lost by the move, so
--      an operator decides what to do with them first;
--   4. the primary key becomes (org_id, email), a superset of the old key (email was unique, so no row can collide),
--      under the name schema.ts gives it. A key already of those columns under another name (a database that ran the
--      old one-off .migrate-org-tenancy-tighten.mjs) is renamed into place by the same drop-and-add.
--
-- The migrating role is an admin one (BYPASSRLS on Supabase and Neon). row_security = off makes a role that is not
-- fail loudly on the first statement a policy would filter, instead of silently fixing no row. lock_timeout: the key
-- change takes an exclusive lock on the roster; behind a long transaction it fails within 5 seconds (and the deploy is
-- retried) instead of queueing every roster read behind it. Both hold to the end of the deploy's one transaction
-- (scripts/migrate-production.mjs runs every pending migration in one).
SET LOCAL row_security = off;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  unfiled int;
BEGIN
  IF EXISTS (SELECT 1 FROM people_roster WHERE org_id IS NULL) THEN
    SELECT count(*) INTO unfiled
      FROM people_roster r
     WHERE r.org_id IS NULL
       AND (SELECT count(DISTINCT m.org_id) FROM org_members m
             WHERE lower(m.email) = lower(r.email) AND m.accepted_at IS NOT NULL) <> 1;
    IF unfiled > 0 THEN
      RAISE EXCEPTION 'people_roster has % row(s) with no workspace (org_id NULL) whose email has no single accepted workspace membership (several, none, or only pending invitations); nothing was changed. Set org_id on those rows (or remove them), then run this again', unfiled;
    END IF;
    UPDATE people_roster r
       SET org_id = m.org_id
      FROM (
        SELECT lower(email) AS email, min(org_id) AS org_id
          FROM org_members
         WHERE accepted_at IS NOT NULL
         GROUP BY lower(email)
        HAVING count(DISTINCT org_id) = 1
      ) m
     WHERE r.org_id IS NULL AND lower(r.email) = m.email;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "people_roster" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  pk text;
  pk_index oid;
  col_type text;
  col_collation text;
  col_attnum int2;
  others text;
BEGIN
  SELECT a.attnum, format_type(a.atttypid, a.atttypmod),
         CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
              THEN (SELECT format('%I.%I', n.nspname, c.collname) FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE c.oid = a.attcollation) END
    INTO col_attnum, col_type, col_collation
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = 'public.people_roster'::regclass AND a.attname = 'email' AND NOT a.attisdropped;
  IF col_attnum < (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.people_roster'::regclass AND attname = 'org_id') THEN
    SELECT conname, conindid INTO pk, pk_index FROM pg_constraint WHERE contype = 'p' AND conrelid = 'public.people_roster'::regclass;
    -- Every index on the column (plain or by expression) other than the key's, which the move would drop with it.
    SELECT string_agg(DISTINCT ic.relname, ', ') INTO others
      FROM pg_depend d JOIN pg_class ic ON ic.oid = d.objid
     WHERE d.classid = 'pg_class'::regclass AND ic.relkind = 'i'
       AND d.refobjid = 'public.people_roster'::regclass AND d.refobjsubid = col_attnum
       AND ic.oid IS DISTINCT FROM pk_index;
    IF others IS NOT NULL THEN
      RAISE EXCEPTION 'people_roster.email has index(es) other than the primary key (%); moving the column would drop them, so nothing was changed. Drop them (or move them to the new key) first, then run this again', others;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attrdef WHERE adrelid = 'public.people_roster'::regclass AND adnum = col_attnum) THEN
      RAISE EXCEPTION 'people_roster.email has a default; moving the column would drop it, so nothing was changed. Drop the default first, then run this again';
    END IF;
    IF pk IS NOT NULL THEN
      EXECUTE format('ALTER TABLE "people_roster" DROP CONSTRAINT %I', pk);
    END IF;
    ALTER TABLE "people_roster" RENAME COLUMN "email" TO "email__0049";
    EXECUTE format('ALTER TABLE "people_roster" ADD COLUMN "email" %s%s', col_type, coalesce(' COLLATE ' || col_collation, ''));
    UPDATE "people_roster" SET "email" = "email__0049";
    ALTER TABLE "people_roster" ALTER COLUMN "email" SET NOT NULL;
    ALTER TABLE "people_roster" DROP COLUMN "email__0049";
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cur record;
BEGIN
  SELECT con.conname,
         (SELECT array_agg(a.attname::text ORDER BY x.n) FROM unnest(con.conkey) WITH ORDINALITY x(attnum, n)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols
    INTO cur
    FROM pg_constraint con
   WHERE con.contype = 'p' AND con.conrelid = 'public.people_roster'::regclass;
  IF cur.conname = 'people_roster_org_id_email_pk' AND cur.cols = ARRAY['org_id', 'email'] THEN
    RETURN;
  END IF;
  IF cur.conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "people_roster" DROP CONSTRAINT %I', cur.conname);
  END IF;
  ALTER TABLE "people_roster" ADD CONSTRAINT "people_roster_org_id_email_pk" PRIMARY KEY ("org_id", "email");
END $$;
