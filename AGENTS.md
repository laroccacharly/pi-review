# pi-review

A CLI (Bun, Effect) that reviews a git change with the pi SDK. Learn the flags from `bun pi-review --help`.

- `src/change.ts` collects the change with git (uncommitted with untracked files, `--base`, `--commit`);
  `src/prompt.ts` holds the default rubric and puts the diff in the prompt; `src/reviewer.ts` runs an in-memory
  pi session; `src/adapters/pi.ts` is the only place that calls pi's Promise API.
- The reviewer gets no bash, edit or write. `src/confine.ts` replaces pi's read, grep, find and ls with copies whose
  file operations refuse any path outside the repository once symlinks are resolved; find lists files from
  `git ls-files` instead of fd. Keep every new tool behind the same check.
- The session loads no extensions, skills or prompt templates, and only the AGENTS.md files inside the repository.
- Run `bun lint` and `bun test` after a change. The tests drive `run()` with pi's faux provider, never a real
  model.
