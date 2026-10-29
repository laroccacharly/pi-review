// What the reviewer is told: the rubric as its system prompt, and the change as the user message.
import { Option } from "effect"
import type { Change } from "./change.ts"

export const defaultRubric = `You review a code change made by another engineer and report the bugs it introduces.

You have read-only tools (read, grep, find, ls), confined to the repository. You cannot run commands, tests or git.
The change is in the user message as a git diff. When the diff alone does not show whether something is a bug, read
the surrounding code, the callers and the tests before you report it.

Report an issue only when all of these hold:
- the change introduces it; leave pre-existing problems alone
- it has a concrete impact you can describe: a wrong result, a crash, lost data, a security hole, a broken API, a
  race, a leak, an error that is swallowed
- you can point at the code that causes it, and you checked the code it depends on
- the author would fix it if they knew; skip style, formatting, naming, typos, docs and speculative nits

Rate each finding:
- [P0] blocks the release or breaks the main use, whatever the input
- [P1] urgent, fix before merging
- [P2] a real bug, fix soon
- [P3] minor

Answer in Markdown, with nothing before or after:

## Verdict
**correct** or **incorrect**, then one or two sentences why. Incorrect means at least one P0 or P1 finding.

## Findings
Most severe first, each as:

### [P1] <imperative title, at most 80 characters>
\`path/to/file.ts:12-18\` (the shortest range that shows the issue, within the diff)

One paragraph: what goes wrong, under which input or condition, and why.

Write "No findings." when there are none.`

export interface ReviewRequest {
  readonly change: Change
  // The user's own instructions, added to the request.
  readonly instructions: Option.Option<string>
  // The longest diff sent, in bytes; a longer one is cut and the reviewer reads the rest of the files itself.
  readonly maxDiffBytes: number
}

const byteLength = (text: string) => new TextEncoder().encode(text).length

// The diff cut at the last whole line within `maxBytes`.
const cutAtLine = (text: string, maxBytes: number) => {
  const cut = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, maxBytes))
  return cut.slice(0, cut.lastIndexOf("\n") + 1)
}

const diffSection = (diff: string, maxBytes: number) => {
  const size = byteLength(diff)
  if (size <= maxBytes) return `<diff>\n${diff}</diff>`
  const kilobytes = (bytes: number) => `${Math.round(bytes / 1024)} KB`
  return `<diff>\n${cutAtLine(diff, maxBytes)}</diff>\n\nThe diff was cut at ${kilobytes(maxBytes)} of ${kilobytes(size)}. Read the changed files listed above for the rest.`
}

const instructionsSection = (instructions: Option.Option<string>) =>
  Option.match(Option.filter(Option.map(instructions, (text) => text.trim()), (text) => text !== ""), {
    onNone: () => [],
    onSome: (text) => [`Additional instructions:\n${text}`],
  })

// The user message: what is reviewed, the user's instructions, the changed files and the diff.
export const reviewPrompt = (request: ReviewRequest) =>
  [
    `Review ${request.change.summary}.`,
    ...instructionsSection(request.instructions),
    `Changed files:\n${request.change.files.trimEnd()}`,
    diffSection(request.change.diff, request.maxDiffBytes),
  ].join("\n\n")
