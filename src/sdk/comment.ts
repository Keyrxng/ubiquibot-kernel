import { Context } from "./context";
import { LogReturn, Metadata } from "@ubiquity-os/ubiquity-os-logger";
import { sanitizeMetadata } from "./util";
import { CloudflareEnvBindings } from "./server";

const HEADER_NAME = "Ubiquity";

/**
 * Posts a comment on a GitHub issue if the issue exists in the context payload, embedding structured metadata to it.
 */
export async function postComment(context: Context, message: LogReturn | Error | null, honoEnv: CloudflareEnvBindings) {
  if (!message) {
    return;
  }

  let issueNumber

  if ("issue" in context.payload) {
    issueNumber = context.payload.issue.number;
  } else if ("pull_request" in context.payload) {
    issueNumber = context.payload.pull_request.number;
  } else if ("discussion" in context.payload) {
    issueNumber = context.payload.discussion.number;
  } else {
    context.logger.info("Cannot post comment because issue is not found in the payload");
    return;
  }

  await context.octokit.rest.issues.createComment({
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    issue_number: issueNumber,
    body: await createStructuredMetadataErrorComment(message, context, honoEnv),
  });
}

async function createStructuredMetadataErrorComment(message: LogReturn | Error, context: Context, honoEnv: CloudflareEnvBindings) {
  let metadata: Metadata = {};
  let logMessage, logTier, callingFnName, headerName;

  if (message instanceof Error) {
    metadata = {
      message: message.message,
      name: message.name,
      stack: message.stack,
    };

    callingFnName = message.stack?.split("\n")[2]?.match(/at (\S+)/)?.[1];

  } else if (message instanceof LogReturn && message.metadata) {
    logMessage = message.logMessage;
    logTier = message.logMessage.level; // LogLevel
    metadata = message.metadata;

    if (metadata.stack || metadata.error) {
      metadata.stack = metadata.stack || metadata.error?.stack;
      metadata.caller = metadata.caller || metadata.error?.stack?.split("\n")[2]?.match(/at (\S+)/)?.[1];
    }

    callingFnName = metadata.caller;
  } else {
    metadata = { ...message };
  }

  if ("organization" in context.payload) {
    headerName = context.payload.organization?.login;
  } else if ("repository" in context.payload) {
    headerName = context.payload.repository?.owner?.login;
  } else if ("installation" in context.payload && "account" in context.payload.installation!) {
    // could use their ID here instead as ID is in all installation payloads
    headerName = context.payload.installation?.account?.name;
  } else {
    headerName = context.payload.sender?.login || HEADER_NAME;
  }

  const workerDetails = await getWorkerDeploymentHash(context, honoEnv);
  const workerLogUrl = await getWorkerErrorLogUrl(context, honoEnv);
  metadata.worker = { ...workerDetails, logUrl: workerLogUrl };

  const jsonPretty = sanitizeMetadata(metadata);
  const ubiquityMetadataHeader = `<!-- UbiquityOS - ${headerName} - ${logTier} - ${context.pluginDeploymentDetails} - ${callingFnName} - ${workerDetails?.versionId.split("-")[0]}`;

  let metadataSerialized: string;
  const metadataSerializedVisible = ["```json", jsonPretty, "```"].join("\n");
  const metadataSerializedHidden = [ubiquityMetadataHeader, jsonPretty, "-->"].join("\n");

  if (logMessage?.type === "fatal") {
    // if the log message is fatal, then we want to show the metadata
    metadataSerialized = [metadataSerializedVisible, metadataSerializedHidden].join("\n");
  } else {
    // otherwise we want to hide it
    metadataSerialized = metadataSerializedHidden;
  }

  if (message instanceof Error) {
    return [context.logger.error(message.message).logMessage.diff, `\n${metadataSerialized}\n`].join("\n");
  }

  // Add carriage returns to avoid any formatting issue
  return [logMessage?.diff, `\n${metadataSerialized}\n`].join("\n");
}

/**
 * These vars will be injected into the worker environment via 
 * `worker-deploy` action. These are not defined in plugin env schema.
 */
async function getWorkerDeploymentHash(context: Context, honoEnv: CloudflareEnvBindings) {
  const accountId = honoEnv.CLOUDFLARE_ACCOUNT_ID;
  let scriptName = context.pluginDeploymentDetails;

  if (scriptName === "localhost") {
    return { versionId: "local", message: "Local development environment" };
  }

  const scriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`;
  const response = await fetch(scriptUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${honoEnv.CLOUDFLARE_API_TOKEN}`,
    },
  });

  try {
    const data = await response.json() as { result: { deployments: { annotations: { "workers/message": string }, id: string, versions: { version_id: string }[] }[] } };
    const deployment = data.result.deployments[0];
    const versionId = deployment.versions[0].version_id;
    const message = deployment.annotations["workers/message"];
    return { versionId, message };
  } catch (error) {
    context.logger.error(`Error fetching worker deployment hash: ${String(error)}`);
  }
}

async function getWorkerErrorLogUrl(context: Context, honoEnv: CloudflareEnvBindings) {
  const accountId = honoEnv.CLOUDFLARE_ACCOUNT_ID;
  const workerName = context.pluginDeploymentDetails;
  const toTime = Date.now() + 60000;
  const fromTime = Date.now() - 60000;
  const timeParam = encodeURIComponent(`{"type":"absolute","to":${toTime},"from":${fromTime}}`);
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/observability/logs?granularity=0&time=${timeParam}`;
}