// Runs the review in an in-memory pi session: the rubric as system prompt, the repository's own AGENTS.md files as
// context, the confined read-only tools and no extensions, skills or prompt templates.
import { type AgentSession, type AgentSessionEvent, type CreateAgentSessionOptions, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { Effect, Option, type Scope } from "effect"
import { loadResources, Models, openSession, prompt, ReviewError } from "./adapters/pi.ts"
import { confinedTools, isInsideRepository, type ReadOnlyToolName } from "./confine.ts"

export { Models, ReviewError }

export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>

// The arguments of a tool call that say what it looks at.
export interface ToolCallSubject {
  readonly path?: string
  readonly pattern?: string
}

export interface ReviewSettings {
  // The repository's top folder; the session runs there and the tools cannot leave it.
  readonly root: string
  // "provider/model", such as "openai/gpt-6.1-sol".
  readonly model: string
  readonly thinking: ThinkingLevel
  readonly tools: ReadonlyArray<ReadOnlyToolName>
  readonly rubric: string
  readonly prompt: string
  // Called on each tool call, for a progress line.
  readonly onToolCall: (toolName: string, subject: ToolCallSubject) => void
}

const unknownModel = (name: string) => new ReviewError({ message: `unknown model ${name}; expected provider/model, as listed by \`pi --list-models\`` })

type Model = NonNullable<CreateAgentSessionOptions["model"]>

const resolveModel: (name: string) => Effect.Effect<Model, ReviewError, Models> = Effect.fn("resolveModel")(function* (name: string) {
  const models = yield* Models
  const slash = name.indexOf("/")
  if (slash <= 0) return yield* unknownModel(name)
  const model = Option.fromNullishOr(models.getModel(name.slice(0, slash), name.slice(slash + 1)))
  if (Option.isNone(model)) return yield* unknownModel(name)
  return model.value
})

// Only what helps a review: the AGENTS.md files inside the repository (a symlink to a file outside is left out), under
// the rubric, with no APPEND_SYSTEM.md.
const reviewResources = (root: string, rubric: string, settingsManager: SettingsManager) =>
  loadResources({
    cwd: root,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: rubric,
    appendSystemPromptOverride: () => [],
    agentsFilesOverride: (base) => ({ agentsFiles: base.agentsFiles.filter((file) => isInsideRepository(root, file.path)) }),
  })

const reviewSession: (settings: ReviewSettings) => Effect.Effect<AgentSession, ReviewError, Models | Scope.Scope> = Effect.fn("reviewSession")(function* (settings: ReviewSettings) {
  const model = yield* resolveModel(settings.model)
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
  return yield* openSession({
    cwd: settings.root,
    model,
    thinkingLevel: settings.thinking,
    modelRuntime: yield* Models,
    settingsManager,
    resourceLoader: yield* reviewResources(settings.root, settings.rubric, settingsManager),
    sessionManager: SessionManager.inMemory(settings.root),
    tools: [...settings.tools],
    customTools: confinedTools(settings.root, settings.tools),
  })
})

const reportToolCalls = (onToolCall: ReviewSettings["onToolCall"]) => (event: AgentSessionEvent) => {
  if (event.type === "tool_execution_start") onToolCall(event.toolName, event.args as ToolCallSubject)
}

// The text of the session's final answer, or the model's error when the run failed.
const finalAnswer = (session: AgentSession): Effect.Effect<string, ReviewError> => {
  const last = session.messages.at(-1)
  if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    return Effect.fail(new ReviewError({ message: `the model failed: ${last.errorMessage ?? last.stopReason}` }))
  }
  const text = session.getLastAssistantText()?.trim() ?? ""
  if (text === "") return Effect.fail(new ReviewError({ message: "the model gave no review" }))
  return Effect.succeed(text)
}

// Runs the review and resolves to the reviewer's Markdown answer.
export const review: (settings: ReviewSettings) => Effect.Effect<string, ReviewError, Models> = Effect.fn("review")(function* (settings: ReviewSettings) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* reviewSession(settings)
      session.subscribe(reportToolCalls(settings.onToolCall))
      yield* prompt(session, settings.prompt)
      return yield* finalAnswer(session)
    })
  )
})
