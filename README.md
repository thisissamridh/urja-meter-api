# Urja Meter API

A small read-only REST service in front of the legacy "Urja Meter Ops" portal. It logs into the portal for you, pulls the data through the portal's own JSON endpoints and signed bulk export, cleans it up, and serves it as a documented API with filtering, geo search, a network hierarchy and daily consumption aggregates.

- `PROTOCOL.md`: how the portal works under the hood (auth, endpoints, signing, quirks).
- `openapi.json`: OpenAPI 3.1 description of this API. Also served live at `/openapi.json`, with Swagger UI at `/docs` and Redoc at `/redoc`.

## Structure

```
app/portal.py     portal client: login, session refresh, 429 backoff, HMAC-signed export
app/normalize.py  pure functions: readings cleanup, hierarchy repair, tree building, daily kWh
app/main.py       FastAPI routes and the in-memory cache of the bulk export
tests/            unit tests for the normalisation logic
```

Python, FastAPI, httpx. No database: 403 meters fit in memory and the export gives them all in one request.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # defaults already point at the assignment portal
set -a; . ./.env; set +a
uvicorn app.main:app --port 8000
```

First request triggers login plus the bulk export (about 2 seconds). Then open http://localhost:8000/docs.

Tests: `python -m pytest`.

## Sample requests

```bash
# faulty Genus meters
curl 'localhost:8000/meters?installStatus=Faulty&make=Genus'

# meters within 1 km of a point
curl 'localhost:8000/meters?nearLat=26.93&nearLng=75.83&radiusKm=1'

# one meter with repaired hierarchy and location
curl localhost:8000/meters/J100004

# half-hourly or daily register readings, ISO timestamps, numbers not strings
curl 'localhost:8000/meters/J100000/readings?from=2026-06-01&to=2026-06-02'

# kWh consumed per day
curl 'localhost:8000/meters/J100089/consumption/daily?from=2026-06-20&to=2026-06-30'

# network tree, transformers with meter counts, list of data repairs
curl localhost:8000/hierarchy
curl localhost:8000/transformers
curl localhost:8000/hierarchy/issues
```

Example response, `GET /meters/J100089/consumption/daily?from=2026-06-28&to=2026-06-30`:

```json
{"meterId":"J100089","totalKwh":15.29,"data":[
  {"date":"2026-06-28","kwh":0.0,"readings":1},
  {"date":"2026-06-29","kwh":7.65,"readings":1},
  {"date":"2026-06-30","kwh":7.64,"readings":1}]}
```

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/meters` | list; filters `q, make, phaseType, installStatus, installType, build, dtCode, feederCode, zoneCode`, geo `nearLat, nearLng, radiusKm`, paging `page, pageSize` |
| GET | `/meters/{id}` | nameplate, 7-level hierarchy, location |
| GET | `/meters/{id}/readings?from&to` | cumulative kWh/kVAh registers plus voltage, deduplicated, typed |
| GET | `/meters/{id}/consumption/daily?from&to` | kWh per calendar day |
| GET | `/transformers` | DTs with feeder, capacity, meter count |
| GET | `/hierarchy` | zone > circle > division > subdivision > substation > feeder > DT tree with counts |
| GET | `/hierarchy/issues` | every repair made to upstream hierarchy data |
| GET | `/health`, POST `/refresh` | cache status, force re-pull |

Errors are `{"error": "...", "message": "..."}` with 404 for unknown meters, 502 for upstream failures, 503 when the portal keeps rate-limiting.

## Assumptions

- The portal is read-only and one operator login is shared by the service. Credentials come from env vars.
- The signed bulk export is a legitimate feature for logged-in users (the UI has a button for it), so using it programmatically is fair game.
- Readings only exist for June 2026 on this instance. The API does not invent a default window; it passes `from`/`to` through and otherwise returns the portal's default (last 7 days of data).
- A hierarchy node is identified by its full path. The same code under different parents is treated as different nodes, because that is what the data says and I have no way to tell which parent is "right".
- A blank code with a known name (or vice versa) is a data-entry gap, not a different entity, so filling it from sibling records is safe. Every fill is logged.

## Design decisions and trade-offs

- **Bulk export over per-meter scraping.** One signed request replaces roughly 830 calls, avoids the two nameplate formats, and sidesteps the rate limit. Cost: the export must be re-signed and could change shape independently of the pages.
- **In-memory cache with a TTL (default 15 min)** for meters, hierarchy and transformers. Readings are always fetched live because they are the only thing that changes often and are per-meter. If a refresh fails, the last good snapshot keeps serving. Consistency: meter attributes can be up to TTL stale; `/refresh` forces a pull.
- **Filtering in Python over a list.** Fine to a few tens of thousands of meters. Beyond that, or once readings need cross-meter aggregation, I would load the export into SQLite (or Postgres with PostGIS for the geo query) and keep the same endpoints.
- **No auth on this API.** It runs inside the network; adding an API key is a one-line dependency in FastAPI, deliberately left out.
- **Retries and backoff** live in one place (`Portal.get`): re-login on 302/401, exponential sleep on 429, small retry on 5xx and connection errors, 404 mapped through.

## Intentionally skipped

- A web client. The API and Swagger UI were the priority in the time.
- Persisting readings. Each request goes to the portal; a bulk readings sync would need ~403 calls per pull and a schedule that respects the rate limit.
- Per-user auth, metrics, Docker. All straightforward, none needed to evaluate the approach.

## With more time

- Background job that pulls readings for all meters once a day into SQLite, enabling fleet-wide consumption queries and anomaly flags (zero consumption on Installed meters, voltage out of band).
- ETag on the export to skip re-parsing when unchanged, and a `lastRefreshed` header on responses.
- Contract tests against recorded portal responses so portal changes fail loudly.
- Consumption endpoint for 30-minute meters at hourly granularity.

## Reflection

**Assumptions.** Listed above. The biggest one is that the export is an intended feature; it was, since the UI button uses it. The second is that hierarchy codes reused across parents is real (not a bug I should collapse), so I preserved it and documented it rather than guessing a canonical parent.

**Hardest part.** The portal renders empty tables on the server, so curl alone showed nothing. Reading the hashed SvelteKit chunks revealed every fetch, including the export button's HMAC code, which I then reproduced in Python. The other sticking point was the rate limiter: an 8-way parallel sweep of energy endpoints got 431 429s. Measuring the window (120 requests per 20 s, 40 s cooldown) gave the backoff numbers.

**Another day.** Readings sync plus a small web view with a map of meters coloured by status and a consumption chart per DT. That turns the API from "portal but JSON" into something an operator would prefer.

**Mistake.** I started by fetching energy for every meter in parallel to profile data quality, tripped the rate limit hard, and had to wait it out and re-run. Should have checked limits with a small burst first. Also, I initially assumed the hierarchy was a clean tree and wrote a code-keyed tree before the profiling showed multi-parent codes.

**Self-review.** The store refreshes inline on the first request after TTL, so one caller pays the export latency; a background refresh would be better. `list_meters` has a long parameter list that could be a Pydantic model. Tests cover normalisation only, not the HTTP client, which is where the portal-specific breakage would actually surface. And the daily consumption for a day with a single reading reports the delta from the previous day's close, which is right for daily meters but should be documented more loudly.
