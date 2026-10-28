# pi-provider-gdpr-inference

A [pi](https://pi.dev) provider package that registers an **entrim** provider over
Entrim's OpenAI-compatible API at `https://api.entrim.ai/v1`. Entrim is a
GDPR-compliant EU inference platform.

## What it does

- **Registers `entrim`** as a pi provider (appears in `/model` as `entrim/...`).
- **Reuses pi's built-in `openai-completions` implementation** — no custom
  streaming code, so tool calls, usage/cost accounting, cancellation, and
  context-overflow handling all come for free.
- **Auto-discovers the model catalog** from `GET /v1/models` once a key is
  available, and **persists** it so the list is available offline on restart.
- **Attaches real per-model prices** scraped from the Entrim pricing page, so
  the session cost in pi's footer reflects what you are actually billed.

## Pricing

`GET /v1/models` publishes **no price data**. The complete key set across every
served model is:

```
id, object, created, owned_by, datacenters, beta, max_input_tokens, max_output_tokens
```

Entrim does publish per-model prices, on <https://entrim.ai/pricing>, embedded in
the page's Next.js RSC payload as USD per 1M tokens:

```json
{"price":{"input":"0.10","output":"0.35","cacheRead":"0.0175"},"apiModelName":"deepseek-ai/DeepSeek-V4.1-Flash"}
```

On every refresh this provider scrapes that page and attaches the price to each
model.

**API prices win**

If a future `/v1/models` response carries prices itself, those are authoritative
and **no scraping happens at all** - no pricing-page fetch, no snapshot. The
following shapes are recognised, covering the conventions LiteLLM and
OpenAI-compatible gateways use:

```jsonc
{ "id": "...", "cost":    { "input": 0.1, "output": 0.35, "cacheRead": 0.0175 } }
{ "id": "...", "pricing": { "input": "0.10", "output": "0.35", "cache_read": "0.0175" } }
{ "id": "...", "input_price": "0.10", "output_price": "0.35" }
```

A price counts only when **both** input and output are present and finite; a
half-specified price is ignored rather than half-applied, since that would
understate spend.

**Scrape → snapshot → zero + warn**

1. **API prices** published by `/v1/models` itself, when present. Scraping is then
   skipped entirely.
2. **Scrape** the live pricing page. Fresh data always wins.
3. If the scrape fails (offline, blocked, format change), fall back to a
   committed `SNAPSHOT_PRICES` table in `src/pricing.ts`, so a cold start still
   prices correctly.
4. If a model is still unpriced, it gets zero rates and its id is logged as a
   warning — pi then shows tokens with no dollar figure rather than a
   misleading `$0.000`.

> **Why zero rates instead of omitting `cost`?** pi's `ModelCost` requires all
> four rates as numbers and `calculateCost()` dereferences `model.cost.input`
> unconditionally, so a missing `cost` throws. Zero is the only expressible
> "unknown", and pi's footer only prints a dollar amount when the accumulated
> total is non-zero, so an unpriced model stays silent instead of claiming to
> be free.

Verify the parser against the live page at any time:

```bash
npm run pricing:check
```

This prints the scraped table, cross-checks it against `/v1/models`, and reports
any drift between the live page and `SNAPSHOT_PRICES`.

## Install

```bash
pi install npm:pi-provider-gdpr-inference
# try once without installing:
pi -e ./pi-provider-gdpr-inference
```

Then provide a key (either way works):

```bash
export ENTRIM_API_KEY=sk-...
# or run the interactive login:
/model
```

Verify it registered:

```bash
pi --list-models | grep entrim
# or inside pi:
/model   # search "entrim"
```

Use a model:

```bash
pi --model entrim/deepseek-ai/DeepSeek-V4.1-Flash
```

## How it works

1. A small **bootstrap model list** is registered so the provider is usable
   immediately after load.
2. On startup/refresh, pi calls `refreshModels`. If a credential resolves,
   it fetches `GET /v1/models`, maps the LiteLLM-style `data` array to pi model
   configs, and returns them — pi replaces the bootstrap list with the live one.
3. The list is persisted via `context.publish({ persist })`; on a later offline
   start, `refreshModels` restores it before touching the network. Prices are
   baked into each persisted model, so an offline restart keeps real figures.

## Customization

Users can override the endpoint, headers, or per-model metadata in their own
`~/.pi/agent/models.json` — pi composes `models.json` overrides **above** the
registered provider.

## Notes for maintainers

- Keep `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` in
  `peerDependencies` (host-supplied), never in `dependencies`.
- Model metadata (`reasoning`, `contextWindow`, `maxTokens`) in `mapModels` is
  still heuristic — `/v1/models` only supplies limits and a beta flag. `cost` is
  **not** heuristic: it comes from the scraped pricing table.
- The pricing parser keys on `apiModelName` and requires splitting records on
  their leading `{"id":"`, because `price` appears *before* `apiModelName` in the
  same record. A forward-only search from the name silently returns the **next**
  model's price. `src/pricing.test.ts` locks this behaviour in.
- `SNAPSHOT_PRICES` in `src/pricing.ts` is a fallback, not truth. Run
  `npm run pricing:check` before a release and refresh it if drift is reported.
- `/login entrim` interactive key login (via `oauth`) is left as a commented
  option in `extension.ts`; enable it if you want credentials stored in
  `auth.json` rather than an env var.

## Development

```bash
npm install          # get host peer deps for type-checking
npm run check        # tsc --noEmit
npm test             # parser tests (offline fixtures)
npm run pricing:check  # live scrape + /v1/models cross-check + snapshot drift
```

Load locally while developing:

```bash
pi -e ./pi-provider-gdpr-inference
```
