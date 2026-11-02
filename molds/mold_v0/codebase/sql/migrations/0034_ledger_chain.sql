-- Chain and sign (mold_v0-195; src/ledger.ts): a hash chain over every entry of the audit trails (0031) and over the
-- records of a pack's record area declared `append_only: true` with `chain: true`, enforced here, in the database, and
-- the table the signed checkpoints are written to.
--
-- The chain: per workspace and stream (the data trail, the platform trail, one chained record area), each entry's
--   hash = sha256(prev_hash || canonical entry)
-- where prev_hash is the stream's previous entry's hash (32 zero bytes before the first) and the canonical entry is
-- app_ledger_canon(fields): each field as `<bytes>:<text>;` (a null as `~;`), the fields of app_ledger_fields_*(),
-- in that order, led by 'ledger/v1' and the stream's kind. Times are whole microseconds since 1970 (UTC), so the same
-- bytes come out of any client: src/ledger.ts (Node) and scripts/operator/verify_ledger.py (Python) recompute every
-- hash from the rows' own values with the same rule.
--
-- A trigger computes the chain on every INSERT (a writer that sends prev_hash or hash has them checked, never
-- trusted), under the stream's head row's lock (ledger_heads), so a stream's entries chain in commit order. Trail
-- entries were already append-only (0031); a chained record is too, from here: no UPDATE, and no DELETE but a removed
-- workspace's cascade. The entries already written are chained here, once, in their sequence order.
--
--   ledger_heads        each stream's last sequence number and hash (platform bookkeeping: tenant work never reaches it)
--   ledger_checkpoints  the signed checkpoints: a window of a stream's entries (from_seq..to_seq), the Merkle root of
--                       their hashes, the previous checkpoint's hash, an Ed25519 signature by a key the database never
--                       sees (src/ledger.ts, the app's APP_LEDGER_SIGNING_KEY). Append-only. A workspace reads its own.
--
-- What a superuser can still do (switch the triggers off and rewrite a stretch of entries with a chain that is
-- consistent again) the checkpoints catch: the rewritten entries no longer give the Merkle root that was signed.

-- ---------------------------------------------------------------- the canonical form and the hash

CREATE OR REPLACE FUNCTION app_ledger_canon(parts TEXT[]) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(string_agg(CASE WHEN p IS NULL THEN '~' ELSE octet_length(convert_to(p, 'UTF8'))::text || ':' || p END || ';', '' ORDER BY i), '')
    FROM unnest(parts) WITH ORDINALITY AS u(p, i)
$fn$;
CREATE OR REPLACE FUNCTION app_ledger_us(t TIMESTAMPTZ) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT (extract(epoch FROM t) * 1000000)::bigint::text
$fn$;
CREATE OR REPLACE FUNCTION app_ledger_hash(prev BYTEA, parts TEXT[]) RETURNS BYTEA LANGUAGE sql IMMUTABLE AS $fn$
  SELECT sha256(prev || convert_to(app_ledger_canon(parts), 'UTF8'))
$fn$;

-- ---------------------------------------------------------------- the chain's columns, the heads

ALTER TABLE audit_data_events ADD COLUMN IF NOT EXISTS prev_hash BYTEA;
ALTER TABLE audit_data_events ADD COLUMN IF NOT EXISTS hash BYTEA;
ALTER TABLE audit_platform_events ADD COLUMN IF NOT EXISTS prev_hash BYTEA;
ALTER TABLE audit_platform_events ADD COLUMN IF NOT EXISTS hash BYTEA;
-- A record of a chained area: chained when written (the record store says so), then never changed.
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS chained BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS prev_hash BYTEA;
ALTER TABLE workspace_records ADD COLUMN IF NOT EXISTS hash BYTEA;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_records_chain_idx ON workspace_records (org_id, pack, area, chain_seq) WHERE chained;

CREATE OR REPLACE FUNCTION app_ledger_fields_data(e audit_data_events) RETURNS TEXT[] LANGUAGE sql STABLE AS $fn$
  SELECT ARRAY['ledger/v1', 'data', e.org_id::text, e.seq::text, app_ledger_us(e.at), e.actor_kind, e.actor_id, e.key_id::text, e.action, e.target,
               e.pack, e.area, e.record_key, e.rows::text, e.channel]
$fn$;
CREATE OR REPLACE FUNCTION app_ledger_fields_platform(e audit_platform_events) RETURNS TEXT[] LANGUAGE sql STABLE AS $fn$
  SELECT ARRAY['ledger/v1', 'platform', e.scope_id::text, e.seq::text, e.org_id::text, app_ledger_us(e.at), e.kind, e.channel, e.method, e.path,
               e.key_id::text, e.actor_kind, e.actor_id, app_ledger_canon(e.scopes), e.status::text, e.latency_ms::text, e.ip]
$fn$;
CREATE OR REPLACE FUNCTION app_ledger_fields_record(e workspace_records) RETURNS TEXT[] LANGUAGE sql STABLE AS $fn$
  SELECT ARRAY['ledger/v1', 'records', e.org_id::text, e.pack, e.area, e.chain_seq::text, e.key, e.title, e.data::text, e.sealed::text,
               e.source, e.fingerprint, app_ledger_us(e.created_at)]
$fn$;

-- Each stream's head: scope_id (a workspace's id; 0, the platform's own entries) and stream ('data', 'platform',
-- 'records:<pack>/<area>'). No org_id column: platform bookkeeping, out of tenant work's reach (a removed workspace's
-- head stays behind, numbers and hashes only).
CREATE TABLE IF NOT EXISTS ledger_heads (
  scope_id   INT NOT NULL,
  stream     TEXT NOT NULL,
  last_seq   BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash  BYTEA,
  PRIMARY KEY (scope_id, stream)
);

