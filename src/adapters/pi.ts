// The pi SDK as Effects: its models, the resources a session loads and the session itself.
import {
  type AgentSession,
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import { Context, Effect, Layer, Schema, type Scope } from "effect"

export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

const failure =
  (what: string) =>
  <E>(error: E) =>
    new ReviewError({ message: `${what}: ${String(error)}` })

// pi's models and credentials: the user's own (~/.pi/agent) when live, a scripted model in tests.
export class Models extends Context.Service<Models, ModelRuntime>()("pi-review/Models") {
  static readonly layer: Layer.Layer<Models, ReviewError> = Layer.effect(Models, Effect.tryPromise({ try: () => ModelRuntime.create(), catch: failure("cannot load pi's models") }))
}

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

// A resource loader with its AGENTS.md files, prompts and the rest read from disk.
export const loadResources = (options: ResourceLoaderOptions): Effect.Effect<DefaultResourceLoader, ReviewError> => {
  const loader = new DefaultResourceLoader(options)
  return Effect.tryPromise({ try: () => loader.reload(), catch: failure("cannot load the session's resources") }).pipe(Effect.as(loader))
}

// A session that is disposed when the scope closes.
export const openSession = (options: CreateAgentSessionOptions): Effect.Effect<AgentSession, ReviewError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => createAgentSession(options), catch: failure("cannot start the pi session") }).pipe(Effect.map(({ session }) => session)),
    (session) => Effect.sync(() => session.dispose())
  )

// Sends `text` and resolves once pi has nothing more to do.
export const prompt = (session: AgentSession, text: string): Effect.Effect<void, ReviewError> =>
  Effect.tryPromise({ try: () => session.prompt(text), catch: failure("the review failed") })
