import { GitHubContext } from "../../github-context";
import { Plugin, getUbiquiBotConfig } from "../../ubiquibot-config";

const ACCEPT_TYPE = "application/vnd.github.v3+json";

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
}

interface WorkflowRuns {
  workflow_runs: WorkflowRun[];
}

export const userCommands: Plugin[] = [
  { name: "Help Menu", command: "/help", description: "List all available commands.", example: "/help", uses: [], with: [] },
];

/**
 *  fetch the ubiquibot-config.yml from the current repository, from the current organization, then merge (priority being the current repository.)
 *  ubiquibot-config.yml is always meant to live at .github/ubiquibot-config.yml
 * 
 * I'm unsure of the vision for how the bot is going to be able to run each of the plugins exactly
 * but I'm assuming it's going to be a repository_dispatch event that triggers the action
 * in the ubiquity hosted repository of plugins with a custom type for each to trigger the right action
 * 
 * From what I've read I don't see how the bot can run actions in other repositories
 * without launching it's own runner in the repository to handle the action
 * Simply trying to run the script belonging to the action won't work as pkgs are not installed
 * 
 * So is the kernel going to be firing off a dispatch to each plugin and then the plugin runs the action?
 * If so then there's no need to poll the run, the plugin can just post the comment, if waiting is needed 
 * then that repo's action run logs will be swamped so establishing a good structure for filtering is needed
 * 
 * I'm assuming also that the plugin will be the end of the line, meaning it will post the comment.
 * 
 * So the kernel fires off a dispatch for research-command, my ask repo catches the dispatch and runs the workflow
 * which then calls the action to run the plugin, then the workflows final step is to post the comment.
 * The kernel could move on immediately after the dispatch is fired. Meaning output just relies on runner assignment
 * and script exec time.
 * 
  
  issues_comment.created:
    - name: "New contributor greeting"
      description: "This will automatically display the help menu for first time commentators in a repository."
      # command: "^\/greeting$"
      # example: "/greeting"
      uses:
        - ubiquibot/new-commentator-greeting@7c181d2

    - name: "Wallet registration"
      description: "Register your wallet for payouts."
      command: "^\/wallet\\s+((0x[a-fA-F0-9]{40})|([a-zA-Z0-9]{4,})|([a-zA-Z0-9]{3,}\\.eth))$"
      example: "/wallet <wallet address>"
      uses:
        - ubiquibot/command-wallet@471fcd5
      with: 
        registerWalletWithVerification: false

 * https://github.com/ubiquity/ubiquibot-kernel/issues/25#issuecomment-1959403559
 */
export async function issueCommentCreated(event: GitHubContext<"issue_comment.created">) {
  const configuration = await getUbiquiBotConfig(event);

  console.log(`fetching configuration for ${event.payload.repository.name}`);

  const plugins = configuration.plugins?.ISSUE_COMMENT_CREATED;

  if (!plugins) {
    console.error("No plugins found for issue_comment.created");
    return;
  }

  console.log(`found ${plugins.length} plugins for ${event.payload.repository.name}`);

  const command = commentParser(event.payload.comment.body, plugins);

  if (!command) {
    return;
  }
  const commandHandler = plugins.find((cmd) => cmd.command === command);

  if (!commandHandler) {
    return;
  } else {
    console.log(`Found command handler for ${commandHandler.name}`);

    // assuming the plugin is the start and end i.e it posts the comment
    await pluginDispatch(commandHandler, event);
  }
}

// Parses the comment body and figure out the command name a user wants
function commentParser(body: string, plugins: Plugin[]): null | string {
  const pluginCommands = plugins.map((cmd) => cmd.command);
  const regex = new RegExp(`^(${pluginCommands.join("|")})\\b`); // Regex pattern to match any command at the beginning of the body
  const matches = regex.exec(body);
  if (matches) {
    const command = matches[0] as string;
    if (pluginCommands.includes(command)) {
      return command;
    }
  }

  return null;
}

/**
 * Dispatches a custom repository_dispatch event to the repository's workflow
 * below is the workflow that listens for my research-command dispatch
 * it sets up the environment, runs the plugin, then posts the comment
 
  name: Research Command
  on:
    repository_dispatch:
      types: [research-command]
  jobs:
    research:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout
        - name: Setup Node
        - name: Yarn Install

        - name: Research
          id: research
          uses: ./src
          body: ${{ github.event.client_payload.body }}
          issueNumber: ${{ github.event.client_payload.issueNumber }}
          sender: ${{ github.event.client_payload.sender }}
          repo: ${{ github.event.client_payload.repo }}
          org: ${{ github.event.client_payload.org }}

        - name: Comment
          uses: actions/github-script@v3
          with:
            github-token: ${{ secrets.GITHUB_TOKEN }}
            script: |
              github.issues.createComment({
                issue_number: ${{ github.event.client_payload.issueNumber }},
                owner: ${{ github.event.client_payload.org }},
                repo: ${{ github.event.client_payload.repo }},
                body: ${{ steps.research.outputs.answer }}
              })

  * @dev this does not return anything, the runID must be fetched using fetchInvokedPluginRunner()
  * @param eventType custom dispatch event type which is the lowercased hyphenated name of the plugin
  * @param event Webhook event 
  * @param owner Repository owner
  * @param repo Repository name
 */
