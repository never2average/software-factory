# scripts/subagent-shared/

Helper code that several subagents need inside their sandboxes.

eve scopes a sandbox per subagent and has no shared-workspace mechanism, so each subagent carries its own copy
under `agent/subagents/<key>/sandbox/workspace/scripts/<family>/`. A family lives here once:

```
scripts/subagent-shared/<family>/
  targets.json        { "subagents": ["key-a", "key-b"] }
  ...                 the files to copy (targets.json itself is not copied)
```

- `npm run sync:subagent-shared` copies every family into its targets. It is the only writer of those copies.
- `npm run check:subagent-shared` exits 1 when a copy has drifted or a target does not exist.

This directory is empty in the base app. Subagent packs add families. See `docs/SUBAGENT_PACKS.md`.
