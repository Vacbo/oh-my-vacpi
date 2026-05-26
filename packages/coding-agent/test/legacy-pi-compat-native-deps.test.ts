import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadLegacyPiModule } from "../src/extensibility/plugins/legacy-pi-compat";

describe("legacy Pi plugin native dependency resolution", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("preserves package layout so transitive createRequire native package lookup succeeds", async () => {
		tempDir = TempDir.createSync("@pi-legacy-native-deps-");
		const root = tempDir.path();
		const pluginDir = path.join(root, "node_modules", "@example", "plugin");
		const wrapperDir = path.join(root, "node_modules", "@example", "native-wrapper");
		const binaryDir = path.join(root, "node_modules", "@example", "native-bin");
		const nativeFile = path.join(binaryDir, "libexample.dylib");

		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "@example/plugin", type: "module" }),
		);
		await Bun.write(
			path.join(pluginDir, "src", "index.ts"),
			[
				'import { binaryPath, packageDir } from "@example/native-wrapper";',
				"export const resolvedBinaryPath = binaryPath;",
				"export const resolvedPackageDir = packageDir;",
				"export const binaryExists = globalThis.__existsSync(binaryPath);",
			].join("\n"),
		);
		await Bun.write(
			path.join(wrapperDir, "package.json"),
			JSON.stringify({ name: "@example/native-wrapper", type: "module", main: "dist/index.js" }),
		);
		await Bun.write(
			path.join(wrapperDir, "dist", "index.js"),
			'export { binaryPath, packageDir } from "./binary.js";\n',
		);
		await Bun.write(
			path.join(wrapperDir, "dist", "binary.js"),
			[
				'import { existsSync, readFileSync } from "node:fs";',
				'import { createRequire } from "node:module";',
				'import { dirname, join } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				"function getCurrentDir() { return dirname(fileURLToPath(import.meta.url)); }",
				"function getPackageDir() {",
				"  let dir = getCurrentDir();",
				"  for (let i = 0; i < 5; i++) {",
				'    const packageJsonPath = join(dir, "package.json");',
				"    if (existsSync(packageJsonPath)) {",
				'      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));',
				'      if (pkg.name === "@example/native-wrapper") return dir;',
				"    }",
				"    dir = dirname(dir);",
				"  }",
				"  return dirname(getCurrentDir());",
				"}",
				"export const packageDir = getPackageDir();",
				'const require = createRequire(join(packageDir, "package.json"));',
				'const binaryPackageJson = require.resolve("@example/native-bin/package.json");',
				'export const binaryPath = join(dirname(binaryPackageJson), "libexample.dylib");',
			].join("\n"),
		);
		await Bun.write(
			path.join(binaryDir, "package.json"),
			JSON.stringify({ name: "@example/native-bin", type: "module" }),
		);
		await Bun.write(nativeFile, "native fixture");

		const globals = globalThis as typeof globalThis & { __existsSync?: typeof existsSync };
		globals.__existsSync = existsSync;
		try {
			const loaded = (await loadLegacyPiModule(path.join(pluginDir, "src", "index.ts"))) as {
				binaryExists: boolean;
				resolvedBinaryPath: string;
				resolvedPackageDir: string;
			};

			expect(loaded.binaryExists).toBe(true);
			expect(loaded.resolvedBinaryPath).toEndWith(
				path.join("node_modules", "@example", "native-bin", "libexample.dylib"),
			);
			expect(loaded.resolvedPackageDir).toContain(path.join("node_modules", "@example", "native-wrapper"));
		} finally {
			delete globals.__existsSync;
		}
	});
});