-- The stream's head, locked for this transaction (made on first use).
CREATE OR REPLACE FUNCTION app_ledger_head(p_scope INT, p_stream TEXT, OUT last_seq BIGINT, OUT last_hash BYTEA) LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO ledger_heads (scope_id, stream) VALUES (p_scope, p_stream) ON CONFLICT DO NOTHING;
  SELECT h.last_seq, h.last_hash INTO last_seq, last_hash FROM ledger_heads h WHERE h.scope_id = p_scope AND h.stream = p_stream FOR UPDATE;
END $fn$;

-- The trails' entries: the writer numbers them (src/audit-trail.ts, under audit_sequences' lock); the chain follows.
CREATE OR REPLACE FUNCTION app_ledger_chain_trail() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  hd RECORD;
  scope INT;
  parts TEXT[];
  h BYTEA;
BEGIN
  IF TG_TABLE_NAME = 'audit_data_events' THEN
    scope := NEW.org_id;
    parts := app_ledger_fields_data(NEW);
  ELSE
    scope := NEW.scope_id;
    parts := app_ledger_fields_platform(NEW);
  END IF;
  SELECT * INTO hd FROM app_ledger_head(scope, TG_ARGV[0]);
  IF hd.last_seq > 0 AND NEW.seq <> hd.last_seq + 1 THEN
    RAISE EXCEPTION '% entry % of scope % is out of sequence: the chain is at %', TG_ARGV[0], NEW.seq, scope, hd.last_seq USING ERRCODE = '23514';
  END IF;
  IF NEW.prev_hash IS NOT NULL AND NEW.prev_hash IS DISTINCT FROM coalesce(hd.last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) THEN
    RAISE EXCEPTION '% entry % of scope %: prev_hash does not continue the chain', TG_ARGV[0], NEW.seq, scope USING ERRCODE = '23514';
  END IF;
  NEW.prev_hash := coalesce(hd.last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  h := app_ledger_hash(NEW.prev_hash, parts);
  IF NEW.hash IS NOT NULL AND NEW.hash <> h THEN
    RAISE EXCEPTION '% entry % of scope %: hash does not match the entry', TG_ARGV[0], NEW.seq, scope USING ERRCODE = '23514';
  END IF;
  NEW.hash := h;
  UPDATE ledger_heads SET last_seq = NEW.seq, last_hash = h WHERE scope_id = scope AND stream = TG_ARGV[0];
  RETURN NEW;
END $fn$;

-- A chained area's records: numbered here, in commit order, per workspace and area. An unchained write to an area that
-- has a chain is refused (the chain cannot be stepped around).
CREATE OR REPLACE FUNCTION app_ledger_chain_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  hd RECORD;
  s TEXT := 'records:' || NEW.pack || '/' || NEW.area;
BEGIN
  IF NOT NEW.chained THEN
    IF EXISTS (SELECT 1 FROM ledger_heads WHERE scope_id = NEW.org_id AND stream = s) THEN
      RAISE EXCEPTION 'records of %/% are chained: a record is written to the chain or not at all', NEW.pack, NEW.area USING ERRCODE = '42501';
    END IF;
    NEW.chain_seq := NULL; NEW.prev_hash := NULL; NEW.hash := NULL;
    RETURN NEW;
  END IF;
  SELECT * INTO hd FROM app_ledger_head(NEW.org_id, s);
  -- An INSERT ... ON CONFLICT DO NOTHING of a key that is there (src/record-areas.ts writeRow): skipped here, under the
  -- head's lock, so the chain never steps forward for a row that is not written.
  IF EXISTS (SELECT 1 FROM workspace_records WHERE org_id = NEW.org_id AND pack = NEW.pack AND area = NEW.area AND key = NEW.key) THEN
    RETURN NULL;
  END IF;
  NEW.chain_seq := hd.last_seq + 1;
  NEW.prev_hash := coalesce(hd.last_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  NEW.hash := app_ledger_hash(NEW.prev_hash, app_ledger_fields_record(NEW));
  UPDATE ledger_heads SET last_seq = NEW.chain_seq, last_hash = NEW.hash WHERE scope_id = NEW.org_id AND stream = s;
  RETURN NEW;
END $fn$;

-- A chained record is never changed, and removed only with its workspace.
CREATE OR REPLACE FUNCTION app_ledger_record_frozen() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.chained THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'records of %/% are chained and append-only: a record is never changed or removed', OLD.pack, OLD.area USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.chained THEN
    RAISE EXCEPTION 'a record is chained when it is written, never after' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;

-- ---------------------------------------------------------------- the entries already written, chained once

DO $mig$
DECLARE
  r RECORD;
  prev BYTEA;
  scope INT := NULL;
  zero CONSTANT BYTEA := '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
BEGIN
  ALTER TABLE audit_data_events DISABLE TRIGGER audit_data_events_append_only;
  FOR r IN SELECT e.org_id, e.seq, app_ledger_fields_data(e) AS parts FROM audit_data_events e ORDER BY e.org_id, e.seq LOOP
    IF scope IS DISTINCT FROM r.org_id THEN scope := r.org_id; prev := zero; END IF;
    UPDATE audit_data_events SET prev_hash = prev, hash = app_ledger_hash(prev, r.parts) WHERE org_id = r.org_id AND seq = r.seq RETURNING hash INTO prev;
  END LOOP;
  ALTER TABLE audit_data_events ENABLE TRIGGER audit_data_events_append_only;
  scope := NULL;
  ALTER TABLE audit_platform_events DISABLE TRIGGER audit_platform_events_append_only;
  FOR r IN SELECT e.scope_id, e.seq, app_ledger_fields_platform(e) AS parts FROM audit_platform_events e ORDER BY e.scope_id, e.seq LOOP
    IF scope IS DISTINCT FROM r.scope_id THEN scope := r.scope_id; prev := zero; END IF;
    UPDATE audit_platform_events SET prev_hash = prev, hash = app_ledger_hash(prev, r.parts) WHERE scope_id = r.scope_id AND seq = r.seq RETURNING hash INTO prev;
  END LOOP;
  ALTER TABLE audit_platform_events ENABLE TRIGGER audit_platform_events_append_only;
  INSERT INTO ledger_heads (scope_id, stream, last_seq, last_hash)
    SELECT DISTINCT ON (org_id) org_id, 'data', seq, hash FROM audit_data_events ORDER BY org_id, seq DESC;
  INSERT INTO ledger_heads (scope_id, stream, last_seq, last_hash)
    SELECT DISTINCT ON (scope_id) scope_id, 'platform', seq, hash FROM audit_platform_events ORDER BY scope_id, seq DESC;
END $mig$;

ALTER TABLE audit_data_events ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN hash SET NOT NULL;
ALTER TABLE audit_platform_events ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN hash SET NOT NULL;

DROP TRIGGER IF EXISTS audit_data_events_chain ON audit_data_events;
CREATE TRIGGER audit_data_events_chain BEFORE INSERT ON audit_data_events FOR EACH ROW EXECUTE FUNCTION app_ledger_chain_trail('data');
DROP TRIGGER IF EXISTS audit_platform_events_chain ON audit_platform_events;
CREATE TRIGGER audit_platform_events_chain BEFORE INSERT ON audit_platform_events FOR EACH ROW EXECUTE FUNCTION app_ledger_chain_trail('platform');
DROP TRIGGER IF EXISTS workspace_records_chain ON workspace_records;
CREATE TRIGGER workspace_records_chain BEFORE INSERT ON workspace_records FOR EACH ROW EXECUTE FUNCTION app_ledger_chain_record();
DROP TRIGGER IF EXISTS workspace_records_chain_frozen ON workspace_records;
CREATE TRIGGER workspace_records_chain_frozen BEFORE UPDATE OR DELETE ON workspace_records FOR EACH ROW EXECUTE FUNCTION app_ledger_record_frozen();

-- ---------------------------------------------------------------- the signed checkpoints

CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  scope_id         INT NOT NULL,
  org_id           INT REFERENCES organizations (id) ON DELETE CASCADE,
  stream           TEXT NOT NULL,
  n                BIGINT NOT NULL CHECK (n > 0),          -- 1, 2, 3, ... per scope and stream
  from_seq         BIGINT NOT NULL CHECK (from_seq > 0),
  to_seq           BIGINT NOT NULL,
  entries          INT NOT NULL CHECK (entries > 0),
  last_hash        BYTEA NOT NULL,                         -- the window's last entry's hash (the chain's head when signed)
  merkle_root      BYTEA NOT NULL,                         -- RFC 6962 Merkle tree hash of the window's entry hashes
  prev_checkpoint  BYTEA NOT NULL,                         -- the previous checkpoint's hash (32 zero bytes before the first)
  checkpoint_hash  BYTEA NOT NULL,                         -- sha256 of the signed statement (src/ledger.ts statement)
  key_id           TEXT NOT NULL,                          -- the signing key's id (/.well-known/ledger-keys.json)
  signature        BYTEA NOT NULL,                         -- Ed25519 over the statement
  signed_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_id, stream, n),
  CHECK (to_seq >= from_seq),
  CHECK (scope_id = coalesce(org_id, 0))
);
CREATE INDEX IF NOT EXISTS ledger_checkpoints_org_idx ON ledger_checkpoints (org_id) WHERE org_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: a signed checkpoint is never changed or removed (a removed workspace aside)', TG_TABLE_NAME USING ERRCODE = '42501';
END $fn$;
DROP TRIGGER IF EXISTS ledger_checkpoints_append_only ON ledger_checkpoints;
CREATE TRIGGER ledger_checkpoints_append_only BEFORE UPDATE OR DELETE ON ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION app_ledger_append_only();

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE ledger_checkpoints ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON ledger_checkpoints;
  EXECUTE format('CREATE POLICY tenant_isolation ON ledger_checkpoints TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON ledger_checkpoints FROM %I', r);
  EXECUTE format('GRANT SELECT ON ledger_checkpoints TO %I', r);
  EXECUTE format('REVOKE ALL ON ledger_heads FROM %I', r);
END $mig$;
