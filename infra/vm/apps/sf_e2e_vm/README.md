<!-- GENERATED; see infra/vm/README.md -->
# sf_e2e_vm — local database artifact

    python3 .claude/scripts/provision.py sf_e2e_vm --verify-db   # up, full mold chain, app_rw proof
    (cd infra/vm/apps/sf_e2e_vm && docker compose up -d)         # the database alone, nothing else
    python3 .claude/scripts/lib/localpg.py down sf_e2e_vm

Provider `self_hosted`. No host port: `docker port pg-sf-e2e-vm` is empty by
design. Hand edits go in `docker-compose.override.yml` here, and both commands above honour it —
`docker compose -f <file>` from elsewhere would silently ignore it, so run compose from this directory.
GENERATED, REWRITTEN ON EVERY RUN: docker-compose.yml, .env.example, README.md. Edit those and the
edit is gone. NOT generated and NOT derivable from state: `.pg-admin` (this cluster's superuser
password) and `pg/server.key` (TLS private key) — both ignored by this directory's .gitignore and by
the root one, never committed, and never rewritten by a regeneration. `.pg-admin` is the ONLY copy of
the password baked into volume pg-sf-e2e-vm-data: lose it and nothing can open that volume again, so provisioning
refuses rather than quietly mint a second one. Rebuild from scratch with
`python3 .claude/scripts/lib/localpg.py down sf_e2e_vm` (deletes the data) then `--verify-db`.
