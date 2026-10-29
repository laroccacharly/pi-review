// Runs git in the repository under review.
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
}) {}

export interface GitOptions {
  // Exit codes that mean success besides 0, such as 1 for `git diff --no-index` when the files differ.
  readonly okExitCodes?: ReadonlyArray<number>
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// Resolves to git's stdout, failing with its stderr when it exits with a code not in `okExitCodes`.
export const git: (
  directory: string,
  args: ReadonlyArray<string>,
  options?: GitOptions
) => Effect.Effect<string, GitError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("git")(function* (
  directory: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {}
) {
  const failed = (message: string) => new GitError({ message: `git ${args.join(" ")} failed: ${message}` })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const okExitCodes = [0, ...(options.okExitCodes ?? [])]
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", directory, ...args], { stdin: "ignore" }))
      const [stdout, stderr, exitCode] = yield* Effect.all([Stream.mkUint8Array(handle.stdout), Stream.mkUint8Array(handle.stderr), handle.exitCode], {
        concurrency: "unbounded",
      })
      if (!okExitCodes.includes(exitCode)) return yield* failed(decode(stderr).trim() || `exit code ${exitCode}`)
      return decode(stdout)
    })
  ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message))))
})

// The top folder of the git repository that holds `path`.
export const repositoryRoot = (path: string) =>
  git(path, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((output) => output.trim()),
    Effect.mapError(() => new GitError({ message: `not a git repository: ${path}` }))
  )
