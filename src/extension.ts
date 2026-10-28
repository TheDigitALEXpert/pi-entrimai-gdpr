/**
 * pi-provider-entrim
 *
 * Registers "entrim" as a pi provider over Entrim's OpenAI-compatible API.
 *
 * - Uses pi's built-in `openai-completions` implementation (no custom stream).
 * - Reads the key from $ENTRIM_API_KEY, or an api-key /login credential.
 * - `refreshModels` auto-fetches the live catalog from GET /v1/models and
 *   persists it via `context.publish({ persist })` for offline startup.
 *
 * Usage:
 *   export ENTRIM_API_KEY=sk-...   # or run /login entrim
 *   pi
 *   /model      -> search "entrim"
 *   --model entrim/deepseek-ai/DeepSeek-V4.1-Flash
 */

import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { PRICING_URL, priceFor, pricesFromModelList, resolvePrices, UNKNOWN_PRICE, type Price } from "./pricing.ts";

const BASE_URL = "https://api.entrim.ai/v1";

/**
 * Pricing is scraped from entrim.ai/pricing because `/v1/models` publishes no
 * price data at all. See src/pricing.ts for the full rationale.
 */

// Small bootstrap set so the provider is usable before the first refresh
// completes. Overwritten by refreshModels once auth resolves.
//
// `cost` is required by pi's model types and dereferenced by calculateCost(), so
// a real price is always present once refreshModels has run. See src/pricing.ts.
const BOOTSTRAP_MODELS: ProviderModelConfig[] = [
	{
		id: "deepseek-ai/DeepSeek-V4.1-Flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.2, output: 0.6, cacheRead: 0.005, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

/**
 * Map a raw LiteLLM-style `{ data: [{ id, owned_by, ... }] }` response to
 * full pi chat models, attaching the scraped price.
 *
 * `/v1/models` carries no price field, so `prices` comes from the pricing page.
 * When a model has no known price it gets zero rates: pi then renders no dollar
 * figure at all (its footer only prints one for a non-zero total), and the id is
 * returned in `unpriced` so the caller can warn instead of failing silently.
 *
 * Remaining metadata is still heuristic — `/v1/models` returns only id, limits,
 * datacenters and a beta flag.
 */
function mapModels(
	data: { id: string; owned_by?: string; max_input_tokens?: number; max_output_tokens?: number }[],
	prices: Record<string, Price>,
): { models: Model<"openai-completions">[]; unpriced: string[] } {
	const unpriced: string[] = [];

	const models = data.map((m) => {
		const price = priceFor(prices, m.id);
		if (!price) unpriced.push(m.id);
		const model: Model<"openai-completions"> = {
			id: m.id,
			name: m.id, // no friendlier name available from the catalog
			api: "openai-completions",
			provider: "entrim",
			baseUrl: BASE_URL,
			reasoning: /reasoning|v4|v3|opus|gpt-5/i.test(m.id),
			input: ["text"],
			cost: price ?? UNKNOWN_PRICE,
			contextWindow: m.max_input_tokens ?? 128000,
			maxTokens: m.max_output_tokens ?? 8192,
		};
		return model;
	});

	return { models, unpriced };
}

function buildConfig(): ProviderConfig {
	return {
		name: "Entrim",
		baseUrl: BASE_URL,
		api: "openai-completions", // Entrim speaks OpenAI Chat Completions
		apiKey: "$ENTRIM_API_KEY", // env-var based auth
		authHeader: true, // emit Authorization: Bearer <key>

		models: BOOTSTRAP_MODELS,

		/*
		 * Optional: add a "/login entrim" row that prompts for and stores an
		 * API key in auth.json (as OAuth-shaped credentials). Uncomment if you
		 * want interactive login instead of the env var.
		 */
		// oauth: {
		//   name: "Entrim",
		//   async login(callbacks) {
		//     const key = await callbacks.onPrompt({ message: "Paste your Entrim API key:" });
		//     return { access: key.trim(), refresh: "", expires: Number.MAX_SAFE_INTEGER };
		//   },
		//   async refreshToken(credentials) { return credentials; },
		//   getApiKey: (cred) => cred.access,
		// },

		/**
		 * Live discovery. Returns the provider-owned model list; pi replaces the
		 * extension models with it. Persisted via context.publish so the catalog
		 * survives restart and can restore offline.
		 */
		async refreshModels(context) {
			// Restore the persisted catalog first (offline / cache-only init).
			const stored = context.stored;
			if (stored) {
				const restored = stored.models.filter((m) => (m as { provider?: string }).provider === "entrim");
				if (restored.length > 0 && !context.allowNetwork) return restored as ProviderModelConfig[];
			}

			if (!context.allowNetwork || context.signal.aborted) return [];

			const apiKey =
				context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			// With $ENTRIM_API_KEY interpolation pi resolves the key via credential?.key,
			// so no direct process.env access is needed here.
			if (!apiKey) return []; // not authenticated yet; keep whatever is registered

			let res: Response;
			try {
				res = await fetch(`${BASE_URL}/models`, {
					signal: context.signal,
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				});
			} catch {
				// Network failure: retain the last known list.
				return [];
			}
			if (!res.ok) return [];

			const body = (await res.json()) as {
				data?: {
					id: string;
					owned_by?: string;
					max_input_tokens?: number;
					max_output_tokens?: number;
				}[];
			};

			// `/v1/models` usually carries no price field, so the pricing page is
			// scraped. If the provider ever starts publishing prices on the API, those
			// win and the scrape is skipped entirely.
			const apiPrices = pricesFromModelList(body.data);
			const { prices, source } = await resolvePrices(context.signal, apiPrices);
			const { models, unpriced } = mapModels(body.data ?? [], prices);

			if (unpriced.length > 0) {
				console.warn(
					`[entrim] no price found for ${unpriced.join(", ")} (source: ${source}). ` +
						`These models report tokens without a cost figure. ` +
						`Check ${PRICING_URL} or update SNAPSHOT_PRICES in src/pricing.ts.`,
				);
			}

			// Persist so the catalog is available offline next start. Returning the
			// list below installs it as this provider's live models. Prices are baked
			// into each model, so an offline restart still has real figures.
			await context.publish({
				persist: { models, checkedAt: Date.now() },
			});
			return models;
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("entrim", buildConfig());
}