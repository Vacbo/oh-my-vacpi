import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	runSessionsCommand,
	type SessionsAction,
	type SessionsCommandArgs,
	SessionsCommandError,
} from "../cli/sessions-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: SessionsAction[] = ["list", "inspect", "watch", "serve", "cleanup"];

export default class Sessions extends Command {
	static description = "Inspect live OMP sessions";

	static args = {
		action: Args.string({
			description: "Sessions action",
			required: false,
			options: ACTIONS,
		}),
		runId: Args.string({
			description: "Live session run id",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		running: Flags.boolean({ description: "Only show running sessions" }),
		"agent-dir": Flags.string({ description: "Agent config directory (default: ~/.omp/agent)" }),
		limit: Flags.integer({ description: "Maximum events to print for watch" }),
		port: Flags.integer({ description: "Browser mirror port (0 chooses a free port)", default: 0 }),
	};

	static examples = [
		"# List live sessions\n  omp sessions list",
		"# Inspect a run and its terminal snapshot\n  omp sessions inspect <run-id>",
		"# Watch session events as JSONL\n  omp sessions watch <run-id> --json",
		"# Serve the read-only browser mirror\n  omp sessions serve --port 3848",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sessions);
		if (!args.action) {
			renderCommandHelp("omp", "sessions", Sessions);
			return;
		}

		const cmd: SessionsCommandArgs = {
			action: args.action as SessionsAction,
			runId: args.runId,
			flags: {
				json: flags.json,
				running: flags.running,
				agentDir: flags["agent-dir"],
				limit: flags.limit,
				port: flags.port,
			},
		};

		await initTheme();
		try {
			await runSessionsCommand(cmd);
		} catch (error) {
			if (error instanceof SessionsCommandError) {
				process.stderr.write(`${error.message}\n`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
	}
}
