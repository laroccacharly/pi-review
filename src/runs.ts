// Each review is a run with its files in the user's cache folder, ~/.cache/pi-review/<project>-<hash>/<timestamp>.*:
// .md (the review), .log (the progress lines and errors), .pid (the process) and .exit (its exit code, once done).
// A run in the background is this CLI started again, detached, with the run in its environment; it reviews what
// .json holds, the change as it was when the review was asked for.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { type Duration, Effect, FileSystem, Option, Schedule } from "effect"
import { ReviewError, type ReviewSettings } from "./reviewer.ts"

export interface Run {
  readonly review: string
  readonly log: string
  readonly pid: string
  readonly exit: string
  readonly request: string
}

// A review prepared in the foreground, for the detached run to carry out.
export interface ReviewRequest {
  readonly root: string
  readonly settings: Omit<ReviewSettings, "root" | "onToolCall">
}

export type RunState = "running" | "done" | "failed" | "died"

// Set in a detached run's environment: the path of its files without their extension.
const runVariable = "PI_REVIEW_RUN"

const cli = join(import.meta.dirname, "cli.ts")

const runAt = (base: string): Run => ({ review: `${base}.md`, log: `${base}.log`, pid: `${base}.pid`, exit: `${base}.exit`, request: `${base}.json` })

// $XDG_CACHE_HOME/pi-review, or ~/.cache/pi-review when it is not set.
const cacheFolder = () => join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "pi-review")

// One folder per repository, named after it, with a hash of its path to tell apart two repositories of the same name.
const runsFolder = (root: string) => join(cacheFolder(), `${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`)

// The UTC time as 20261029-142233-123, so the runs sort in the order they started, daylight saving or not.
const timestamp = (date: Date) => {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  return `${day}-${time}-${pad(date.getUTCMilliseconds(), 3)}`
}

const failure =
  (what: string) =>
  (error: { readonly message: string }) =>
    new ReviewError({ message: `${what}: ${error.message}` })

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The latest run of the repository at `root`, if any.
export const latestRun: (root: string) => Effect.Effect<Option.Option<Run>, ReviewError, FileSystem.FileSystem> = Effect.fn("latestRun")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const folder = runsFolder(root)
  if (!(yield* fs.exists(folder).pipe(Effect.mapError(failure("cannot read the runs"))))) return Option.none()
  const files = yield* fs.readDirectory(folder).pipe(Effect.mapError(failure("cannot read the runs")))
  const pidFiles = files.filter((file) => file.endsWith(".pid")).toSorted()
  return Option.map(Option.fromNullishOr(pidFiles.at(-1)), (file) => runAt(join(folder, file.slice(0, -".pid".length))))
})

export const runState: (run: Run) => Effect.Effect<RunState, ReviewError, FileSystem.FileSystem> = Effect.fn("runState")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem
  const read = (path: string) => fs.readFileString(path).pipe(Effect.map((text) => text.trim()), Effect.mapError(failure("cannot read the run")))
  if (yield* fs.exists(run.exit).pipe(Effect.mapError(failure("cannot read the run")))) {
    if ((yield* read(run.exit)) === "0") return "done"
    return "failed"
  }
  if (isAlive(Number(yield* read(run.pid)))) return "running"
  return "died"
})

// The state of `run` once it is no longer running, or "running" when it still is after `timeout`.
export const waitForRun = (run: Run, timeout: Duration.Input) =>
  runState(run).pipe(
    Effect.repeat({ schedule: Schedule.spaced("500 millis"), while: (state) => state === "running" }),
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): RunState => "running"))
  )

// A new run for the repository at `root`, claimed by this process; only one runs at a time per repository.
export const newRun: (root: string) => Effect.Effect<Run, ReviewError, FileSystem.FileSystem> = Effect.fn("newRun")(function* (root: string) {
  const latest = yield* latestRun(root)
  if (Option.isSome(latest) && (yield* runState(latest.value)) === "running") {
    return yield* new ReviewError({ message: `a review is already running for ${root}; use --status or --wait` })
  }
  const fs = yield* FileSystem.FileSystem
  const folder = runsFolder(root)
  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(failure("cannot create the runs folder")))
  const run = runAt(join(folder, timestamp(new Date())))
  yield* fs.writeFileString(run.pid, `${process.pid}\n`, { flag: "wx" }).pipe(Effect.mapError(failure("cannot start the run")))
  return run
})

// The run this process was started for in the background, if it was.
export const detachedRun = (): Option.Option<Run> => Option.map(Option.fromNullishOr(process.env[runVariable]), runAt)

const recordPid = (run: Run, pid: number) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(run.pid, `${pid}\n`)).pipe(Effect.mapError(failure("cannot record the run")))

export const recordExit = (run: Run, code: number) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(run.exit, `${code}\n`)).pipe(Effect.mapError(failure("cannot record the run")))

export const saveReview = (run: Run, review: string) =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(run.review, `${review}\n`, { flag: "wx" })).pipe(Effect.mapError(failure("cannot save the review")))

export const readRequest = (run: Run): Effect.Effect<ReviewRequest, ReviewError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(run.request)).pipe(
    Effect.map((text): ReviewRequest => JSON.parse(text)),
    Effect.mapError(failure("cannot read the review to run"))
  )

// Starts pi-review for `run`, detached, to carry out `request`, with its stderr in the run's log.
export const startDetached = (run: Run, request: ReviewRequest): Effect.Effect<void, ReviewError, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) => fs.writeFileString(run.request, JSON.stringify(request))).pipe(
    Effect.mapError(failure("cannot save the review to run")),
    Effect.andThen(spawnDetached(run))
  )

const spawnDetached = (run: Run): Effect.Effect<void, ReviewError, FileSystem.FileSystem> =>
  Effect.try({
    try: () => {
      const log = openSync(run.log, "a")
      const child = spawn(process.execPath, [cli], {
        detached: true,
        stdio: ["ignore", "ignore", log],
        env: { ...process.env, [runVariable]: run.review.slice(0, -".md".length) },
      })
      closeSync(log)
      child.unref()
      if (child.pid === undefined) throw new Error("no process id")
      return child.pid
    },
    catch: (error) => new ReviewError({ message: `cannot start the review in the background: ${String(error)}` }),
  }).pipe(Effect.flatMap((pid) => recordPid(run, pid)))
