import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("fresh session launch flag", () => {
	it("parses --new without implying continue or resume", () => {
		const parsed = parseArgs(["--new", "merge upstream"]);

		expect(parsed.newSession).toBe(true);
		expect(parsed.continue).toBeUndefined();
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual(["merge upstream"]);
	});
});
