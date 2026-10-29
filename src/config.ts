// The user's settings for pi-review, in $XDG_CONFIG_HOME/pi-review/config.json, or ~/.config/pi-review/config.json
// when it is not set.
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, type FileSystem, Option, Schema } from "effect"
import * as JsonStore from "effect-lib/json-store"

export { JsonStoreError } from "effect-lib/json-store"

export const defaultModel = "openai/gpt-6.1-sol"

export const PiReviewConfig = Schema.Struct({
  // The reviewer when --model is not given, as provider/model.
  model: Schema.optionalKey(Schema.String),
})

const configPath = () => join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "pi-review", "config.json")

// The config file, with `pi-review config get | set | unset | list` to change it.
export const configStore = () => JsonStore.make(configPath(), PiReviewConfig)

// The model from --model, else the config's, else the default.
export const chosenModel: (flag: Option.Option<string>) => Effect.Effect<string, JsonStore.JsonStoreError, FileSystem.FileSystem> = Effect.fn("chosenModel")(function* (flag: Option.Option<string>) {
  if (Option.isSome(flag)) return flag.value
  const config = yield* configStore().load
  return Option.flatMap(config, (value) => Option.fromUndefinedOr(value.model)).pipe(Option.getOrElse(() => defaultModel))
})
