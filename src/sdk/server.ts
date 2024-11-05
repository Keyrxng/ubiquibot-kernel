import { EmitterWebhookEventName as WebhookEventName } from "@octokit/webhooks";
import { TAnySchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { LOG_LEVEL, LogLevel, LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { Env, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Manifest } from "../types/manifest";
import { KERNEL_PUBLIC_KEY } from "./constants";
import { Context } from "./context";
import { customOctokit } from "./octokit";
import { verifySignature } from "./signature";
import { env as honoEnv } from "hono/adapter";
import { postComment } from "./comment";
import { Type as T } from "@sinclair/typebox";

interface Options {
  kernelPublicKey?: string;
  logLevel?: LogLevel;
  postCommentOnError?: boolean;
  settingsSchema?: TAnySchema;
  envSchema?: TAnySchema;
}

const inputSchema = T.Object({
  stateId: T.String(),
  eventName: T.String(),
  eventPayload: T.Record(T.String(), T.Any()),
  authToken: T.String(),
  settings: T.Record(T.String(), T.Any()),
  ref: T.String(),
  signature: T.String(),
});

export type CloudflareEnvBindings = {
  CLOUDFLARE_ACCOUNT_ID: string,
  CLOUDFLARE_API_TOKEN: string
}

export function createPlugin<TConfig = unknown, TEnv = unknown, TSupportedEvents extends WebhookEventName = WebhookEventName>(
  handler: (context: Context<TConfig, TEnv, TSupportedEvents>) => Promise<Record<string, unknown> | undefined>,
  manifest: Manifest,
  options?: Options
) {
  const pluginOptions = {
    kernelPublicKey: options?.kernelPublicKey || KERNEL_PUBLIC_KEY,
    logLevel: options?.logLevel || LOG_LEVEL.INFO,
    postCommentOnError: options?.postCommentOnError || true,
    settingsSchema: options?.settingsSchema,
    envSchema: options?.envSchema,
  };


  const app = new Hono<{ Bindings: CloudflareEnvBindings }>();

  app.get("/manifest.json", (ctx) => {
    return ctx.json(manifest);
  });

  app.post("/", async (ctx) => {
    if (ctx.req.header("content-type") !== "application/json") {
      throw new HTTPException(400, { message: "Content-Type must be application/json" });
    }

    const body = await ctx.req.json();
    const inputSchemaErrors = [...Value.Errors(inputSchema, body)];
    if (inputSchemaErrors.length) {
      console.dir(inputSchemaErrors, { depth: null });
      throw new HTTPException(400, { message: "Invalid body" });
    }
    const inputs = Value.Decode(inputSchema, body);
    const signature = inputs.signature;
    if (!(await verifySignature(pluginOptions.kernelPublicKey, inputs, signature))) {
      throw new HTTPException(400, { message: "Invalid signature" });
    }

    let config: TConfig;
    if (pluginOptions.settingsSchema) {
      try {
        config = Value.Decode(pluginOptions.settingsSchema, Value.Default(pluginOptions.settingsSchema, inputs.settings));
      } catch (e) {
        console.dir(...Value.Errors(pluginOptions.settingsSchema, inputs.settings), { depth: null });
        throw e;
      }
    } else {
      config = inputs.settings as TConfig;
    }

    let env: TEnv;
    const honoEnvironment = honoEnv(ctx);
    if (pluginOptions.envSchema) {
      try {
        env = Value.Decode(pluginOptions.envSchema, Value.Default(pluginOptions.envSchema, honoEnvironment));
      } catch (e) {
        console.dir(...Value.Errors(pluginOptions.envSchema, honoEnvironment), { depth: null });
        throw e;
      }
    } else {
      env = ctx.env as TEnv;
    }

    const workerUrl = new URL(inputs.ref).origin;
    let workerName;

    if (workerUrl.includes("localhost")) {
      workerName = "localhost";
    } else {
      workerName = `${workerUrl.split("//")[1].split(".")[0]}`;
    }

    const context: Context<TConfig, TEnv, TSupportedEvents> = {
      eventName: inputs.eventName as TSupportedEvents,
      payload: inputs.eventPayload,
      octokit: new customOctokit({ auth: inputs.authToken }),
      config: config,
      env: env,
      logger: new Logs(pluginOptions.logLevel),
      pluginDeploymentDetails: `${workerName}`,
    };

    try {
      const result = await handler(context);
      return ctx.json({ stateId: inputs.stateId, output: result });
    } catch (error) {
      console.error(error);
      const loggerError = error as LogReturn | Error | null;
      if (pluginOptions.postCommentOnError && loggerError) {
        await postComment(context, loggerError, honoEnvironment);
      }

      throw new HTTPException(500, { message: "Unexpected error" });
    }
  });

  return app;
}
