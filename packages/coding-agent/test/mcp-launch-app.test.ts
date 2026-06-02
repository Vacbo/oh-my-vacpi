import { afterEach, describe, expect, it, vi } from "bun:test";
import { ensureMacAppRunning } from "../src/mcp/transports/stdio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeSubprocess {
	exited: Promise<number>;
	stderr: ReadableStream<Uint8Array>;
}

function fakeProcess(exitCode: number, stderr = ""): FakeSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				if (stderr) controller.enqueue(new TextEncoder().encode(stderr));
				controller.close();
			},
		}),
	};
}

/**
 * `ensureMacAppRunning` guards against non-darwin platforms before doing any
 * work, so per-test mutation of `process.platform` is the simplest seam. We
 * scope it via try/finally to keep test isolation intact (file-wide mutation
 * is banned by AGENTS.md).
 */
function withPlatform<T>(value: NodeJS.Platform, body: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform") ?? {
		configurable: true,
		writable: true,
		value: process.platform,
	};
	Object.defineProperty(process, "platform", { value, configurable: true });
	try {
		return body();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureMacAppRunning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("string shorthand spawns `open -gja <name>` (background)", async () => {
		const spawnSpy = vi
			.spyOn(Bun, "spawn")
			.mockImplementation(() => fakeProcess(0) as unknown as ReturnType<typeof Bun.spawn>);

		await withPlatform("darwin", () => ensureMacAppRunning("Repo Prompt"));

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const call = spawnSpy.mock.calls[0]?.[0] as { cmd?: string[] };
		expect(call.cmd).toEqual(["open", "-gja", "Repo Prompt"]);
	});

	it("object with foreground: true spawns `open -a <path>` (activates)", async () => {
		const spawnSpy = vi
			.spyOn(Bun, "spawn")
			.mockImplementation(() => fakeProcess(0) as unknown as ReturnType<typeof Bun.spawn>);

		await withPlatform("darwin", () =>
			ensureMacAppRunning({ path: "/Applications/Repo Prompt.app", foreground: true }),
		);

		const call = spawnSpy.mock.calls[0]?.[0] as { cmd?: string[] };
		expect(call.cmd).toEqual(["open", "-a", "/Applications/Repo Prompt.app"]);
	});

	it("object with foreground: false spawns `open -gja <path>` (background)", async () => {
		const spawnSpy = vi
			.spyOn(Bun, "spawn")
			.mockImplementation(() => fakeProcess(0) as unknown as ReturnType<typeof Bun.spawn>);

		await withPlatform("darwin", () =>
			ensureMacAppRunning({ path: "/Applications/Repo Prompt.app", foreground: false }),
		);

		const call = spawnSpy.mock.calls[0]?.[0] as { cmd?: string[] };
		expect(call.cmd).toEqual(["open", "-gja", "/Applications/Repo Prompt.app"]);
	});

	it("non-zero exit throws with the app path in the message", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(
			() => fakeProcess(1, "kLSApplicationNotFoundErr") as unknown as ReturnType<typeof Bun.spawn>,
		);

		await expect(withPlatform("darwin", () => ensureMacAppRunning("Bogus App"))).rejects.toThrow(
			/'open -gja Bogus App' failed with exit 1.*kLSApplicationNotFoundErr/s,
		);
	});

	it("non-darwin platform throws immediately without spawning", async () => {
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(withPlatform("linux", () => ensureMacAppRunning("Whatever"))).rejects.toThrow(
			/launchApp is macOS-only \(current platform: linux\)/,
		);
		expect(spawnSpy).not.toHaveBeenCalled();
	});
});
