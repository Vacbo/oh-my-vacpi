import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Asciicast,
	AsciicastRecorder,
	parseAsciicast,
	renderAsciicastFrame,
	sampleAsciicastFrames,
	summarizeAsciicast,
} from "@oh-my-pi/pi-coding-agent/session/asciicast";

describe("asciicast", () => {
	let dir = "";

	afterEach(async () => {
		if (!dir) return;
		await fs.rm(dir, { recursive: true, force: true });
		dir = "";
	});

	it("records a valid asciicast v2 header and a single output event", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-asciicast-"));
		const castPath = path.join(dir, "rec.cast");

		const recorder = new AsciicastRecorder({ path: castPath, cols: 80, rows: 24, command: "bun test" });
		recorder.write("hello");
		await recorder.finalize();

		const cast = parseAsciicast(await Bun.file(castPath).text());
		expect(cast.header.version).toBe(2);
		expect(cast.header.width).toBe(80);
		expect(cast.header.height).toBe(24);
		expect(cast.header.command).toBe("bun test");

		const outputs = cast.events.filter(event => event.code === "o");
		expect(outputs).toHaveLength(1);
		expect(outputs[0]!.data).toBe("hello");
	});

	it("records ascending non-negative event times and preserves output bytes across a round-trip", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-asciicast-"));
		const castPath = path.join(dir, "rec.cast");

		// startMs, then write("foo") at +0s, write("bar") at +0.5s.
		const stamps = [1000, 1000, 1500, 1900];
		let cursor = 0;
		const now = () => stamps[Math.min(cursor++, stamps.length - 1)]!;

		const recorder = new AsciicastRecorder({ path: castPath, cols: 40, rows: 10, now });
		recorder.write("foo");
		recorder.write("bar");
		await recorder.finalize();

		const cast = parseAsciicast(await Bun.file(castPath).text());
		const outputs = cast.events.filter(event => event.code === "o");
		expect(outputs).toHaveLength(2);
		expect(outputs[0]!.time).toBeLessThanOrEqual(outputs[1]!.time);
		expect(outputs[0]!.time).toBeGreaterThanOrEqual(0);
		expect(outputs[1]!.time).toBeGreaterThanOrEqual(0);
		expect(outputs.map(event => event.data).join("")).toBe("foobar");
	});

	it("reconstructs the grid at distinct times via renderAsciicastFrame", async () => {
		const cast: Asciicast = {
			header: { version: 2, width: 20, height: 6 },
			events: [
				{ time: 0, code: "o", data: "AAAA" },
				{ time: 1, code: "o", data: "\r\nBBBB" },
			],
		};

		const early = (await renderAsciicastFrame(cast, 0.5)).trimEnd();
		expect(early).toContain("AAAA");
		expect(early).not.toContain("BBBB");

		const late = (await renderAsciicastFrame(cast, 2)).trimEnd();
		expect(late).toContain("AAAA");
		expect(late).toContain("BBBB");
	});

	it("summarizes event count, duration, and output bytes excluding non-output events", () => {
		// "hi" is 2 utf8 bytes; "✓" is 3 utf8 bytes but 1 char, so byte-vs-char counting differs.
		const cast: Asciicast = {
			header: { version: 2, width: 10, height: 4 },
			events: [
				{ time: 0, code: "o", data: "hi" },
				{ time: 0.5, code: "r", data: "30x10" },
				{ time: 2, code: "o", data: "✓" },
			],
		};

		const summary = summarizeAsciicast(cast);
		expect(summary.width).toBe(10);
		expect(summary.height).toBe(4);
		expect(summary.eventCount).toBe(3);
		expect(summary.outputBytes).toBe(5);
		expect(summary.durationSeconds).toBe(2);
	});

	it("samples evenly spaced frames ending at the cast duration", async () => {
		const cast: Asciicast = {
			header: { version: 2, width: 20, height: 6 },
			events: [
				{ time: 0, code: "o", data: "AAAA" },
				{ time: 1, code: "o", data: "\r\nBBBB" },
				{ time: 2, code: "o", data: "\r\nCCCC" },
			],
		};
		const duration = summarizeAsciicast(cast).durationSeconds;

		const frames = await sampleAsciicastFrames(cast, 3);
		expect(frames).toHaveLength(3);
		expect(frames[0]!.atSeconds).toBeLessThan(frames[1]!.atSeconds);
		expect(frames[1]!.atSeconds).toBeLessThan(frames[2]!.atSeconds);
		expect(frames[2]!.atSeconds).toBeCloseTo(duration, 6);
		expect(frames[2]!.text).toBe(await renderAsciicastFrame(cast, duration));
	});
});
