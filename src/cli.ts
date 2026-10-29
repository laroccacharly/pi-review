#!/usr/bin/env bun
// pi-review: reviews a git change with pi, giving the model the diff and read-only tools confined to the repository.
// The review runs in the background by default; --status and --wait read its result.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { appendFileSync } from "node:fs"
import { Console, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import packageJson from "../package.json" with { type: "json" }
import { collectChange, type ReviewTarget } from "./change.ts"
import { type ReadOnlyToolName, readOnlyToolNames } from "./confine.ts"
import { GitError, repositoryRoot } from "./git.ts"
import { defaultRubric, reviewPrompt } from "./prompt.ts"
import { Models, resolveModel, review, ReviewError, type ReviewSettings, type ThinkingLevel, type ToolCallSubject } from "./reviewer.ts"
import { detachedRun, latestRun, newRun, readRequest, recordExit, type Run, type RunState, runState, saveReview, startDetached, waitForRun } from "./runs.ts"

const thinkingLevels: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

const defaultModel = "openai/gpt-6.1-sol"

const waitTimeout = "15 minutes"

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
  foreground: Flag.Boolean("foreground").pipe(Flag.withDescription("Run the review here and wait for it instead of in the background"), Flag.withDefault(false)),
  status: Flag.Boolean("status").pipe(Flag.withDescription("Print the state of the latest review, and the review once it is done"), Flag.withDefault(false)),
  wait: Flag.Boolean("wait").pipe(Flag.withDescription("Wait up to 15 minutes for the latest review to finish, then print it as --status does"), Flag.withDefault(false)),
  instructions: Argument.String("INSTRUCTIONS").pipe(Argument.withDescription("Extra instructions for the reviewer"), Argument.optional),
}

const reviewTarget = (base: Option.Option<string>, commit: Option.Option<string>): Effect.Effect<ReviewTarget, ReviewError> => {
  if (Option.isSome(base) && Option.isSome(commit)) return Effect.fail(new ReviewError({ message: "use --base or --commit, not both" }))
  if (Option.isSome(base)) return Effect.succeed({ kind: "base", branch: base.value })
  if (Option.isSome(commit)) return Effect.succeed({ kind: "commit", sha: commit.value })
  return Effect.succeed({ kind: "uncommitted" })
}

// One progress line per tool call, such as "  read src/cli.ts".
const printToolCall = (print: (line: string) => void) => (toolName: string, subject: ToolCallSubject) => {
  const what = [subject.pattern, subject.path].filter((value) => typeof value === "string").join(" in ")
  print(`  ${toolName} ${what}`.trimEnd())
}

// The tools picked with --tool, or all of them when none is.
const chosenTools = (tools: ReadonlyArray<ReadOnlyToolName>) => {
  if (tools.length === 0) return readOnlyToolNames
  return tools
}

// The latest run: its state, where its files are, and the review once done or the end of its log if it failed.
const showRun: (run: Run, state: RunState) => Effect.Effect<void, ReviewError, FileSystem.FileSystem> = Effect.fn("showRun")(function* (run: Run, state: RunState) {
  const fs = yield* FileSystem.FileSystem
  const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
  yield* Console.log(`state: ${state}\nreview: ${run.review}\nlog: ${run.log}`)
  if (state === "done") yield* Console.log(`\n${(yield* readText(run.review)).trimEnd()}`)
  if (state === "failed" || state === "died") {
    yield* Console.log(`\n${(yield* readText(run.log)).slice(-2000).trimEnd()}`)
    return yield* new ReviewError({ message: `the review ${state}` })
  }
})

// --status shows the latest run as it is; --wait first waits for it to finish.
const checkLatestRun: (root: string, wait: boolean) => Effect.Effect<void, ReviewError, FileSystem.FileSystem> = Effect.fn("checkLatestRun")(function* (root: string, wait: boolean) {
  const latest = yield* latestRun(root)
  if (Option.isNone(latest)) return yield* new ReviewError({ message: `no review found for ${root}` })
  if (wait) return yield* showRun(latest.value, yield* waitForRun(latest.value, waitTimeout))
  return yield* showRun(latest.value, yield* runState(latest.value))
})

type ReviewOptions = Command.Command.Config.Infer<typeof flags>

type PreparedSettings = Omit<ReviewSettings, "root" | "onToolCall">

// What a review needs to run: pi's models, files and git.
type ReviewServices = Models | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

