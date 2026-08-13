/**
 * Start a fork update agent session.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = [
		"omp update",
		"omp update -l",
		"# Point the merge session at a non-default fork checkout\n  OMP_VACPI_REPO_DIR=/srv/forks/vacpi omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		if (flags.plugins) {
			await initTheme();
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
			return;
		}
		await updateCli.runUpdateCommand();
	}
}
