import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
} from "@openai/codex-sdk";
import {
  DeepEvalBaseLLM,
  type GenerationResult,
} from "deepeval/models";
import { z, type ZodType } from "zod";

const API_KEY_ENVIRONMENT_VARIABLES = new Set([
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
]);

const CHATGPT_LOGIN_OVERRIDE = 'forced_login_method="chatgpt"';

/** Native Codex SDK options for a DeepEval judge. */
export interface CodexJudgeOptions {
  /** Applied to every fresh judging thread. */
  readonly threadOptions?: ThreadOptions;

  /** Applied when constructing the underlying Codex SDK client. */
  readonly codexOptions?: CodexOptions;
}

/** A DeepEval model adapter backed by a fresh Codex thread per generation. */
export class CodexJudge extends DeepEvalBaseLLM {
  private readonly codex: Codex;
  private readonly threadOptions: ThreadOptions;

  constructor(options: CodexJudgeOptions = {}) {
    super(options.threadOptions?.model);

    this.threadOptions = {
      approvalPolicy: "never",
      sandboxMode: "read-only",
      skipGitRepoCheck: true,
      ...options.threadOptions,
    };

    const {
      apiKey,
      configOverrides,
      env,
      ...codexOptions
    } = options.codexOptions ?? {};

    if (apiKey !== undefined) {
      throw new TypeError(
        "CodexJudge uses ChatGPT subscription authentication and does not accept codexOptions.apiKey",
      );
    }

    this.codex = new Codex({
      ...codexOptions,
      configOverrides: [
        ...(configOverrides ?? []),
        CHATGPT_LOGIN_OVERRIDE,
      ],
      env: withoutApiKeys(env ?? process.env),
    });
  }

  async generate<T = string>(
    prompt: string,
    schema?: ZodType<T>,
  ): Promise<GenerationResult<T>> {
    const thread = this.codex.startThread(this.threadOptions);

    if (schema === undefined) {
      const turn = await thread.run(prompt);
      return { output: turn.finalResponse as T, cost: null };
    }

    const turn = await thread.run(prompt, {
      outputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
    });

    let output: unknown;
    try {
      output = JSON.parse(turn.finalResponse);
    } catch (cause) {
      throw new Error("Codex returned invalid JSON for structured output", {
        cause,
      });
    }

    return { output: schema.parse(output), cost: null };
  }

  getModelName(): string {
    return this.modelName ?? "codex";
  }
}

function withoutApiKeys(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      !API_KEY_ENVIRONMENT_VARIABLES.has(key.toUpperCase())
    ) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