async function pluginDispatch(plugin: Plugin, event: GitHubContext<"issue_comment.created">) {
  const { owner, name: repo } = event.payload.repository;

  // It's minimal and you can build the entire event from it
  const clientPayload = {
    body: event.payload.comment.body,
    issueNumber: event.payload.issue.number,
    sender: event.payload.sender.login,
    repo,
    org: event.payload.repository.owner.login,
  };

  const eventType = plugin.name.toLowerCase().replace(/\s/g, "-");

  console.log(`Dispatching event ${eventType} to ${owner}/${repo}`);

  await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });

  console.log(`${eventType} dispatched to ${owner}/${repo}`);

  // assuming this returns more than one run we can filter by owner/repo
  // maybe some more metadata would be useful to filter with
  const runs = await fetchInProgressRunsBatch5(owner.login, repo, eventType);

  if (runs.length === 0) {
    return "No runs found";
  }

  console.log(`Found ${runs.length} runs for ${eventType} in ${owner}/${repo}`);

  // Poll the run until it's completed
  const output = await pollInProgressRunTillCompletion(runs[0].id, owner.login, repo);

  console.log(`Output for ${eventType} in ${owner}/${repo}`);
  console.log("=====================================");
  console.log(output);
}

/**
 * It should poll the run until the status is completed
 * @param runID the ID of the run to poll
 * @param owner the invoked plugin's owner (ubiquibot/... or other)
 * @param repo where the invoked plugin resides /research or other)
 * @returns the output of the run
 */
async function pollInProgressRunTillCompletion(runID: number, owner: string, repo: string) {
  let isCompleted = false;
  while (!isCompleted) {
    console.log(`Polling run ${runID} for completion`);
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runID}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: ACCEPT_TYPE,
      },
    });
    const runData = (await response.json()) as { status: string };
    if (runData.status === "completed") {
      console.log(`Run ${runID} completed`);
      isCompleted = true;
    } else {
      /**
       * The action will first have to assign a runner - 1-3s
       * then checkout the repo - 1-3s
       * then yarn install - 10-15s
       * then invoke tsx - 3-max-allowed-in-an-action?
       */
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }

  return await fetchRunLogs(runID, owner, repo);
}

/**
 * Fetches the logs of a run
 * @param runID the ID of the run to fetch logs for
 * @param owner the invoked plugin's owner (ubiquibot/... or other)
 * @param repo where the invoked plugin resides /research or other)
 * @returns the logs of the run
 */
async function fetchRunLogs(runID: number, owner: string, repo: string) {
  console.log(`Fetching logs for run ${runID}`);

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runID}/jobs`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: ACCEPT_TYPE,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobsData: any = await response.json();

  /**
   * The action could have multiple jobs, so a strict structure is needed
   * such that the output is easily identifiable and accessible
   * no matter the number of jobs/steps
   *
   * We'll assume the action has only one job
   */

  const jobId = jobsData.jobs[0].id;

  console.log(`Fetching job details for job ${jobId}`);

  const jobDetailsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}`;
  const jobDetailsResponse = await fetch(jobDetailsUrl, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: ACCEPT_TYPE,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobDetails: any = await jobDetailsResponse.json();

  console.log(`Fetching steps for job ${jobId}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobDetails.steps.reduce((acc: { [x: string]: any }, step: { conclusion: string; outputs: { [x: string]: any } }) => {
    if (step.conclusion === "success" && step.outputs) {
      Object.keys(step.outputs).forEach((key) => {
        acc[key] = step.outputs[key];
      });
    }
    return acc;
  }, {});
}
/**
 *
 * @param owner the invoked plugin's owner (ubiquibot/... or other)
 * @param repo where the invoked plugin resides /research or other)
 * @param eventType the custom dispatch event type which is the lowercased hyphenated name of the plugin
 * @returns the last 5 runs of the invoked plugin in the repository
 */
async function fetchInvokedPluginRunner(owner: string, repo: string, eventType: string) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: ACCEPT_TYPE,
    },
  });

  const data = (await response.json()) as WorkflowRuns;
  return data.workflow_runs.filter((run) => run.name === eventType).slice(0, 5);
}

/**
 * @notice the assumption is that the run we'd be looking for will be one of the last 5
 *         which might not be very scalable, need to see what sort of data limits there are
 *         for the API response
 * @param owner the invoked plugin's owner (ubiquibot/... or other)
 * @param repo where the invoked plugin resides /research or other)
 * @param eventType the custom dispatch event type which is the lowercased hyphenated name of the plugin
 * @returns uncompleted runs based on the last 5
 */
async function fetchInProgressRunsBatch5(owner: string, repo: string, eventType: string) {
  const runs = await fetchInvokedPluginRunner(owner, repo, eventType);
  return runs.filter((run) => run.status === "in_progress");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchUncompletedRunsBatch5(owner: string, repo: string, eventType: string) {
  const runs = await fetchInvokedPluginRunner(owner, repo, eventType);
  return runs.filter((run) => run.status !== "completed");
}
