Stand-in answers for the sandbox prune's offline self-test (mold_v1-153, `vm_tunnel_selftest.prune`).

`msb-list.json` and `msb-snapshot-list.json` are what the test's stand-in `msb` prints for `msb list --format json` and
`msb snapshot list --format json`. The flags are msb 0.5.10's own (`msb list --help`); the field names are a guess that
the pruner does not depend on: it reads `name` and `status`, takes a thing's age from its directory on disk first, and
removes nothing whose name, status or age it cannot read. The directory tree itself is built by the test in a temp
directory, with the ages each name suggests.
