# Cloudflare backups — meridian

Snapshot of the deployed `meridian*` Workers and the `meridian_leads`
D1 database, pulled from the Cloudflare account on 2026-07-05.

| Item | Type | Status |
|---|---|---|
| `meridian-website` | Worker | Code backed up |
| `meridian-leads-api` | Worker | Code backed up |
| `meridian` | Worker | Metadata only — see `meridian/NOTE.md` |
| `meridian_leads` | D1 database | Metadata only — database is empty (0 tables) |

Re-run this backup periodically to keep it in sync with what's
actually deployed; these files are a point-in-time copy, not a live
mirror.
