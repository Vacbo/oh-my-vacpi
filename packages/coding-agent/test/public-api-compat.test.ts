import { describe, expect, test } from "bun:test";

describe("public API compatibility", () => {
	test("exports legacy tool factories used by extensions", async () => {
		const api = await import("../src/index");

		expect(typeof api.createReadTool).toBe("function");
		expect(typeof api.createBashTool).toBe("function");
		expect(typeof api.createEditTool).toBe("function");
		expect(typeof api.createWriteTool).toBe("function");
		expect(typeof api.createGrepTool).toBe("function");
		expect(typeof api.createFindTool).toBe("function");
		expect(typeof api.createLsTool).toBe("function");
		expect(typeof api.DefaultResourceLoader).toBe("function");
		expect(typeof api.formatSize).toBe("function");
		expect(typeof api.truncateHead).toBe("function");
	});
});
