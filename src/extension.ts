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

const BASE_URL = "https://api.entrim.ai/v1";

// Small bootstrap set so the provider is usable before the first refresh
// completes. Overwritten by refreshModels once auth resolves.
const BOOTSTRAP_MODELS: ProviderModelConfig[] = [
	{
		id: "deepseek-ai/DeepSeek-V4.1-Flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
];

/**
 * Map a raw LiteLLM-style `{ data: [{ id, owned_by, ... }] }` response to
 * full pi chat models. Metadata is heuristic — refine once real caps are known.
 */
function mapModels(data: { id: string; owned_by?: string }[]): Model<"openai-completions">[] {
	return data.map((m) => ({
		id: m.id,
		name: m.id, // no friendlier name available from the catalog
		api: "openai-completions",
		provider: "entrim",
		baseUrl: BASE_URL,
		reasoning: /reasoning|v4|v3|opus|gpt-5/i.test(m.id),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}));
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

			const body = (await res.json()) as { data?: { id: string; owned_by?: string }[] };
			const models = mapModels(body.data ?? []);

			// Persist so the catalog is available offline next start. Returning the
			// list below installs it as this provider's live models.
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