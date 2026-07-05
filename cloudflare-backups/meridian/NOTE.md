# meridian (Worker) — code not backed up

Metadata only. The Cloudflare API returned a malformed/empty response
when fetching this Worker's source (`workers_get_worker_code` failed
with an invalid-content error on repeated attempts), so the script
body could not be retrieved for backup. This likely means it's a
multi-module or Pages-style deployment that doesn't fit the
single-file `worker.js` shape the tool expects.

## Known metadata

- name: `meridian`
- id: `3bbaefa6e84c40f5864d9b0b9ffcabe7`
- created_on: 2026-07-01T09:13:15.715915Z
- modified_on: 2026-07-04T15:57:47.952432Z

To back this one up, pull the source directly, e.g.:

```
wrangler deploy --dry-run --outdir ./out --name meridian
```

or download it from the Cloudflare dashboard, then commit it here.
