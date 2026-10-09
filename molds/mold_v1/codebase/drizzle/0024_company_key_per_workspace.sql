-- A company is keyed by (org_id, customer_id), not customer_id alone (mold_v1-118).
--
-- Two workspaces may each hold the same company id (desk-a and customer-b both cover `example-listed-co`).
-- customers.customer_id was the table's primary key, so the second workspace's create hit the first one's row, which
-- its scope can neither see nor change, and was refused. Here the key becomes (org_id, customer_id) on customers, on
-- the eight tables hanging off it (their own keys start with it, and their foreign key names both columns, so a row
-- can only hang off a company in ITS OWN workspace), and on account_summaries (whose text key embeds the company id).
--
-- THIS MIGRATION DOES THE WHOLE CHANGE ON ITS OWN. On a live database the deploy runs the journal first and then only
-- a drift step (a dry run of `drizzle-kit push` against schema.ts, which sets aside what push would do to policies,
-- row-level security and indexes). After this migration that plan is EMPTY for these tables, which
-- scripts/test-company-key-migration-db.mjs asserts on a database pushed from the schema before this change. It is
-- equally a no-op after a `drizzle-kit push --force` from the new schema.ts (an empty database; the older chain).
--
-- Idempotent (each step checks what is there), one transaction, and nothing is deleted:
--   1. a company with no workspace (org_id NULL; only a journal-built database allows one) takes the workspace its
--      own rows are stamped with, when they agree on one, and otherwise the oldest workspace (org #1, which is what
--      .migrate-org-not-null.mjs gave the seven it found);
--   2. a row under a company with no workspace of its own takes its company's;
--   3. org_id becomes NOT NULL on all ten tables;
--   4. every foreign key into customers that is not the two-column one schema.ts declares is dropped;
--   5. customers.customer_id is moved after org_id when it stands before it (every database pushed before this change
--      has it first). drizzle-kit reads a composite key's columns in the order they stand in the table; the child
--      tables have always had org_id first, so with customers the other way round the two sides of every foreign
--      key read differently and the drift plan would drop and re-create all eight on every deploy. The column is
--      re-added at the end and its values copied (customers is small, and nothing but its key indexes the column);
--   6. each table's primary key becomes (org_id, customer_id[, its own id]) — a superset of the old key, so no row
--      can collide — under the name schema.ts gives it;
--   7. a row stamped with a different workspace than the company it hung off (the plant #70 closed: a nested table's
--      foreign key was checked past row-level security) keeps its workspace and gets a company of its own there,
--      named by its id, so it stays exactly as visible as it was (to its own workspace, never to the other) and no
--      row is lost;
--   8. the two-column foreign keys are added, ON DELETE CASCADE as before.
--
-- The migrating role is an admin one (BYPASSRLS on Supabase and Neon). row_security = off makes a role that is not
-- fail loudly on the first statement a policy would filter, instead of silently fixing no row.
SET LOCAL row_security = off;
--> statement-breakpoint
DO $$
DECLARE
  home text;
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE org_id IS NULL) THEN
    UPDATE customers c
       SET org_id = s.org_id
      FROM (
        SELECT customer_id, min(org_id) AS org_id
          FROM (
            SELECT customer_id, org_id FROM platform
            UNION ALL SELECT customer_id, org_id FROM deployments
            UNION ALL SELECT customer_id, org_id FROM solutions
            UNION ALL SELECT customer_id, org_id FROM implementation
            UNION ALL SELECT customer_id, org_id FROM tickets
            UNION ALL SELECT customer_id, org_id FROM interactions
            UNION ALL SELECT customer_id, org_id FROM internal_staff
            UNION ALL SELECT customer_id, org_id FROM customer_stakeholders
          ) r
         WHERE org_id IS NOT NULL
         GROUP BY customer_id
        HAVING count(DISTINCT org_id) = 1
      ) s
     WHERE c.org_id IS NULL AND c.customer_id = s.customer_id;
    IF EXISTS (SELECT 1 FROM customers WHERE org_id IS NULL) THEN
      SELECT org_id INTO home FROM orgs ORDER BY created_at, org_id LIMIT 1;
      IF home IS NULL THEN
        RAISE EXCEPTION 'customers has rows with no workspace (org_id NULL) and there is no workspace (orgs is empty) to give them; create the workspace first, then run this again';
      END IF;
      UPDATE customers SET org_id = home WHERE org_id IS NULL;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  home text;
BEGIN
  SELECT org_id INTO home FROM orgs ORDER BY created_at, org_id LIMIT 1;
  FOREACH t IN ARRAY ARRAY['platform', 'deployments', 'solutions', 'implementation', 'tickets', 'interactions', 'internal_staff', 'customer_stakeholders'] LOOP
    -- The company's workspace, where the id names exactly one company.
    EXECUTE format(
      'UPDATE %I x SET org_id = c.org_id FROM customers c
        WHERE x.org_id IS NULL AND c.customer_id = x.customer_id
          AND (SELECT count(*) FROM customers c2 WHERE c2.customer_id = x.customer_id) = 1', t);
    -- None to take (no company, or two): org #1's, and step 7 gives it a company there if it has none.
    EXECUTE format('UPDATE %I SET org_id = $1 WHERE org_id IS NULL', t) USING home;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "solutions" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "implementation" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "interactions" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "internal_staff" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_stakeholders" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "account_summaries" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- 4. Every foreign key into customers that is not the two-column one under the name schema.ts gives it (org_id and
--    customer_id, in that order, each referencing its namesake). The old ones reference customers_pkey.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS tbl
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.customers'::regclass
       AND NOT (
         con.conname = (SELECT relname FROM pg_class WHERE oid = con.conrelid) || '_customer_fk'
         AND con.confdeltype = 'c'
         AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) = ARRAY['org_id', 'customer_id']::name[]
         AND (SELECT array_agg(a.attname ORDER BY k.n) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) = ARRAY['org_id', 'customer_id']::name[]
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
--> statement-breakpoint
-- 5. customers.customer_id after org_id (see the header). Every foreign key into customers and its primary key go
--    first (they depend on the column); steps 6 and 8 put them back.
DO $$
DECLARE
  r record;
  pk text;
