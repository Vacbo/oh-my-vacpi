import { afterEach, describe, expect, it, vi } from "bun:test";
import * as client from "../src/mcp/client";
import { MCPTransportError } from "../src/mcp/errors";
import { classifyConnectError, MCPManager } from "../src/mcp/manager";
import type { MCPServerConfig, MCPServerConnection, MCPToolDefinition, MCPTransport } from "../src/mcp/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DeferredHandle<T> = ReturnType<typeof Promise.withResolvers<T>>;

/**
 * Build a synthetic MCPServerConnection whose transport just records hook
 * assignments. The manager only ever calls `transport.close()` and assigns to
 * `transport.onClose` after a successful connect, so a stub is enough.
 */
function makeConnection(name: string, config: MCPServerConfig): MCPServerConnection {
	let closed = false;
	const transport: MCPTransport = {
		get connected() {
			return !closed;
		},
		async request() {
			throw new Error("not implemented in test");
		},
		async notify() {},
		async close() {
			closed = true;
		},
	};
	return {
		name,
		config,
		transport,
		serverInfo: { name, version: "0.0.0" },
		capabilities: { tools: {} },
	};
}

function stdioConfig(extra?: Partial<MCPServerConfig>): MCPServerConfig {
	return { type: "stdio", command: "echo", ...extra } as MCPServerConfig;
}

/**
 * The exact error `StdioTransport`'s read loop rejects pending requests with
 * when the subprocess dies before answering `initialize` (see `#startReadLoop`):
 * a typed transport failure carrying the reaped exit code, or the stdout-EOF
 * variant for when the process has not been reaped yet.
 */
function subprocessDeathError(exitCode?: number): MCPTransportError {
	return new MCPTransportError({
		transport: "stdio",
		stage: "receive",
		failure: "eof",
		message:
			exitCode === undefined
				? "MCP subprocess closed stdout before responding"
				: `MCP subprocess exited with code ${exitCode} before responding`,
		retryable: true,
		code: exitCode,
	});
}

const TOOL_DEF: MCPToolDefinition = {
	name: "do_stuff",
	description: "test tool",
	inputSchema: { type: "object" },
};

// ---------------------------------------------------------------------------
// Late-vs-sub-window split
// ---------------------------------------------------------------------------

