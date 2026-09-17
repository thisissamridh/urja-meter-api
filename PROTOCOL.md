# How the Urja Meter Ops portal works

Findings from poking at https://urja-ops.flockenergy.tech with curl and by reading the shipped JS bundles. No browser needed.

## Stack

SvelteKit app. Pages are server-rendered shells; every table is then filled client-side by `fetch` calls to `/portal/*` JSON endpoints. Auth is [better-auth](https://better-auth.com) (cookie name gives it away).

Route map (from `_app/immutable/entry/app.*.js`): `/login`, `/meters`, `/meters/[id]`, `/transformers`.

## Authentication

- `POST /login` with form fields `email`, `password` (a SvelteKit form action, so send an `Origin` header). Returns JSON `{"type":"redirect","status":303,"location":"/meters"}` and sets `__Secure-better-auth.session_token` (HttpOnly, `Max-Age=3600`).
- The cookie is the only credential. All `/portal/*` endpoints need it. Without it page routes 302 to `/login`.
- Session lasts one hour; the client re-logs-in on 302/401.
- `POST /api/auth/sign-out` logs out. Not used.

## Endpoints the frontend uses

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /portal/meters/search?q=&page=N` | `{data:[{meterId,serialNo,make,phaseType,installStatus,dtCode}],total,page,pageSize:20}` | 403 meters, 21 pages. Page size is fixed. `q` matches meter ID or serial. |
| `GET /meters/{id}/__data.json` | SvelteKit devalue-encoded load data: nameplate `detail` and a flat `hierarchy` map | Two nameplate shapes exist (see quirks). 404 comes back as a 200 with an error node inside. |
| `GET /portal/meters/{id}/geo` | `{data:{latitude,longitude}}` as strings | |
| `GET /portal/meters/{id}/energy?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{data:[{timestamp:"DD/MM/YYYY HH:MM",kwh,kvah,voltR}]}` all strings | `from`/`to` undocumented in the UI; found by guessing. Default window is the last 7 days of data. Only June 2026 has data. Unparseable dates are silently ignored. |
| `GET /portal/dts?page=N` | `{data:[{code,name,feederCode,capacityKva}],total:40,pageSize:20}` | |
| `GET /portal/keys` | `{data:{signingSecret}}` | Secret for the export signature. Any logged-in user can read it. |
| `GET /portal/export?page=1` | `{data:[...403 meters...],total}` | **Bulk path.** Every meter with full `hierarchy` (7 levels of `{name,code}`), `geo` (numeric lat/lng), `installType`, `build`. Needs HMAC headers below. `page` is ignored; every value returns everything. |

## Signed export

Reverse-engineered from the "Export all meters" button in `nodes/4.*.js`:

```
message   = "GET\n/portal/export\n<query string>\n<unix seconds>"
signature = hex(HMAC-SHA256(signingSecret, message))
headers   : x-timestamp, x-signature
```

Timestamp skew tolerance is about 5 minutes (tested: -120s ok, -301s rejected, +120s ok, +400s rejected). Missing or bad signature gives 401 `signature_invalid`. The secret was stable across the session; the client refetches it once on a signature failure in case it rotates.

I use the export as the source of truth for meter lists, hierarchy and location: one request instead of 21 search pages plus 403 detail plus 403 geo calls, and it carries fields (`installType`, `build`) the search list lacks.

## Rate limiting

Roughly 120 requests per 20 seconds per session, then `429 {"error":"rate_limited"}` with no `Retry-After`, and about 40 seconds until it clears. Pulling energy for all 403 meters in parallel trips it immediately. The client backs off exponentially (5s, 10s, 20s, 40s) and retries.

## Data quirks

- **Two nameplate formats.** `build: "legacy"` meters return `detail.data` as a list of `{parameterName, parameterValue}`; `build: "v2"` meters return `detail.classData`, a JSON *string* with `installed_meter: {MeterId, SerialNo, ...}`. The export normalises both, another reason to prefer it.
- **Hierarchy gaps.** 22 of 403 meters have a level with a blank `code` (name present) or blank `name` (code present). The detail page shows the same gaps. I repair them by looking up the name/code from other meters, and expose every repair at `/hierarchy/issues`.
- **Codes are reused under different parents.** `D-01` appears under `C-01`, `C-03` and `C-05`; every subdivision has 2-3 parent divisions. So the network is not a tree keyed by code. My tree keys nodes by full path.
- **DT-007 has two names** (`Sanganer DT 7` and `Old Malviya Nagar Xfmr`). I keep the majority name and log the alias.
- **Five meters have a blank feeder** while `/portal/dts` knows the DT's feeder; the name is present so name lookup fixes it, with DT feeder as a fallback.
- **Two reading granularities.** 39 meters report every 30 minutes (1440 rows in June), the rest once a day at 00:00 (30 rows). No correlation with make, build, status or phase that I could find.
- **Duplicate timestamps.** Four meters (J100089, J100134, J100195, J100330) have a second `30/06/2026 00:00` row with blank `kwh` and `voltR`. I drop the blank duplicate.
- Registers are cumulative and monotonic; no rollovers or spikes seen in June.
- All numbers are strings. Voltage is always in 220-249.
- `installStatus` values: Installed, Faulty, Decommissioned. Decommissioned meters still report readings.

## For a maintainer

- Everything portal-specific is in `src/portal.ts`. If the portal changes, that is the file to touch.
- If `/portal/keys` disappears or the signature scheme changes, `fetchExport` fails and the server keeps serving its last good snapshot; `/health` shows `cacheAgeSeconds`.
- The session cookie is a module-level variable in `src/portal.ts`. It is cleared on a 302/401 and the next request logs in again.
