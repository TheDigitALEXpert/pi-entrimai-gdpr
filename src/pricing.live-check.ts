/**
 * Live integration check against the real Entrim pricing page.
 *
 * Not part of `node --test` (it needs the network), run manually:
 *   node src/pricing.live-check.ts
 *
 * Verifies three things the unit tests cannot:
 *   1. the parser still finds prices in the live page (format has not drifted)
 *   2. every model /v1/models serves has a price
 *   3. SNAPSHOT_PRICES still agrees with what the page says
 */
import { fetchLivePrices, priceFor, SNAPSHOT_PRICES, PRICING_URL } from "./pricing.ts";

const MODELS_URL = "https://api.entrim.ai/v1/models";

const apiKey = process.env.ENTRIM_API_KEY;

const live = await fetchLivePrices(AbortSignal.timeout(30_000));
if (!live) {
	console.error(`FAIL: could not parse prices from ${PRICING_URL}`);
	process.exit(1);
}
console.log(`parsed ${Object.keys(live).length} prices from the live page\n`);

for (const [id, p] of Object.entries(live).sort(([a], [b]) => a.localeCompare(b))) {
	console.log(
		`  ${id.padEnd(40)} in=${String(p.input).padEnd(7)} out=${String(p.output).padEnd(6)} cache=${p.cacheRead}`,
	);
}

if (!apiKey) {
	console.log("\n(no ENTRIM_API_KEY: skipping /v1/models cross-check)");
} else {
	const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
	const body = (await res.json()) as { data?: { id: string }[] };
	const ids = (body.data ?? []).map((m) => m.id);

	console.log(`\ncross-check against ${ids.length} served models:`);
	let missing = 0;
	for (const id of ids) {
		const p = priceFor(live, id);
		if (p) {
			console.log(`  ok       ${id}`);
		} else {
			missing++;
			console.log(`  UNPRICED ${id}`);
		}
	}
	console.log(`\n${ids.length - missing}/${ids.length} priced`);
	if (missing > 0) console.log("Unpriced ids are expected only for embeddings models.");
}

// Snapshot drift: the page always wins, but a stale snapshot means a scrape
// failure would silently fall back to wrong numbers.
console.log("\nsnapshot drift:");
let drifted = 0;
for (const [id, snap] of Object.entries(SNAPSHOT_PRICES)) {
	const livep = priceFor(live, id);
	if (!livep) {
		console.log(`  missing on page: ${id}`);
		continue;
	}
	if (
		livep.input !== snap.input ||
		livep.output !== snap.output ||
		livep.cacheRead !== snap.cacheRead
	) {
		drifted++;
		console.log(
			`  DRIFT ${id}: snapshot ${snap.input}/${snap.output}/${snap.cacheRead} ` +
				`vs live ${livep.input}/${livep.output}/${livep.cacheRead}`,
		);
	}
}
if (drifted === 0) console.log("  none - snapshot matches the live page");
