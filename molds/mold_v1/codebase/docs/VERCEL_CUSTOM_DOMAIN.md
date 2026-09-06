# Vercel custom domain

The dashboard can serve both `fde-agent.vercel.app` and
`delivered.useimmaculate.com`. Adding a custom domain does not remove the default
`vercel.app` domain unless a redirect is configured.

## 1. Add the hostname to the dashboard project

```sh
vercel domains add delivered.useimmaculate.com fde-agent \
  --scope f20170061g-3183s-projects
```

Then inspect the domain for the exact DNS and ownership records Vercel assigned:

```sh
vercel domains inspect delivered.useimmaculate.com \
  --scope f20170061g-3183s-projects
```

## 2. Add DNS at GoDaddy

`useimmaculate.com` currently uses GoDaddy nameservers. In its DNS manager, add:

- type: `CNAME`
- name/host: `delivered`
- value: the exact CNAME target printed by `vercel domains inspect`
- TTL: default

The hostname is currently verified with the project-specific CNAME target
`ae1a6fc10e0ac0b3.vercel-dns-016.com`. The value from `inspect` remains
authoritative if Vercel ever rotates it. If Vercel requests domain ownership
verification, also add the exact TXT record it prints. Remove any conflicting
`delivered` A, AAAA, or CNAME record first.

## 3. Verify

```sh
dig +short delivered.useimmaculate.com CNAME
vercel domains inspect delivered.useimmaculate.com \
  --scope f20170061g-3183s-projects
curl --fail --show-error --head https://delivered.useimmaculate.com
curl --fail --show-error --head https://fde-agent.vercel.app
```

Vercel provisions TLS automatically after DNS and ownership verification. Do not
add a redirect between these hostnames if both should remain directly usable.

As of 2026-08-01, both `delivered.useimmaculate.com` and
`fde-agent.vercel.app` serve the production dashboard, and the custom-domain
`/api/ops/health` check passes through the database, Blob, inference, mail, and
task-workflow dependencies.
