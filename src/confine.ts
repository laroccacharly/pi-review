// pi's read-only tools (read, grep, find, ls), confined to one folder: every path they touch is resolved through
// symlinks and refused when it falls outside. pi resolves the model's path (`~`, `@`, relative) before it calls
// these operations, so the check sees the path that is really read.
import { realpathSync } from "node:fs"
import { access, constants, readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

export const readOnlyToolNames = ["read", "grep", "find", "ls"] as const
export type ReadOnlyToolName = (typeof readOnlyToolNames)[number]

const isInside = (root: string, path: string) => {
  const fromRoot = relative(root, path)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

// The real path of `path`, or of its nearest existing parent with the rest appended, so a missing file still
// resolves to where it would be.
const realPathOf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(realPathOf(parent), basename(path))
  }
}

// Whether `path` is inside `root` once symlinks are resolved in both.
export const isInsideRepository = (root: string, path: string) => isInside(realpathSync(root), realPathOf(resolve(path)))

// Returns `path` when it is inside `root` once symlinks are resolved, and throws otherwise.
const guardPath = (root: string) => (path: string) => {
  if (!isInsideRepository(root, path)) throw new Error(`${path} is outside ${root}; only files in the repository can be read`)
  return path
}

const pathExists = (path: string) =>
  access(path, constants.F_OK).then(
    () => true,
    () => false
  )

// Files git sees in `root` (tracked, and untracked unless ignored), as paths relative to `root`.
const repositoryFiles = async (root: string) => {
  const listing = Bun.spawn(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(listing.stdout).text()
  return [...new Set(output.split("\0").filter(Boolean))]
}

// A path pattern that matches at any depth: `src/*.ts` becomes `**/src/*.ts`, a leading `/` anchors it at the top.
const anchoredPattern = (pattern: string) => {
  if (pattern.startsWith("/")) return pattern.slice(1)
  if (pattern.startsWith("**/")) return pattern
  return `**/${pattern}`
}

// fd's matching, which pi's own find uses: a pattern with no `/` matches the file name, one with a `/` matches the
// path below the search folder, at any depth.
const globMatcher = (pattern: string) => {
  if (!pattern.includes("/")) {
    const glob = new Bun.Glob(pattern)
    return (path: string) => glob.match(basename(path))
  }
  const glob = new Bun.Glob(anchoredPattern(pattern))
  return (path: string) => glob.match(path)
}

// Lists the repository's files below `searchPath` that match `pattern`, from git's index instead of fd, so the
// search never leaves the repository.
const findInRepository = (root: string) => async (pattern: string, searchPath: string, options: { limit: number }) => {
  const matches = globMatcher(pattern)
  const files = await repositoryFiles(root)
  return files
    .map((file) => join(root, file))
    .filter((file) => isInside(searchPath, file))
    .filter((file) => matches(relative(searchPath, file)))
    .slice(0, options.limit)
}

const confinedRead = (root: string, guard: (path: string) => string) =>
  createReadToolDefinition(root, {
    operations: {
      readFile: (path) => readFile(guard(path)),
      access: (path) => access(guard(path), constants.R_OK),
      detectImageMimeType: (path) => detectSupportedImageMimeTypeFromFile(guard(path)),
    },
  })

const confinedGrep = (root: string, guard: (path: string) => string) =>
  createGrepToolDefinition(root, {
    operations: {
      isDirectory: async (path) => (await stat(guard(path))).isDirectory(),
      readFile: (path) => readFile(guard(path), "utf-8"),
    },
  })

const confinedFind = (root: string, guard: (path: string) => string) =>
  createFindToolDefinition(root, {
    operations: {
      exists: (path) => pathExists(guard(path)),
      glob: findInRepository(root),
    },
  })

const confinedLs = (root: string, guard: (path: string) => string) =>
  createLsToolDefinition(root, {
    operations: {
      exists: (path) => pathExists(guard(path)),
      stat: (path) => stat(guard(path)),
      readdir: (path) => readdir(guard(path)),
    },
  })

const confinedToolFactories = { read: confinedRead, grep: confinedGrep, find: confinedFind, ls: confinedLs }

// The named read-only tools, unable to reach outside `root`. They replace pi's built-in tools of the same name.
export const confinedTools = (root: string, names: ReadonlyArray<ReadOnlyToolName>): Array<ToolDefinition> => {
  const realRoot = realpathSync(root)
  const guard = guardPath(realRoot)
  return names.map((name): ToolDefinition => confinedToolFactories[name](realRoot, guard) as ToolDefinition)
}
