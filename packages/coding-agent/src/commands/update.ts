/**
 * Start a fork update agent session.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = "Start a new session to merge the latest upstream tag";

	static flags = {
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

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
