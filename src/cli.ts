#!/usr/bin/env bun
// pi-review: reviews a git change with pi, giving the model the diff and read-only tools confined to the repository.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import packageJson from "../package.json" with { type: "json" }
import { collectChange, type ReviewTarget } from "./change.ts"
import { type ReadOnlyToolName, readOnlyToolNames } from "./confine.ts"
import { GitError, repositoryRoot } from "./git.ts"
import { defaultRubric, reviewPrompt } from "./prompt.ts"
import { Models, review, ReviewError, type ThinkingLevel, type ToolCallSubject } from "./reviewer.ts"

const thinkingLevels: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

const defaultModel = "openai/gpt-6.1-sol"

const flags = {
  path: Flag.String("path").pipe(Flag.withDescription("A folder in the repository to review (default: the current one)"), Flag.withDefault(".")),
  base: Flag.String("base").pipe(Flag.withDescription("Review the changes against this branch instead of the uncommitted ones"), Flag.optional),
  commit: Flag.String("commit").pipe(Flag.withDescription("Review the changes of this commit instead of the uncommitted ones"), Flag.optional),
  model: Flag.String("model").pipe(Flag.withDescription(`The reviewer, as provider/model (default: ${defaultModel})`), Flag.withDefault(defaultModel)),
  thinking: Flag.Literals("thinking", thinkingLevels).pipe(Flag.withDescription("The reviewer's thinking level (default: medium)"), Flag.withDefault<ThinkingLevel>("medium")),
  tools: Flag.Literals("tool", readOnlyToolNames).pipe(
    Flag.withDescription("A tool the reviewer may use, repeatable (default: read, grep, find and ls)"),
    Flag.atLeast(0)
  ),
  maxDiffKb: Flag.Int("max-diff-kb").pipe(Flag.withDescription("Cut the diff sent to the reviewer at this size (default: 256)"), Flag.withDefault(256)),
  rubric: Flag.FileText("rubric").pipe(Flag.withDescription("A file whose text replaces the default review rubric"), Flag.optional),
  instructions: Argument.String("INSTRUCTIONS").pipe(Argument.withDescription("Extra instructions for the reviewer"), Argument.optional),
}

const reviewTarget = (base: Option.Option<string>, commit: Option.Option<string>): Effect.Effect<ReviewTarget, ReviewError> => {
  if (Option.isSome(base) && Option.isSome(commit)) return Effect.fail(new ReviewError({ message: "use --base or --commit, not both" }))
  if (Option.isSome(base)) return Effect.succeed({ kind: "base", branch: base.value })
  if (Option.isSome(commit)) return Effect.succeed({ kind: "commit", sha: commit.value })
  return Effect.succeed({ kind: "uncommitted" })
}

// One progress line per tool call on stderr, such as "  read src/cli.ts".
const printToolCall = (console: Console.Console) => (toolName: string, subject: ToolCallSubject) => {
  const what = [subject.pattern, subject.path].filter((value) => typeof value === "string").join(" in ")
  console.error(`  ${toolName} ${what}`.trimEnd())
}

// The tools picked with --tool, or all of them when none is.
const chosenTools = (tools: ReadonlyArray<ReadOnlyToolName>) => {
  if (tools.length === 0) return readOnlyToolNames
  return tools
}

export const piReview = Command.make(
  "pi-review",
  flags,
  Effect.fn("piReview")(function* ({ path, base, commit, model, thinking, tools, maxDiffKb, rubric, instructions }) {
    const target = yield* reviewTarget(base, commit)
    const root = yield* repositoryRoot(path)
    const change = yield* collectChange(root, target)
    yield* Console.error(`reviewing ${change.summary} in ${root} with ${model}`)
    const answer = yield* review({
      root,
      model,
      thinking,
      tools: chosenTools(tools),
      rubric: Option.getOrElse(rubric, () => defaultRubric),
      prompt: reviewPrompt({ change, instructions, maxDiffBytes: maxDiffKb * 1024 }),
      onToolCall: printToolCall(yield* Console.Console),
    })
    yield* Console.log(answer)
  })
).pipe(Command.withDescription("Review a git change with pi: the diff goes in the prompt, the reviewer reads the repository with read-only tools."))

// Runs pi-review on its command-line arguments.
export const run = (args: ReadonlyArray<string>) => Command.runWith(piReview, { version: packageJson.version })(args)

// pi-review's own failures are a message for the user, not a stack trace.
const report = (error: GitError | ReviewError) =>
  Console.error(`pi-review: ${error.message}`).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1
      })
    )
  )

if (import.meta.main) {
  BunRuntime.runMain(run(process.argv.slice(2)).pipe(Effect.provide(Layer.mergeAll(Models.layer, BunServices.layer)), Effect.catchTags({ GitError: report, ReviewError: report })))
}
