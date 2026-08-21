import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestUpstreamRelease } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const REGISTRY_PREFIX = "https://registry.npmjs.org/";

/**
 * Stub the npm registry and record every URL the lookup hits. The requested
 * package is taken from the URL exactly (no substring matching, so a rename
 * chain has to ask for the precise name), and anything unlisted answers 404 —
 * an unexpected request fails the lookup instead of silently resolving.
 */
function stubRegistry(manifests: Record<string, unknown>): string[] {
	const urls: string[] = [];
	const fetchStub = Object.assign(
		async (input: FetchInput) => {
			const url = String(input);
			urls.push(url);
			const pkg = url.startsWith(REGISTRY_PREFIX)
				? decodeURIComponent(url.slice(REGISTRY_PREFIX.length).replace(/\/latest$/, ""))
				: undefined;
			const manifest = pkg === undefined ? undefined : manifests[pkg];
			if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
			return Response.json(manifest);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	return urls;
}

describe("getLatestUpstreamRelease", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads the upstream version under a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		expect(await getLatestUpstreamRelease({ timeoutMs: 1_000 })).toBe("999.0.0");
		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});

	it("follows an omp.rename pointer and reports the renamed package's version", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0" },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		expect(await getLatestUpstreamRelease()).toBe("999.1.0");
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		expect(await getLatestUpstreamRelease()).toBe("999.0.0");
		expect(urls).toHaveLength(1);
	});

	it("ignores a rename pointer that is not a plain npm package name", async () => {
		// A pointer carrying a path or origin must never steer the registry request:
		// the fork resolves upstream metadata only, and there is no install path to feed.
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "../../evil?x=https://attacker.test/" } },
			},
		});

		expect(await getLatestUpstreamRelease()).toBe("999.0.0");
		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest"]);
	});

	it("rejects a manifest without a usable version instead of reporting a bogus merge target", async () => {
		stubRegistry({ "@oh-my-pi/pi-coding-agent": { version: "latest" } });

		await expect(getLatestUpstreamRelease()).rejects.toThrow(/no usable version/);
	});
});

describe("getLatestUpstreamRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestUpstreamRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
