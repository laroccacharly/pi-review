# pi-review

Reviews a git change with [pi](https://pi.dev): the diff goes in the prompt, and the reviewer reads the rest of the
repository with read-only tools (read, grep, find, ls) that cannot leave it. It prints the review as Markdown.

## Requirements

- [Bun](https://bun.sh)
- git
- pi credentials for the reviewer's model in `~/.pi/agent` (`pi` then `/login`)

## Installation

From this folder:

```sh
bun install
bun link
pi-review --help
```
