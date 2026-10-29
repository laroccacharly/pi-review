// The change under review, collected with git: what it is, the files it touches and its diff.
import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { git, GitError } from "./git.ts"

export type ReviewTarget =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "base"; readonly branch: string }
  | { readonly kind: "commit"; readonly sha: string }

export interface Change {
  // One line saying what is reviewed, such as "the changes against main (merge base 1a2b3c4)".
  readonly summary: string
  // The changed files with their added and removed line counts.
  readonly files: string
  readonly diff: string
}

const diffFlags = ["--no-color", "--no-ext-diff"]

const untrackedFiles = (root: string) =>
  git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).pipe(Effect.map((output) => output.split("\0").filter(Boolean)))

// A new file's diff against nothing; git exits with 1 because the two differ.
const untrackedFileDiff = (root: string, file: string) => git(root, ["diff", ...diffFlags, "--no-index", "--", "/dev/null", file], { okExitCodes: [1] })

// HEAD, or git's empty tree in a repository with no commit yet, so its first files can be reviewed.
const headOrEmptyTree: (root: string) => Effect.Effect<string, GitError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("headOrEmptyTree")(function* (root: string) {
  const head = (yield* git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { okExitCodes: [1] })).trim()
  if (head !== "") return head
  return (yield* git(root, ["hash-object", "-t", "tree", "/dev/null"])).trim()
})

const uncommittedChange: (root: string) => Effect.Effect<Change, GitError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("uncommittedChange")(function* (root: string) {
  const head = yield* headOrEmptyTree(root)
  const untracked = yield* untrackedFiles(root)
  const trackedFiles = yield* git(root, ["diff", head, "--stat"])
  const trackedDiff = yield* git(root, ["diff", head, ...diffFlags])
  const untrackedDiffs = yield* Effect.forEach(untracked, (file) => untrackedFileDiff(root, file))
  const untrackedLines = untracked.map((file) => ` ${file} (untracked)`)
  return {
    summary: "the uncommitted changes (staged, unstaged and untracked files)",
    files: [trackedFiles.trimEnd(), ...untrackedLines].filter(Boolean).join("\n"),
    diff: [trackedDiff, ...untrackedDiffs].join(""),
  }
})

const baseChange: (root: string, branch: string) => Effect.Effect<Change, GitError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("baseChange")(function* (root: string, branch: string) {
  const mergeBase = (yield* git(root, ["merge-base", "HEAD", branch])).trim()
  return {
    summary: `the changes against ${branch} (merge base ${mergeBase.slice(0, 7)}), including uncommitted ones`,
    files: yield* git(root, ["diff", mergeBase, "--stat"]),
    diff: yield* git(root, ["diff", mergeBase, ...diffFlags]),
  }
})

const commitChange: (root: string, sha: string) => Effect.Effect<Change, GitError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("commitChange")(function* (root: string, sha: string) {
  const subject = (yield* git(root, ["show", "--no-patch", "--format=%h %s", sha])).trim()
  return {
    summary: `the changes of commit ${subject}`,
    files: yield* git(root, ["show", "--stat", "--format=", sha]),
    diff: yield* git(root, ["show", "--format=%B", ...diffFlags, sha]),
  }
})

const collectTarget = (root: string, target: ReviewTarget) => {
  if (target.kind === "base") return baseChange(root, target.branch)
  if (target.kind === "commit") return commitChange(root, target.sha)
  return uncommittedChange(root)
}

// The change to review in the repository at `root`; an empty change is an error, there is nothing to review.
export const collectChange = (root: string, target: ReviewTarget): Effect.Effect<Change, GitError, ChildProcessSpawner.ChildProcessSpawner> =>
  collectTarget(root, target).pipe(
    Effect.filterOrFail(
      (change) => change.diff.trim() !== "",
      (change) => new GitError({ message: `nothing to review: ${change.summary} are empty` })
    )
  )
