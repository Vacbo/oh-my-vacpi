/**
 * Start a fork update agent session.
 */
import { Command } from "@oh-my-pi/pi-utils/cli";
import { runUpdateCommand } from "../cli/update-cli";

export default class Update extends Command {
	static description = "Start a new session to merge the latest upstream tag";

	async run(): Promise<void> {
		await this.parse(Update);
		await runUpdateCommand();
	}
}
