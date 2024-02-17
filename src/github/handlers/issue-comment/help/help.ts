import { GitHubContext } from "../../../github-context";
import { UbiquiBotConfig } from "../../../ubiquibot-config";
import { userCommands } from "../created";

export async function generateHelpMenu(context: GitHubContext<"issue_comment.created">, configuration: UbiquiBotConfig) {
  const disabledCommands = configuration.disabledCommands;
  const isStartDisabled = configuration.disabledCommands.some((command) => command === "start");
  let helpMenu = "### Available Commands\n\n| Command | Description | Example |\n| --- | --- | --- |\n";
  // const commands = userCommands(configuration.miscellaneous.registerWalletWithVerification);

  userCommands
    .filter((command) => !disabledCommands.includes(command.id))
    .map(
      (command) =>
        (helpMenu += `| \`${command.id}\` | ${breakSentences(command.description) || ""} | ${(command.example && breakLongString(command.example)) || ""} |\n`) // add to help menu
    );

  if (isStartDisabled) {
    helpMenu += "\n\n**To assign yourself to an issue, please open a draft pull request that is linked to it.**";
  }
  return helpMenu;
}

function breakLongString(str: string, maxLen = 24) {
  const newStr = [] as string[];
  let spaceIndex = str.indexOf(" ", maxLen); // Find the first space after maxLen

  while (str.length > maxLen && spaceIndex !== -1) {
    newStr.push(str.slice(0, spaceIndex));
    str = str.slice(spaceIndex + 1);
    spaceIndex = str.indexOf(" ", maxLen);
  }

  newStr.push(str); // Push the remaining part of the string

  return newStr.join("<br>");
}

function breakSentences(str: string) {
  const sentences = str.endsWith(".") ? str.slice(0, -1).split(". ") : str.split(". ");
  if (sentences.length <= 1) {
    return str;
  }
  return sentences.join(".<br><br>");
}
