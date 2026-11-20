# codegraph-worktree

Makes [CodeGraph](https://github.com/colbymchenry/codegraph) work in git worktrees.

CodeGraph keeps its index in `.codegraph/` at the root of a working tree, and git does not carry it into a new worktree. A worktree outside the main tree then has no index at all; one nested inside it (Claude Code's `.claude/worktrees/<name>`) silently gets answers from the main tree's index, which describes another branch.

When a Claude Code session starts in a directory, enters a worktree (`EnterWorktree`), changes directory, or starts a subagent in its own worktree, this plugin:

1. **Copies the index into a worktree that has none.** It takes `.codegraph/` from the main working tree (or another worktree of the same repository), copy-on-write where the file system allows it, checks the copy with SQLite, places it in one atomic rename, and runs `codegraph sync` in the background so the index matches the worktree's branch. If the session ends before the sync finishes, the next session finishes it.
2. **Indexes a repository that has no index.** Where no index exists to copy, it runs `codegraph init -y` in the background.
3. **Recommends installing CodeGraph** when it is not installed (at most once a day).

It also tells Claude which `projectPath` to pass to the CodeGraph tools in a worktree, so results come from that worktree's own index.

A tree that already has an index is never touched: the check is one `git rev-parse` and a file lookup, a few milliseconds.

## Copy-on-write

| Platform | How the index is copied |
| --- | --- |
| macOS (APFS) | `clonefile` through `cp -c`: instant, no extra disk space |
| Linux (btrfs, XFS, bcachefs) | `FICLONE` reflink: instant, no extra disk space |
| Windows (ReFS / Dev Drive) | `CopyFile`, which block-clones on ReFS |
| anything else | an ordinary copy, only when at least twice the index's size is free |

The copy runs on the Node runtime CodeGraph ships with (or `node` on PATH, for an npm install). Only `codegraph.db`, its WAL and `.gitignore` are copied, never the source tree's pid, socket, lock or log files. The copy is refused, and nothing is written, while a `codegraph index` rebuild of the source is running, or if the source keeps changing during the copy; then the plugin falls back to `codegraph init` in the worktree.

## Settings

Set in `/plugin` → codegraph-worktree → configure:

| Option | Default | What it does |
| --- | --- | --- |
| Copy the index into worktrees | on | Off: a worktree without an index is indexed from scratch instead. |
| Index repositories that have none | on | Off: nothing runs `codegraph init`; only copies happen. |

## Requirements

- CodeGraph installed and on PATH (`codegraph --version`). Install it with the [CodeGraph installer](https://github.com/colbymchenry/codegraph), then run `codegraph install` to connect it to Claude Code.
- git 2.31 or newer.
- For an npm install of CodeGraph: Node 22.13 or newer on PATH.

## Troubleshooting

`claude --debug` logs each step as `codegraph-worktree: ...`. To re-copy a worktree's index, delete its `.codegraph/` and start a new session there.
