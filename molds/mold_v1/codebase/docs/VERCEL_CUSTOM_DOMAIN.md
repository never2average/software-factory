# Vercel custom domain

The dashboard can serve both its default `<project>.vercel.app` address and a
custom hostname such as `app.example.com`. Adding a custom domain does not
remove the default `vercel.app` domain unless a redirect is configured.

Below, `app.example.com` stands for your hostname, `agent-workspace` for the
dashboard's Vercel project and `your-vercel-team` for your Vercel team.

## 1. Add the hostname to the dashboard project

```sh
vercel domains add app.example.com agent-workspace \
  --scope your-vercel-team
```

Then inspect the domain for the exact DNS and ownership records Vercel assigned:

```sh
vercel domains inspect app.example.com \
  --scope your-vercel-team
```

## 2. Add DNS at your DNS provider

In the DNS manager of the provider that serves `example.com`, add:

- type: `CNAME`
- name/host: `app`
- value: the exact CNAME target printed by `vercel domains inspect`
- TTL: default

The value from `inspect` is authoritative; Vercel may rotate it. If Vercel
requests domain ownership verification, also add the exact TXT record it
prints. Remove any conflicting `app` A, AAAA, or CNAME record first.

## 3. Verify

```sh
dig +short app.example.com CNAME
vercel domains inspect app.example.com \
  --scope your-vercel-team
curl --fail --show-error --head https://app.example.com
curl --fail --show-error --head https://agent-workspace.vercel.app
```

Vercel provisions TLS automatically after DNS and ownership verification. Do not
add a redirect between these hostnames if both should remain directly usable.

Once both answer, `/api/ops/health` on the custom hostname checks the database,
Blob, inference, mail, and task-workflow dependencies through it.
