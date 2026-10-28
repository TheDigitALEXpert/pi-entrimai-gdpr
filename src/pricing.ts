/**
 * Entrim pricing scraper.
 *
 * WHY THIS EXISTS
 * ---------------
 * `GET /v1/models` is the only machine-readable catalog Entrim publishes, and it
 * carries NO price data. The complete key set across every served model is:
 *
 *   id, object, created, owned_by, datacenters, beta, max_input_tokens, max_output_tokens
 *
 * So a provider built only on `/v1/models` has no price to report and silently
 * claims every request cost nothing.
 *
 * Entrim DOES publish per-model prices - on https://entrim.ai/pricing, embedded
 * in the Next.js RSC payload as:
 *
 *   {"price":{"input":"0.10","output":"0.35","cacheRead":"0.0175"}, ... ,"apiModelName":"deepseek-ai/DeepSeek-V4.1-Flash"}
 *
 * Values are USD per 1M tokens, keyed by `apiModelName` - the same id
 * `/v1/models` returns.
 *
 * STRATEGY (scrape -> snapshot -> zero + warn)
 * -------------------------------------------
 * 1. Scrape the pricing page on every refresh. Fresh data always wins.
 * 2. If the scrape fails, fall back to SNAPSHOT_PRICES below (a committed
 *    point-in-time capture), so a cold start or a blocked request still prices
 *    correctly.
 * 3. If a model still has no price, use zero rates AND report it to the caller.
 *
 * WHY ZERO RATES RATHER THAN NO `cost` KEY
 * ----------------------------------------
 * Omitting `cost` is not an option: pi's `ModelCost` requires all four rates as
 * numbers, and `calculateCost()` dereferences `model.cost.input` unconditionally,
 * so a missing `cost` throws at request time.
 *
 * Zero rates are the only expressible "unknown", and they behave correctly in the
 * UI: pi's footer only renders a dollar figure when the accumulated total is
 * truthy (`if (usageTotals.cost)`), so an unpriced model shows tokens and no
 * misleading "$0.000". The caller is expected to surface the unknown ids so the
 * silence is explained rather than hidden.
 *
 * This module is deliberately dependency-free and I/O-only via `fetch`, which the
 * host provides.
 */

/** USD per 1M tokens. `cacheWrite` is always 0: Entrim does not bill it separately. */
export type Price = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export const PRICING_URL = "https://entrim.ai/pricing";

/**
 * Point-in-time capture of https://entrim.ai/pricing (last verified: 2026-10-09).
 *
 * Used ONLY when the live scrape fails. Treat it as a stale-but-better-than-zero
 * fallback, not as truth: the live page always wins when reachable. Refresh this
 * by running the scraper against the page and pasting the result.
 */
export const SNAPSHOT_PRICES: Record<string, Price> = {
	"deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.2, output: 0.6, cacheRead: 0.005, cacheWrite: 0 },
	"deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.2, output: 0.6, cacheRead: 0.005, cacheWrite: 0 },
	"deepseek-ai/DeepSeek-V4-Flash": { input: 0.09, output: 0.17, cacheRead: 0.015, cacheWrite: 0 },
	"zai-org/GLM-5.3": { input: 0.5, output: 2.0, cacheRead: 0.15, cacheWrite: 0 },
	"zai-org/GLM-5.3-Flash": { input: 0.1, output: 0.35, cacheRead: 0.0175, cacheWrite: 0 },
	"zai-org/GLM-5.2": { input: 0.9, output: 3.0, cacheRead: 0.15, cacheWrite: 0 },
	"Qwen/Qwen3.6-27B": { input: 0.1, output: 0.4, cacheRead: 0.04, cacheWrite: 0 },
	"Qwen/Qwen3.6-35B-A3B": { input: 0.05, output: 0.25, cacheRead: 0.025, cacheWrite: 0 },
	"Qwen/Qwen3.8-27B": { input: 0.1, output: 0.4, cacheRead: 0.04, cacheWrite: 0 },
	"google/gemma-4-26B-A4B-it": { input: 0.05, output: 0.25, cacheRead: 0.025, cacheWrite: 0 },
	"google/gemma-4-31B-it": { input: 0.1, output: 0.3, cacheRead: 0.04, cacheWrite: 0 },
	"openai/gpt-oss-120b": { input: 0.029, output: 0.13, cacheRead: 0.01, cacheWrite: 0 },
	"openai/gpt-oss-20b": { input: 0.02, output: 0.1, cacheRead: 0.005, cacheWrite: 0 },
};