describe("MCPManager.connectServers — startup behaviour", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("pending past startup window → no tools or errors; late SUCCESS delivers tools", async () => {
		const connectionDeferred: DeferredHandle<MCPServerConnection> = Promise.withResolvers();
		const connectSpy = vi.spyOn(client, "connectToServer").mockReturnValue(connectionDeferred.promise);
		const listSpy = vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		const toolsChangedSeen: number[] = [];
		manager.setOnToolsChanged(tools => {
			toolsChangedSeen.push(tools.length);
		});

		const result = await manager.connectServers({ slow: stdioConfig() }, {});

		// Mid-window observation: nothing exposed.
		expect(result.tools).toEqual([]);
		expect(result.errors.has("slow")).toBe(false);
		expect(manager.getTools()).toEqual([]);
		expect(manager.getConnectionStatus("slow")).toBe("connecting");

		// Resolve the handshake; the late tool list should land via setOnToolsChanged.
		connectionDeferred.resolve(makeConnection("slow", stdioConfig()));
		// Yield so the manager's chained `.then`s run (store connection → discover tools → publish).
		await Bun.sleep(10);

		expect(manager.getTools().length).toBe(1);
		expect(manager.getTools()[0].name).toBe("mcp__slow_do_stuff");
		expect(toolsChangedSeen.at(-1)).toBe(1);
		expect(manager.getLastConnectError("slow")).toBeUndefined();
		expect(manager.getConnectionStatus("slow")).toBe("connected");

		await manager.disconnectAll();
		expect(connectSpy).toHaveBeenCalledTimes(1);
		expect(listSpy).toHaveBeenCalledTimes(1);
	});

	it("late connect failure → result.errors empty, getLastConnectError populated, no tools", async () => {
		const deferred: DeferredHandle<MCPServerConnection> = Promise.withResolvers();
		vi.spyOn(client, "connectToServer").mockReturnValue(deferred.promise);
		vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		const toolsChangedSeen: number[] = [];
		manager.setOnToolsChanged(tools => {
			toolsChangedSeen.push(tools.length);
		});

		const result = await manager.connectServers({ slow: stdioConfig() }, {});

		// connectServers has already returned by the time the rejection settles.
		expect(result.errors.has("slow")).toBe(false);
		expect(manager.getTools()).toEqual([]);

		deferred.reject(subprocessDeathError(1));
		// Let the `.catch` fire.
		await deferred.promise.catch(() => {});
		await Bun.sleep(10);

		expect(manager.getTools()).toEqual([]);
		// setOnToolsChanged must never have fired with stale entries — there were
		// no tools to lose, but we still must not have synthesized any.
		expect(toolsChangedSeen).toEqual([]);

		const classified = manager.getLastConnectError("slow");
		expect(classified).toBeDefined();
		expect(classified?.kind).toBe("unreachable");
		expect(classified?.message).toMatch(/subprocess exited/);

		await manager.disconnectAll();
	});

	it("sub-window connect failure → result.errors set AND getLastConnectError set with same classification", async () => {
		vi.spyOn(client, "connectToServer").mockRejectedValue(subprocessDeathError(137));
		vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		const result = await manager.connectServers({ kaput: stdioConfig() }, {});

		expect(result.errors.get("kaput")).toMatch(/MCP subprocess exited with code 137 before responding/);
		const classified = manager.getLastConnectError("kaput");
		expect(classified).toBeDefined();
		expect(classified?.kind).toBe("unreachable");
		expect(classified?.message).toMatch(/subprocess exited/);

		await manager.disconnectAll();
	});

	it("connectTimeoutMs < 250ms aborts handshake within startup window", async () => {
		// Simulate what real connectToServer does on timeout — reject with the
		// canonical message including the bound. We don't drive withTimeout here
		// to keep the test deterministic (no real timers in the production path).
		vi.spyOn(client, "connectToServer").mockImplementation(async (name: string) => {
			await Bun.sleep(60);
			throw new Error(`Connection to MCP server "${name}" timed out after 50ms`);
		});

		const manager = new MCPManager(process.cwd());
		const result = await manager.connectServers({ hang: stdioConfig({ connectTimeoutMs: 50 }) }, {});

		expect(result.errors.get("hang")).toMatch(/timed out after 50ms/);
		expect(manager.getTools()).toEqual([]);
		expect(manager.getLastConnectError("hang")?.kind).toBe("timeout");
	});

	it("connectTimeoutMs bounds listTools on the initial path + atomically tears down the connection", async () => {
		// connect succeeds instantly, tools/list hangs forever.
		vi.spyOn(client, "connectToServer").mockImplementation(async (name: string, config: MCPServerConfig) =>
			makeConnection(name, config),
		);
		const hangForever: DeferredHandle<MCPToolDefinition[]> = Promise.withResolvers();
		vi.spyOn(client, "listTools").mockReturnValue(hangForever.promise);

		const manager = new MCPManager(process.cwd());
		await manager.connectServers({ stuck: stdioConfig({ connectTimeoutMs: 80 }) }, {});

		// Past startup window: the discovery's withTimeout fires and the
		// atomic-cleanup contract removes the connection.
		await Bun.sleep(120);
		expect(manager.getTools()).toEqual([]);
		expect(manager.getConnection("stuck")).toBeUndefined();

		const classified = manager.getLastConnectError("stuck");
		expect(classified?.kind).toBe("timeout");
		expect(classified?.raw).toMatch(/timed out after 80ms/);

		// Never resolve so we don't leak the pending promise to other tests.
		hangForever.resolve([]);
		await manager.disconnectAll();
	});

	it("connectTimeoutMs bounds listTools on the reconnect path; stale tools survive", async () => {
		// Phase 1 — successful initial connect.
		const stableConn = makeConnection("flaky", stdioConfig());
		const connectSpy = vi.spyOn(client, "connectToServer").mockResolvedValue(stableConn);
		const listSpy = vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		const result = await manager.connectServers({ flaky: stdioConfig({ connectTimeoutMs: 60 }) }, {});
		expect(result.connectedServers).toEqual(["flaky"]);
		expect(manager.getTools().length).toBe(1);

		// Phase 2 — reconnect: connect resolves, listTools hangs past
		// connectTimeoutMs. The reconnect loop retries 5 times with
		// backoff [500, 1000, 2000, 4000]ms, so total wall time is
		// 5 * 60ms + 7500ms ≈ 7.8s — bump the per-test timeout above
		// Bun's 5s default to absorb it.
		const reconnectConn = makeConnection("flaky", stdioConfig({ connectTimeoutMs: 60 }));
		connectSpy.mockResolvedValue(reconnectConn);
		const hangForever: DeferredHandle<MCPToolDefinition[]> = Promise.withResolvers();
		listSpy.mockReturnValue(hangForever.promise);

		const recon = await manager.reconnectServer("flaky");
		expect(recon).toBeNull();
		expect(manager.getTools().length).toBe(1); // stale tools preserved
		expect(manager.getLastConnectError("flaky")?.kind).toBe("timeout");

		hangForever.resolve([]);
		await manager.disconnectAll();
	}, 15_000);

	it("#lastConnectErrors cleared on successful reconnect", async () => {
		// Initial connect fails.
		const connectSpy = vi
			.spyOn(client, "connectToServer")
			.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:5555"));
		vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		await manager.connectServers({ wobbly: stdioConfig() }, {});
		expect(manager.getLastConnectError("wobbly")?.kind).toBe("unreachable");

		// Repair the transport: subsequent connect succeeds.
		connectSpy.mockImplementation(async (name: string, config: MCPServerConfig) => makeConnection(name, config));
		await manager.reconnectServer("wobbly");

		expect(manager.getLastConnectError("wobbly")).toBeUndefined();
		await manager.disconnectAll();
	});

	it("connectTimeoutMs: 0 disables the discovery bound on the initial path", async () => {
		// `0` means "no client-side bound" everywhere else in the MCP surface, so
		// discovery must wait indefinitely rather than treat the bound as expired.
		vi.spyOn(client, "connectToServer").mockImplementation(async (name: string, config: MCPServerConfig) =>
			makeConnection(name, config),
		);
		const pending: DeferredHandle<MCPToolDefinition[]> = Promise.withResolvers();
		vi.spyOn(client, "listTools").mockReturnValue(pending.promise);

		const manager = new MCPManager(process.cwd());
		const toolsPublished: DeferredHandle<number> = Promise.withResolvers();
		manager.setOnToolsChanged(tools => toolsPublished.resolve(tools.length));

		// `connectServers` returns only after its own startup race elapses, so a
		// bound misread as "already expired" would have rejected and torn the
		// connection down before this line — no extra waiting needed.
		await manager.connectServers({ patient: stdioConfig({ connectTimeoutMs: 0 }) }, {});
		expect(manager.getConnection("patient")).toBeDefined();
		expect(manager.getLastConnectError("patient")).toBeUndefined();

		pending.resolve([TOOL_DEF]);

		// Await the manager's own publish signal rather than a guessed delay.
		expect(await toolsPublished.promise).toBe(1);
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__patient_do_stuff"]);
		expect(manager.getLastConnectError("patient")).toBeUndefined();
		await manager.disconnectAll();
	});

	it("connectTimeoutMs: 0 disables the discovery bound on the reconnect path", async () => {
		const config = stdioConfig({ connectTimeoutMs: 0 });
		vi.spyOn(client, "connectToServer").mockImplementation(async (name: string, cfg: MCPServerConfig) =>
			makeConnection(name, cfg),
		);
		const listSpy = vi.spyOn(client, "listTools").mockResolvedValue([TOOL_DEF]);

		const manager = new MCPManager(process.cwd());
		expect((await manager.connectServers({ patient: config }, {})).connectedServers).toEqual(["patient"]);

		// Reconnect while tools/list is still outstanding. `Bun.sleep(0)` yields a
		// single macrotask — enough for a zero-length bound's timer to fire if the
		// disable were misread — without tying the test to wall-clock duration.
		const pending: DeferredHandle<MCPToolDefinition[]> = Promise.withResolvers();
		listSpy.mockReturnValue(pending.promise);
		const reconnected = manager.reconnectServer("patient");
		await Bun.sleep(0);
		pending.resolve([TOOL_DEF]);

		expect(await reconnected).not.toBeNull();
		expect(manager.getTools().length).toBe(1);
		expect(manager.getLastConnectError("patient")).toBeUndefined();
		await manager.disconnectAll();
	});
});

