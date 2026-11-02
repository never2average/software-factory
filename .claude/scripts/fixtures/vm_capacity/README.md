# vm_capacity fixtures

`probe-2026-10-06.txt` is what `provision.py <app> --capacity` read from the first self-hosted server
(DigitalOcean Basic 4 vCPU / 8 GB) for the 24 hours to 2026-10-06 20:09 UTC: one real run of
`lib/vm_capacity.py probe_sh`, read-only. Shortened for the repository: each sandbox's label (session id and
specialist name) is `(…k)`, process ids are `node[1]`, the host name in journal and sysstat rows is `h` (the `HOSTNAME=`
fact keeps the provider's default name, which is how the plan is recognised), and the app's service unit is
`sf-example-vm-api` (mold_v0-198: no application or organisation names in the repository). Nothing else was changed, so the self-test judges the
server's own numbers: almost all of that day's sandbox traffic was load checks and hand-back rigs.
