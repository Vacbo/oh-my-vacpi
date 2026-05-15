import { describe, expect, it } from "bun:test";
import { buildRemoteCommand, supportsSshControlMaster } from "../../src/ssh/connection-manager";
import { isMountedByDeviceBoundary } from "../../src/ssh/sshfs-mount";

describe("buildRemoteCommand", () => {
	it("includes -n and OpenSSH ControlMaster options on Unix-like platforms", async () => {
		const args = await buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "linux" },
		);

		expect(args[0]).toBe("-n");
		expect(args).toContain("ControlMaster=auto");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("omits OpenSSH ControlMaster options on Windows", async () => {
		const args = await buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
			{ platform: "win32" },
		);

		expect(args[0]).toBe("-n");
		expect(args).not.toContain("ControlMaster=auto");
		expect(args.some(arg => arg.startsWith("ControlPath="))).toBe(false);
		expect(args).not.toContain("ControlPersist=3600");
		expect(args).toContain("BatchMode=yes");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});
});

describe("supportsSshControlMaster", () => {
	it("disables OpenSSH connection multiplexing on native Windows", () => {
		expect(supportsSshControlMaster("win32")).toBe(false);
	});

	it("keeps OpenSSH connection multiplexing on Unix-like platforms", () => {
		expect(supportsSshControlMaster("linux")).toBe(true);
		expect(supportsSshControlMaster("darwin")).toBe(true);
	});
});

describe("isMountedByDeviceBoundary", () => {
	it("detects a mount when the path is on a different device than its parent", async () => {
		const mountPath = "/Users/example/.omp/remote/spark";
		const mounted = await isMountedByDeviceBoundary(mountPath, async currentPath => ({
			dev: currentPath === mountPath ? 2 : 1,
		}));

		expect(mounted).toBe(true);
	});

	it("treats same-device paths as regular directories", async () => {
		const mounted = await isMountedByDeviceBoundary("/Users/example/.omp/remote/spark", async () => ({ dev: 1 }));

		expect(mounted).toBe(false);
	});

	it("treats stat failures as not mounted", async () => {
		const mounted = await isMountedByDeviceBoundary("/missing", async () => {
			throw new Error("missing");
		});

		expect(mounted).toBe(false);
	});
});
