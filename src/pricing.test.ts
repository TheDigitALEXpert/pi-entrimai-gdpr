/**
 * Parser tests for src/pricing.ts.
 *
 * Run with:  node --test src/pricing.test.ts
 * (Node 22+ strips types natively; no build step or test framework required.)
 *
 * These tests are offline by design: they feed fixture HTML shaped like the real
 * Entrim pricing payload, so a format change upstream shows up as a failure here
 * rather than as silently unpriced models in a session.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parsePrices, priceFor, pricesFromModelList, SNAPSHOT_PRICES, UNKNOWN_PRICE } from "./pricing.ts";

/** Build the `self.__next_f.push([1, "..."])` chunk wrapper Next.js emits. */
function rsc(chunks: string[]): string {
	return chunks
		.map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`)
		.join("\n");
}

/**
 * One model record as it appears inside the payload.
 *
 * Ordering is the part that matters and the part that broke the first
 * implementation: `price` comes BEFORE `apiModelName` in the same object, so any
 * forward-only search from the name grabs the NEXT model's price.
 *
 * Self-contained on purpose (id ... price ... apiModelName ...): a trailing
 * fragment would move the record boundary the splitter keys on.
 */
function record(id: string, apiModelName: string, input: string, output: string, cacheRead?: string): string {
	const cache = cacheRead === undefined ? "" : `,"cacheRead":"${cacheRead}"`;
	return `{"id":"${id}","logo":"x","name":"${id}","spec":{"provider":"x"},"price":{"input":"${input}","output":"${output}"${cache}},"paygEnabled":true,"status":"stable","apiModelName":"${apiModelName}","gatewayModel":"${apiModelName}","purpose":"p"}`;
}

/** Join records the way the payload does: `},{` between sibling objects. */
function payload(...records: string[]): string {
	return records.join(",");
}

test("parses input/output/cacheRead from a record", () => {
	const html = rsc([record("ds", "deepseek-ai/DeepSeek-V4.1-Flash", "0.10", "0.35", "0.0175")]);
	const prices = parsePrices(html);

	assert.deepEqual(prices["deepseek-ai/DeepSeek-V4.1-Flash"], {
		input: 0.1,
		output: 0.35,
		cacheRead: 0.0175,
		cacheWrite: 0,
	});
});

test("does not attribute a price to the neighbouring model", () => {
	// Two records in one payload: the second model's price must not leak into the
	// first, and vice versa. This is the exact bug a forward-search produces.
	const html = rsc([
		payload(
			record("a", "zai-org/GLM-5.2", "0.90", "3.00", "0.15"),
			record("b", "zai-org/GLM-5.3", "0.50", "2.00", "0.15"),
		),
	]);
	const prices = parsePrices(html);

	assert.equal(prices["zai-org/GLM-5.2"].input, 0.9, "GLM-5.2 must keep its own price");
	assert.equal(prices["zai-org/GLM-5.3"].input, 0.5, "GLM-5.3 must keep its own price");
});

test("missing cacheRead defaults to 0", () => {
	const html = rsc([record("q", "Qwen/Qwen3.6-27B", "0.029", "0.13")]);
	const prices = parsePrices(html);

	assert.equal(prices["Qwen/Qwen3.6-27B"].cacheRead, 0);
});

test("payload split across chunks is reassembled", () => {
	const whole = record("ds", "deepseek-ai/DeepSeek-V4-Flash", "0.20", "0.60", "0.005");

	// Every split point must reassemble identically; Next.js chunk boundaries are
	// arbitrary and land mid-key in practice.
	for (const mid of [1, 17, Math.floor(whole.length / 2), whole.length - 1]) {
		const prices = parsePrices(rsc([whole.slice(0, mid), whole.slice(mid)]));
		assert.equal(
			prices["deepseek-ai/DeepSeek-V4-Flash"].output,
			0.6,
			`split at ${mid} must still yield the price`,
		);
	}
});

test("garbage HTML yields no prices instead of throwing", () => {
	assert.deepEqual(parsePrices("<html><body>nope</body></html>"), {});
	assert.deepEqual(parsePrices(""), {});
});

test("records without a price are skipped", () => {
	const html = rsc([
		payload(
			'{"id":"x"}',
			'{"id":"y","apiModelName":"Qwen/Qwen3-Embedding-8B","purpose":"embeddings"}',
		),
	]);
	assert.deepEqual(parsePrices(html), {});
});

test("first occurrence of an id wins", () => {
	const html = rsc([
		payload(
			record("a", "zai-org/GLM-5.3", "0.50", "2.00"),
			record("b", "zai-org/GLM-5.3", "9.99", "9.99"),
		),
	]);
	// The payload repeats records across views; the first is the canonical one.
	assert.equal(parsePrices(html)["zai-org/GLM-5.3"].input, 0.5);
});

test("priceFor falls back to case-insensitive matching", () => {
	const prices = { "Qwen/Qwen3.8-27B": { input: 0.1, output: 0.4, cacheRead: 0.04, cacheWrite: 0 } };

	assert.equal(priceFor(prices, "Qwen/Qwen3.8-27B")?.input, 0.1);
	assert.equal(priceFor(prices, "qwen/qwen3.8-27b")?.input, 0.1);
	assert.equal(priceFor(prices, "nope/missing"), undefined);
});

test("snapshot is internally consistent", () => {
	for (const [id, price] of Object.entries(SNAPSHOT_PRICES)) {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = price[field];
			assert.ok(
				typeof value === "number" && Number.isFinite(value) && value >= 0,
				`${id}.${field} must be a finite non-negative number, got ${value}`,
			);
		}
		// Cache reads bill below the uncached input rate; a violation means the
		// snapshot was mistyped.
		assert.ok(
			price.cacheRead <= price.input,
			`${id}: cacheRead (${price.cacheRead}) should not exceed input (${price.input})`,
		);
	}
});

test("UNKNOWN_PRICE is all zeros", () => {
	assert.deepEqual(UNKNOWN_PRICE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

/* ------------------------------------------------------------------ *
 * Prices published by /v1/models itself: when present, scraping is unused.
 * ------------------------------------------------------------------ */

test("pricesFromModelList reads pi's own cost shape", () => {
	const data = [
		{
			id: "deepseek-ai/DeepSeek-V4.1-Flash",
			cost: { input: 0.2, output: 0.6, cacheRead: 0.005, cacheWrite: 0 },
		},
	];

	assert.deepEqual(pricesFromModelList(data)["deepseek-ai/DeepSeek-V4.1-Flash"], {
		input: 0.2,
		output: 0.6,
		cacheRead: 0.005,
		cacheWrite: 0,
	});
});

test("pricesFromModelList reads OpenRouter-style pricing with string rates", () => {
	const data = [{ id: "zai-org/GLM-5.3", pricing: { input: "0.50", output: "2.00", cache_read: "0.15" } }];

	assert.deepEqual(pricesFromModelList(data)["zai-org/GLM-5.3"], {
		input: 0.5,
		output: 2,
		cacheRead: 0.15,
		cacheWrite: 0,
	});
});

test("pricesFromModelList reads flat scalar prices", () => {
	const data = [{ id: "Qwen/Qwen3.8-27B", input_price: "0.10", output_price: "0.40" }];

	const price = pricesFromModelList(data)["Qwen/Qwen3.8-27B"];
	assert.equal(price.input, 0.1);
	assert.equal(price.output, 0.4);
	assert.equal(price.cacheRead, 0);
});

test("today's Entrim response yields no API prices, so scraping still runs", () => {
	// The real /v1/models payload: no price key of any kind.
	const data = [
		{
			id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
			object: "model",
			created: 1677610602,
			owned_by: "openai",
			datacenters: [{ country_code: "SI" }],
			beta: false,
			max_input_tokens: 1048576,
			max_output_tokens: 393216,
		},
	];

	assert.deepEqual(pricesFromModelList(data), {});
});

test("a half-specified price is ignored rather than half-applied", () => {
	// input without output is not a usable price; treating it as one would
	// understate spend, which is the exact failure mode being fixed.
	assert.deepEqual(pricesFromModelList([{ id: "x", cost: { input: 0.5 } }]), {});
	assert.deepEqual(pricesFromModelList([{ id: "x", cost: { output: 0.5 } }]), {});
});

test("negative and non-finite rates are rejected", () => {
	assert.deepEqual(pricesFromModelList([{ id: "x", cost: { input: -1, output: 2 } }]), {});
	assert.deepEqual(
		pricesFromModelList([{ id: "x", cost: { input: Number.NaN, output: 2 } }]),
		{},
	);
	assert.deepEqual(pricesFromModelList([{ id: "x", cost: { input: "abc", output: 2 } }]), {});
});

test("entries without a usable id are skipped", () => {
	assert.deepEqual(pricesFromModelList([{ cost: { input: 1, output: 2 } }]), {});
	assert.deepEqual(pricesFromModelList([{ id: "", cost: { input: 1, output: 2 } }]), {});
	assert.deepEqual(pricesFromModelList(null), {});
	assert.deepEqual(pricesFromModelList(undefined), {});
});

test("one priced entry among unpriced ones is still used", () => {
	const data = [
		{ id: "a-free", max_input_tokens: 1000 },
		{ id: "b-priced", cost: { input: 0.1, output: 0.4 } },
	];

	const prices = pricesFromModelList(data);
	assert.deepEqual(Object.keys(prices), ["b-priced"]);
});