/** Next.js streams the flight payload as `self.__next_f.push([1,"<escaped string>"])`. */
const RSC_CHUNK_RE = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;

/** Records in the payload are objects beginning with `{"id":"<slug>"`. */
const RECORD_SPLIT_RE = /\},\{"id":"/;

const API_MODEL_NAME_RE = /"apiModelName":"([^"]+)"/;

/**
 * The price object sits BEFORE `apiModelName` inside the same record, so the
 * whole record must be inspected, never a forward-only window (doing that
 * silently returns the NEXT model's price).
 */
const PRICE_RE = /"price":\{"input":"([\d.]+)","output":"([\d.]+)"(?:,"cacheRead":"([\d.]+)")?\}/;

/** Reassemble the flight payload from the streamed chunks. */
function rscPayload(html: string): string {
	let out = "";
	RSC_CHUNK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = RSC_CHUNK_RE.exec(html)) !== null) {
		try {
			out += JSON.parse(m[1]) as string;
		} catch {
			// A malformed chunk is skipped; the rest of the payload still parses.
		}
	}
	return out;
}

function toPrice(input: string, output: string, cacheRead?: string): Price {
	return {
		input: Number(input),
		output: Number(output),
		cacheRead: cacheRead ? Number(cacheRead) : 0,
		cacheWrite: 0,
	};
}

/**
 * Parse prices out of the pricing page's RSC payload.
 *
 * Each record carries `apiModelName` (the id `/v1/models` also uses) and a
 * sibling `price` object. Records are split on their leading `{"id":"` so a
 * price can never be attributed to a neighbouring model.
 *
 * Exported for tests: feed it fixture HTML, not the network.
 */
export function parsePrices(html: string): Record<string, Price> {
	const payload = rscPayload(html);
	if (payload.length === 0) return {};

	const prices: Record<string, Price> = {};
	for (const record of payload.split(RECORD_SPLIT_RE)) {
		const apiName = API_MODEL_NAME_RE.exec(record);
		const price = PRICE_RE.exec(record);
		if (!apiName || !price) continue;

		const id = apiName[1];
		// First occurrence wins; the payload repeats records across views.
		if (id in prices) continue;

		const parsed = toPrice(price[1], price[2], price[3]);
		if (!Number.isFinite(parsed.input) || !Number.isFinite(parsed.output)) continue;
		prices[id] = parsed;
	}
	return prices;
}

/** Scrape live prices. Returns undefined on any failure (never throws). */
export async function fetchLivePrices(signal: AbortSignal): Promise<Record<string, Price> | undefined> {
	try {
		const res = await fetch(PRICING_URL, {
			signal,
			headers: {
				// The page is served to browsers; a default fetch UA can be rejected.
				"User-Agent": "Mozilla/5.0 (compatible; pi-entrim-provider)",
				Accept: "text/html",
			},
		});
		if (!res.ok) return undefined;

		const html = await res.text();
		const prices = parsePrices(html);
		// An empty parse almost certainly means the page format changed. Treat it
		// as a failure so the snapshot covers us instead of silently unpricing.
		return Object.keys(prices).length > 0 ? prices : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the price table to use: live when available, snapshot otherwise.
 *
 * `source` lets callers report which path was taken.
 */
export async function resolvePrices(signal: AbortSignal): Promise<{
	prices: Record<string, Price>;
	source: "live" | "snapshot";
}> {
	const live = await fetchLivePrices(signal);
	if (live) return { prices: live, source: "live" };
	return { prices: SNAPSHOT_PRICES, source: "snapshot" };
}

/**
 * Look up a model's price.
 *
 * Returns `undefined` when unknown. Callers pass these ids to `report` so the
 * gap is visible; the model itself gets zero rates (see the header note).
 *
 * Matching is exact first, then case-insensitive: provider ids are treated as
 * opaque by pi, but casing drift between the pricing page and `/v1/models` is
 * the one difference worth tolerating.
 */
export function priceFor(prices: Record<string, Price>, modelId: string): Price | undefined {
	const exact = prices[modelId];
	if (exact) return exact;

	const lower = modelId.toLowerCase();
	for (const [id, price] of Object.entries(prices)) {
		if (id.toLowerCase() === lower) return price;
	}
	return undefined;
}

/** Zero rates: the only expressible "price unknown" in pi's `ModelCost`. */
export const UNKNOWN_PRICE: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