// ---------------------------------------------------------------------------
// classifyConnectError — pure
// ---------------------------------------------------------------------------

describe("classifyConnectError", () => {
	it("maps ENOENT → unreachable: command not found", () => {
		const node = Object.assign(new Error("spawn echo ENOENT"), { code: "ENOENT" });
		expect(classifyConnectError(node, "x")).toMatchObject({
			kind: "unreachable",
			message: expect.stringMatching(/command not found/),
		});
		expect(classifyConnectError(new Error("bogus ENOENT bogus"), "x").kind).toBe("unreachable");
	});

	it("maps Node ECONNREFUSED → unreachable", () => {
		const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9999"), { code: "ECONNREFUSED" });
		expect(classifyConnectError(err, "x").kind).toBe("unreachable");
	});

	it("maps Bun fetch ConnectionRefused → unreachable", () => {
		const err = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
			code: "ConnectionRefused",
		});
		expect(classifyConnectError(err, "x").kind).toBe("unreachable");
	});

	it("maps EAI_NONAME / ENOTFOUND → unreachable", () => {
		const eai = Object.assign(new Error("getaddrinfo EAI_NONAME nope"), { code: "EAI_NONAME" });
		const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND nope"), { code: "ENOTFOUND" });
		expect(classifyConnectError(eai, "x").kind).toBe("unreachable");
		expect(classifyConnectError(notFound, "x").kind).toBe("unreachable");
	});

	it("maps stdio subprocess death with an exit code → unreachable and surfaces the exit code", () => {
		const out = classifyConnectError(subprocessDeathError(137), "x");
		expect(out.kind).toBe("unreachable");
		expect(out.message).toMatch(/subprocess exited/);
		expect(out.message).toContain("exit code 137");
	});

	it("maps stdio subprocess death with a negative exit code → unreachable and surfaces the code", () => {
		const out = classifyConnectError(subprocessDeathError(-1), "x");
		expect(out.kind).toBe("unreachable");
		expect(out.message).toContain("exit code -1");
	});

	it("maps stdout EOF before the exit code is reaped → unreachable without an exit code", () => {
		const out = classifyConnectError(subprocessDeathError(), "x");
		expect(out.kind).toBe("unreachable");
		expect(out.message).toBe("x: subprocess closed stdout before responding to initialize");
		expect(out.message).not.toMatch(/exit code/);
	});

	it("keeps generic transport closure generic (not a subprocess death)", () => {
		// Still emitted untyped by the legacy SSE transport, and typed by
		// `StdioTransport.close()` — a deliberate local teardown, not a death.
		const plain = classifyConnectError(new Error("Transport closed"), "x");
		expect(plain.kind).toBe("other");
		expect(plain.message).toBe("x: Transport closed");
		expect(plain.message).not.toMatch(/subprocess exited/);

		const typed = classifyConnectError(
			new MCPTransportError({
				transport: "stdio",
				stage: "receive",
				failure: "closed",
				message: "Transport closed",
				retryable: true,
			}),
			"x",
		);
		expect(typed.kind).toBe("other");
		expect(typed.message).toBe("x: Transport closed");
	});

	it("keeps legacy SSE transport closure generic (not a subprocess exit)", () => {
		const sse = classifyConnectError(new Error("Transport closed: legacy SSE stream closed"), "x");
		expect(sse.kind).toBe("other");
		expect(sse.message).not.toMatch(/subprocess exited/);
	});

	it("maps outer connect timeout → timeout", () => {
		const err = new Error('Connection to MCP server "x" timed out after 50ms');
		expect(classifyConnectError(err, "x").kind).toBe("timeout");
	});

	it("maps inner request/SSE timeouts → timeout", () => {
		expect(classifyConnectError(new Error("Request timeout after 30000ms"), "x").kind).toBe("timeout");
		expect(classifyConnectError(new Error("SSE response timeout after 30000ms"), "x").kind).toBe("timeout");
	});

	it("maps MCP error → protocol", () => {
		expect(classifyConnectError(new Error("MCP error -32601: Method not found"), "x").kind).toBe("protocol");
	});

	it("falls through to other for unknown messages", () => {
		const out = classifyConnectError(new Error("kaboom"), "x");
		expect(out.kind).toBe("other");
		expect(out.raw).toBe("kaboom");
		expect(out.message).toBe("x: kaboom");
	});
});

// ---------------------------------------------------------------------------
// launchApp failure integration with getLastConnectError
// ---------------------------------------------------------------------------

describe("launchApp failure surfaces via getLastConnectError", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies launchApp failure as unreachable", async () => {
		vi.spyOn(client, "connectToServer").mockRejectedValue(
			new Error("launchApp: 'open -gja Bogus' failed with exit 1"),
		);

		const manager = new MCPManager(process.cwd());
		const result = await manager.connectServers(
			{
				ghost: stdioConfig({ launchApp: "Bogus" }),
			},
			{},
		);

		expect(result.errors.has("ghost")).toBe(true);
		const classified = manager.getLastConnectError("ghost");
		expect(classified?.kind).toBe("unreachable");
		expect(classified?.raw).toMatch(/launchApp:/);
	});
});
