-- Access-request answers (mold_v0-102; src/access-request.ts, molds/mold_v0/MOLD.md "Access-request fields"). The request
-- form asks what the build's packs declare (pack.json `access_request.fields`, or the app's profile.json): each answer is
-- stored here under the field's key, and the staff console's Requests page shows it under the field's label. The shell's
-- own fields (email, company, name, message, source) keep their columns.
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Until this release the first product's own questions were columns of this table (0001_baseline.sql). A row that has
-- them gets them as answers under the same keys, so a build whose pack declares those keys shows them labelled, and any
-- other build shows them under their keys. The columns stay (a host pack may still read them); nothing in the shell
-- writes them any more.
UPDATE access_requests q
   SET answers = (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                    FROM jsonb_each(jsonb_build_object(
                           'product_url', q.product_url, 'role', q.role, 'team_size', q.team_size, 'agents', to_jsonb(q.agents),
                           'docs_url', q.docs_url, 'competitors', q.competitors, 'goal', q.goal, 'timeline', q.timeline,
                           'heard_from', q.heard_from, 'subindustry', q.subindustry)) e
                   WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb))
 WHERE q.answers = '{}'::jsonb;