BEGIN
  IF (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.customers'::regclass AND attname = 'customer_id')
   < (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.customers'::regclass AND attname = 'org_id') THEN
    FOR r IN SELECT conname, conrelid::regclass AS tbl FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.customers'::regclass LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
    SELECT conname INTO pk FROM pg_constraint WHERE contype = 'p' AND conrelid = 'public.customers'::regclass;
    IF pk IS NOT NULL THEN
      EXECUTE format('ALTER TABLE "customers" DROP CONSTRAINT %I', pk);
    END IF;
    EXECUTE 'ALTER TABLE "customers" RENAME COLUMN "customer_id" TO "customer_id__0024"';
    EXECUTE 'ALTER TABLE "customers" ADD COLUMN "customer_id" text';
    EXECUTE 'UPDATE "customers" SET "customer_id" = "customer_id__0024"';
    EXECUTE 'ALTER TABLE "customers" ALTER COLUMN "customer_id" SET NOT NULL';
    EXECUTE 'ALTER TABLE "customers" DROP COLUMN "customer_id__0024"';
  END IF;
END $$;
--> statement-breakpoint
-- 6. Each primary key, org_id first, under the name schema.ts gives it (so the drift plan finds nothing to change).
DO $$
DECLARE
  k record;
  cur record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('customers', 'customers_org_id_customer_id_pk', ARRAY['org_id', 'customer_id']),
      ('platform', 'platform_org_id_customer_id_pk', ARRAY['org_id', 'customer_id']),
      ('implementation', 'implementation_org_id_customer_id_pk', ARRAY['org_id', 'customer_id']),
      ('deployments', 'deployments_org_id_customer_id_deployment_id_pk', ARRAY['org_id', 'customer_id', 'deployment_id']),
      ('solutions', 'solutions_org_id_customer_id_solution_id_pk', ARRAY['org_id', 'customer_id', 'solution_id']),
      ('tickets', 'tickets_org_id_customer_id_ticket_id_pk', ARRAY['org_id', 'customer_id', 'ticket_id']),
      ('interactions', 'interactions_org_id_customer_id_interaction_id_pk', ARRAY['org_id', 'customer_id', 'interaction_id']),
      ('internal_staff', 'internal_staff_org_id_customer_id_staff_role_email_pk', ARRAY['org_id', 'customer_id', 'staff_role', 'email']),
      ('customer_stakeholders', 'customer_stakeholders_org_customer_role_email_pk', ARRAY['org_id', 'customer_id', 'stakeholder_role', 'email']),
      ('account_summaries', 'account_summaries_org_id_key_pk', ARRAY['org_id', 'key'])
    ) AS v(tbl, name, cols)
  LOOP
    cur := NULL;
    SELECT con.conname,
           (SELECT array_agg(a.attname::text ORDER BY x.n) FROM unnest(con.conkey) WITH ORDINALITY x(attnum, n)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols
      INTO cur
      FROM pg_constraint con
     WHERE con.contype = 'p' AND con.conrelid = format('public.%I', k.tbl)::regclass;
    IF cur.conname = k.name AND cur.cols = k.cols THEN
      CONTINUE;
    END IF;
    IF cur.conname IS NOT NULL THEN
      -- customers' old key is still referenced only if step 4 left a foreign key on it, which it does not.
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', k.tbl, cur.conname);
    END IF;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (%s)', k.tbl, k.name,
                   (SELECT string_agg(quote_ident(c), ', ') FROM unnest(k.cols) AS c));
  END LOOP;
END $$;
--> statement-breakpoint
-- 7. A row whose workspace holds no company under its id gets one there, named by the id: it keeps its workspace
--    (and so exactly the visibility it had), and step 8 can add the foreign key without deleting it.
INSERT INTO customers (org_id, customer_id, customer_name)
SELECT DISTINCT r.org_id, r.customer_id, r.customer_id
  FROM (
    SELECT org_id, customer_id FROM platform
    UNION SELECT org_id, customer_id FROM deployments
    UNION SELECT org_id, customer_id FROM solutions
    UNION SELECT org_id, customer_id FROM implementation
    UNION SELECT org_id, customer_id FROM tickets
    UNION SELECT org_id, customer_id FROM interactions
    UNION SELECT org_id, customer_id FROM internal_staff
    UNION SELECT org_id, customer_id FROM customer_stakeholders
  ) r
 WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.org_id = r.org_id AND c.customer_id = r.customer_id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 8. The foreign keys, (org_id, customer_id) -> customers (org_id, customer_id), under the names schema.ts gives them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform', 'deployments', 'solutions', 'implementation', 'tickets', 'interactions', 'internal_staff', 'customer_stakeholders'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND conname = t || '_customer_fk') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("org_id", "customer_id") REFERENCES "public"."customers"("org_id", "customer_id") ON DELETE cascade ON UPDATE no action',
        t, t || '_customer_fk');
    END IF;
  END LOOP;
END $$;
