# Cloudflare Workers — deploy source

This directory is the source of truth for the Workers that GitHub Actions
deploys automatically. Editing a file here and merging to `main` triggers
`.github/workflows/deploy-cloudflare.yml`, which runs `wrangler deploy`
for the affected Worker.

| Worker | Directory | Notes |
|---|---|---|
| `meridian-website` | moved to [`genesysc/meridian-website`](https://github.com/genesysc/meridian-website) | No longer deployed from this repo |
| `meridian-leads-api` | `workers/meridian-leads-api` | Bound to the `meridian_leads` D1 database |
| `meridian` | not set up | Source unavailable — see `cloudflare-backups/meridian/NOTE.md` |

## One-time setup required (you, not me)

The workflow needs two repo secrets under
**Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with "Edit Cloudflare
  Workers" permission for this account (create one at
  https://dash.cloudflare.com/profile/api-tokens)
- `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand sidebar of any zone's
  Overview page in the Cloudflare dashboard

Once set, merging a PR that touches `workers/**` deploys automatically —
no manual copy-paste into the Cloudflare dashboard needed.
