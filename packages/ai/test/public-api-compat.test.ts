import { describe, expect, test } from "bun:test";

describe("public API compatibility", () => {
	test("exports Type for legacy extensions", async () => {
		const api = await import("../src/index");

		expect(api.Type).toBeDefined();
		expect(typeof api.Type.Object).toBe("function");
		expect(typeof api.Type.String).toBe("function");
	});
});
