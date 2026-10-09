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
   start, `refreshModels` restores it before touching the network.

## Customization

Users can override the endpoint, headers, or per-model metadata in their own
`~/.pi/agent/models.json` — pi composes `models.json` overrides **above** the
registered provider.

## Notes for maintainers

- Keep `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` in
  `peerDependencies` (host-supplied), never in `dependencies`.
- Model metadata (`reasoning`, `contextWindow`, `maxTokens`, `cost`) in
  `mapModels` is heuristic — refine once real per-model specs are known.
- `/login entrim` interactive key login (via `oauth`) is left as a commented
  option in `extension.ts`; enable it if you want credentials stored in
  `auth.json` rather than an env var.

## Development

```bash
npm install          # get host peer deps for type-checking
npm run check        # tsc --noEmit
```

Load locally while developing:

```bash
pi -e ./pi-provider-gdpr-inference
```