// The repository, its change and the review's settings, checked before anything runs.
const prepareReview: (options: ReviewOptions) => Effect.Effect<{ readonly root: string; readonly summary: string; readonly settings: PreparedSettings }, GitError | ReviewError, Models | ChildProcessSpawner.ChildProcessSpawner> =
  Effect.fn("prepareReview")(function* (options: ReviewOptions) {
    const target = yield* reviewTarget(options.base, options.commit)
    const root = yield* repositoryRoot(options.path)
    const change = yield* collectChange(root, target)
    yield* resolveModel(options.model)
    const settings = {
      model: options.model,
      thinking: options.thinking,
      tools: chosenTools(options.tools),
      rubric: Option.getOrElse(options.rubric, () => defaultRubric),
      prompt: reviewPrompt({ change, instructions: options.instructions, maxDiffBytes: options.maxDiffKb * 1024 }),
    }
    return { root, summary: change.summary, settings }
  })

const exitCode = <A>(exit: Exit.Exit<A, GitError | ReviewError>) => {
  if (Exit.isSuccess(exit)) return 0
  return 1
}

// Records the run's exit code once `effect` ends, however it ends.
const recordingExit = (run: Run) => <A, E extends GitError | ReviewError, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.onExit((exit) => recordExit(run, exitCode(exit))))

// Runs the review in this process and saves it, writing its progress lines with `progress`.
const reviewHere: (run: Run, root: string, settings: PreparedSettings, progress: (line: string) => void) => Effect.Effect<string, ReviewError, Models | FileSystem.FileSystem> = Effect.fn("reviewHere")(
  function* (run: Run, root: string, settings: PreparedSettings, progress: (line: string) => void) {
    progress(`reviewing in ${root} with ${settings.model}`)
    const answer = yield* review({ ...settings, root, onToolCall: printToolCall(progress) })
    yield* saveReview(run, answer)
    return run.review
  }
)

// A run started in the background carries out the review it was given; its stderr is its log.
const reviewDetached: (run: Run) => Effect.Effect<string, ReviewError, Models | FileSystem.FileSystem> = Effect.fn("reviewDetached")(function* (run: Run) {
  const console = yield* Console.Console
  const { root, settings } = yield* readRequest(run)
  return yield* reviewHere(run, root, settings, (line) => console.error(line))
})

// A run in the foreground writes its progress lines and errors to the terminal and to its log, then prints the
// review's path.
const reviewInForeground: (options: ReviewOptions) => Effect.Effect<void, GitError | ReviewError, ReviewServices> = Effect.fn("reviewInForeground")(function* (options: ReviewOptions) {
  const console = yield* Console.Console
  const { root, settings } = yield* prepareReview(options)
  const run = yield* newRun(root)
  const toLog = (line: string) => appendFileSync(run.log, `${line}\n`)
  const progress = (line: string) => {
    console.error(line)
    toLog(line)
  }
  const path = yield* reviewHere(run, root, settings, progress).pipe(
    Effect.tapError((error) => Effect.sync(() => toLog(`pi-review: ${error.message}`))),
    recordingExit(run)
  )
  yield* Console.log(path)
})

// Starts the review in the background and prints the path its review will have.
const startReview: (options: ReviewOptions) => Effect.Effect<void, GitError | ReviewError, ReviewServices> = Effect.fn("startReview")(function* (options: ReviewOptions) {
  const { root, summary, settings } = yield* prepareReview(options)
  const run = yield* newRun(root)
  yield* startDetached(run, { root, settings })
  yield* Console.error(`reviewing ${summary} in ${root} with ${options.model} in the background; follow it with --status or --wait`)
  yield* Console.log(run.review)
})

export const piReview = Command.make(
  "pi-review",
  flags,
  Effect.fn("piReview")(function* (options) {
    const detached = detachedRun()
    if (Option.isSome(detached)) return yield* reviewDetached(detached.value).pipe(recordingExit(detached.value), Effect.asVoid)
    if (options.status && options.wait) return yield* new ReviewError({ message: "use --status or --wait, not both" })
    if (options.status || options.wait) return yield* checkLatestRun(yield* repositoryRoot(options.path), options.wait)
    if (options.foreground) return yield* reviewInForeground(options)
    return yield* startReview(options)
  })
).pipe(
  Command.withDescription(
    "Review a git change with pi: the diff goes in the prompt, the reviewer reads the repository with read-only tools. The review runs in the background and is saved in ~/.cache/pi-review/, with its log; the path of the review is printed."
  )
)

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
