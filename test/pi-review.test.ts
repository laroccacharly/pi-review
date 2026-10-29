// Runs the pi-review command on throwaway git repositories, with a scripted model in place of pi's real ones.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { run } from "../src/cli.ts"
import { Models } from "../src/reviewer.ts"

const scratch = mkdtempSync(join(tmpdir(), "pi-review-test-"))
const secret = join(scratch, "secret.txt")
writeFileSync(secret, "TOP-SECRET\n")
const agentDir = join(scratch, "agent")
process.env["PI_CODING_AGENT_DIR"] = agentDir
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const sh = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(args, { cwd, stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`)
}

const write = (repo: string, file: string, text: string) => writeFileSync(join(repo, file), text)

const commitAll = (repo: string, message: string) => {
  sh(repo, "git", "add", "-A")
  sh(repo, "git", "commit", "-q", "-m", message)
}

// A repository on main with one commit: src/app.ts and an AGENTS.md.
let repo = ""
beforeEach(() => {
  repo = mkdtempSync(join(scratch, "repo-"))
  sh(repo, "git", "init", "-q", "-b", "main")
  sh(repo, "git", "config", "user.email", "test@example.com")
  sh(repo, "git", "config", "user.name", "Test")
  sh(repo, "mkdir", "src")
  write(repo, "src/app.ts", "export const answer = 42\n")
  write(repo, "AGENTS.md", "REPO-RULE: money is in cents.\n")
  commitAll(repo, "Start the app")
  sh(scratch, "mkdir", "-p", agentDir)
  writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL-RULE: open files in Zed.\n")
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL-APPEND: be terse.\n")
})

const reply = (text: string) => fauxAssistantMessage(text)
const toolCalls = (...calls: Array<[string, Record<string, string>]>) =>
  fauxAssistantMessage(
    calls.map(([name, args]) => fauxToolCall(name, args)),
    { stopReason: "toolUse" }
  )

const fauxModelUnlessChosen = (args: Array<string>) => {
  if (args.includes("--model")) return []
  return ["--model", "faux/faux-1"]
}

// Runs pi-review with `args`; the model answers with `steps` in order. Resolves to what it printed and to each
// request the model got, as JSON.
const review = async (args: Array<string>, steps: Array<AssistantMessage>) => {
  const faux = fauxProvider()
  const requests: Array<string> = []
  faux.setResponses(
    steps.map(
      (step): FauxResponseStep =>
        (context) => {
          requests.push(JSON.stringify(context.messages))
          return step
        }
    )
  )
  const models = await ModelRuntime.create({ authPath: join(scratch, "auth.json"), modelsPath: join(scratch, "models.json") })
  models.registerNativeProvider(faux.provider)
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...parts: Array<string>) => stdout.push(parts.join(" ")),
    error: (...parts: Array<string>) => stderr.push(parts.join(" ")),
  })
  const program = run(["--path", repo, ...fauxModelUnlessChosen(args), ...args]).pipe(
    Effect.provide(Layer.mergeAll(Layer.succeed(Models, models), BunServices.layer)),
    Effect.provideService(Console.Console, console)
  )
  const exit = await Effect.runPromiseExit(program)
  return { exit, stdout: stdout.join("\n"), stderr: stderr.join("\n"), requests }
}

const failureMessage = async (args: Array<string>, steps: Array<AssistantMessage> = []) => {
  const { exit } = await review(args, steps)
  if (exit._tag === "Success") throw new Error("expected the review to fail")
  return JSON.stringify(exit.cause)
}

describe("pi-review", () => {
  test("reviews the uncommitted changes, untracked files included, and prints the model's answer", async () => {
    write(repo, "src/app.ts", "export const answer = 43\n")
    write(repo, "src/new.ts", "export const added = true\n")
    const result = await review(["focus on the answer"], [toolCalls(["read", { path: "src/app.ts" }]), reply("## Verdict\n**correct**")])

    expect(result.stdout).toBe("## Verdict\n**correct**")
    const [first, second] = result.requests
    expect(first).toContain("Review the uncommitted changes")
    expect(first).toContain("focus on the answer")
    expect(first).toContain("+export const answer = 43")
    expect(first).toContain("src/new.ts (untracked)")
    expect(first).toContain("+export const added = true")
    expect(first).toContain("You review a code change")
    expect(first).toContain("REPO-RULE")
    expect(first).not.toContain("GLOBAL-RULE")
    expect(first).not.toContain("GLOBAL-APPEND")
    expect(second).toContain("export const answer = 43")
    expect(result.stderr).toContain("  read src/app.ts")
  })

  test("keeps every tool inside the repository", async () => {
    symlinkSync(secret, join(repo, "link.txt"))
    write(repo, "src/app.ts", "export const answer = 43\n")
    const result = await review(
      [],
      [
        toolCalls(
          ["read", { path: secret }],
          ["read", { path: "link.txt" }],
          ["read", { path: "../secret.txt" }],
          ["ls", { path: ".." }],
          ["grep", { pattern: "TOP-S.CRET", path: ".." }],
          ["find", { pattern: "*.txt", path: ".." }],
          ["find", { pattern: "*.ts" }]
        ),
        reply("No findings."),
      ]
    )

    expect(result.stdout).toBe("No findings.")
    const toolResults = result.requests[1] ?? ""
    expect(toolResults).not.toContain("TOP-SECRET")
    expect(toolResults).toContain("only files in the repository can be read")
    expect(toolResults).toContain("src/app.ts")
  })

  test("leaves out an AGENTS.md that links outside the repository", async () => {
    writeFileSync(join(scratch, "outside-agents.md"), "OUTSIDE-RULE\n")
    rmSync(join(repo, "AGENTS.md"))
    symlinkSync(join(scratch, "outside-agents.md"), join(repo, "AGENTS.md"))
    const result = await review([], [reply("No findings.")])

    expect(result.requests[0]).not.toContain("OUTSIDE-RULE")
  })

  test("reviews the first files of a repository with no commit yet", async () => {
    const fresh = mkdtempSync(join(scratch, "fresh-"))
    sh(fresh, "git", "init", "-q", "-b", "main")
    write(fresh, "first.ts", "export const first = 1\n")
    sh(fresh, "git", "add", "first.ts")
    write(fresh, "second.ts", "export const second = 2\n")
    repo = fresh
    const result = await review([], [reply("No findings.")])

    expect(result.requests[0]).toContain("+export const first = 1")
    expect(result.requests[0]).toContain("+export const second = 2")
  })

  test("reviews a commit", async () => {
    write(repo, "src/app.ts", "export const answer = 7\n")
    commitAll(repo, "Change the answer")
    const result = await review(["--commit", "HEAD"], [reply("No findings.")])

    expect(result.requests[0]).toContain("Review the changes of commit")
    expect(result.requests[0]).toContain("Change the answer")
    expect(result.requests[0]).toContain("+export const answer = 7")
  })

  test("reviews a branch against its base, uncommitted changes included", async () => {
    sh(repo, "git", "checkout", "-q", "-b", "feature")
    write(repo, "src/app.ts", "export const answer = 7\n")
    commitAll(repo, "Change the answer")
    write(repo, "src/app.ts", "export const answer = 8\n")
    const result = await review(["--base", "main"], [reply("No findings.")])

    expect(result.requests[0]).toContain("Review the changes against main")
    expect(result.requests[0]).toContain("+export const answer = 8")
  })

  test("cuts a diff longer than --max-diff-kb", async () => {
    write(repo, "src/big.ts", "export const line = 1\n".repeat(200))
    const result = await review(["--max-diff-kb", "1"], [reply("No findings.")])

    expect(result.requests[0]).toContain("The diff was cut at 1 KB")
  })

  test("fails without calling the model when there is nothing to review", async () => {
    expect(await failureMessage([])).toContain("nothing to review")
  })

  test("fails on an unknown model", async () => {
    write(repo, "src/app.ts", "export const answer = 43\n")
    expect(await failureMessage(["--model", "nowhere/none"])).toContain("unknown model nowhere/none")
  })

  test("fails with the model's error", async () => {
    write(repo, "src/app.ts", "export const answer = 43\n")
    const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })
    expect(await failureMessage([], [failed])).toContain("the model failed: invalid request")
  })

  test("refuses --base with --commit", async () => {
    expect(await failureMessage(["--base", "main", "--commit", "HEAD"])).toContain("use --base or --commit, not both")
  })
})
