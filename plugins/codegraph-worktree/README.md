# codegraph-worktree

Makes [CodeGraph](https://github.com/colbymchenry/codegraph) work in git worktrees.

CodeGraph keeps its index in `.codegraph/` at the root of a working tree, and git does not carry it into a new worktree. A worktree outside the main tree then has no index at all; one nested inside it (Claude Code's `.claude/worktrees/<name>`) silently gets answers from the main tree's index, which describes another branch.

When a Claude Code session starts, enters or leaves a worktree (`EnterWorktree`, `ExitWorktree`), changes directory (`/cd`), or starts a subagent, this plugin:

1. **Copies the index into a worktree that has none.** It takes the index from the main working tree (or another worktree of the same repository), copy-on-write where the file system allows it, checks the copy with SQLite, and places it without ever replacing anything. Then it runs `codegraph sync` in the background so the index matches the worktree's branch. If the session ends before that sync finishes, the next session finishes it.
2. **Indexes a repository that has no index.** Where nothing can be copied, it starts `codegraph init -y` in the background, detached so it keeps going after a short session ends (on Windows it runs with the session).
3. **Repairs an unfinished index.** An index whose last run was killed, dropped files or failed, or that SQLite cannot read, is rebuilt with `codegraph index` in the background, at most every six hours per tree and never while CodeGraph is writing it.
4. **Recommends installing CodeGraph** when it is not installed (at most once a day).

It also tells Claude which `projectPath` to pass to the CodeGraph tools in a worktree, so results come from that worktree's own index, and tells it to stop when the session leaves the worktree.

## Cost

In a tree that already has an index, a session start runs one `git rev-parse` (about 20 ms) and, in the background, one quick read of the index's state by a short Node process. Nothing else runs unless something needs fixing.

## Copy-on-write

| Platform | How the index is copied |
| --- | --- |
| macOS (APFS) | `clonefile` through `cp -c`: instant, no extra disk space |
| Linux (btrfs, XFS, bcachefs) | `FICLONE` reflink: instant, no extra disk space |
| Windows (ReFS / Dev Drive) | `CopyFile`, which block-clones on ReFS |
| anything else | an ordinary copy, only when at least twice the index's size is free |

The copy runs on the Node runtime CodeGraph ships with (or `node` on PATH, for an npm install). Only `codegraph.db`, its WAL and `.gitignore` are read from the source, never its pid, socket, lock or log files, and nothing in the source is written. No copy is taken while CodeGraph is writing the source (an init, a sync, a rebuild) or while it keeps changing; that worktree is tried again a little later and then next session. A source whose index is unfinished is not copied at all: the worktree gets its own `codegraph init` instead. A copy that fails is retried next session, and only a second failure falls back to `codegraph init`.

## Safety

- A tree that already has an index is never written to, except by the CodeGraph commands named above.
- The copy is built in a temporary folder inside the worktree's own git directory (beside the worktree only when that is on another disk, hidden from git either way), folded into one file, and placed with a hard link that fails rather than replace a database another process placed first.
- Commands are run by absolute path, found on absolute PATH entries only, so a checkout cannot plant its own `git`, `codegraph` or `cmd.exe`. On Windows CodeGraph is started as Node on its own entry script, not through `cmd.exe`, wherever that script can be found.
- It never runs CodeGraph where CodeGraph itself refuses to: the home directory or a parent of it, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, system folders, network paths, or Windows drives under WSL.

## Settings

Set in `/plugin` → codegraph-worktree → configure:

| Option | Default | What it does |
| --- | --- | --- |
| Copy the index into worktrees | on | Off: a worktree without an index is indexed from scratch instead. |
| Index repositories that have none | on | Off: nothing runs `codegraph init`; only copies happen. |

## Requirements

- CodeGraph installed and on PATH (`codegraph --version`). Install it with the [CodeGraph installer](https://github.com/colbymchenry/codegraph), then run `codegraph install` to connect it to Claude Code.
- git 2.13 or newer.
- For an npm install of CodeGraph: Node 22.13 or newer on PATH.
- `CODEGRAPH_DIR`, if you set it, is honoured.

## Troubleshooting

`claude --debug` logs each step as `codegraph-worktree: ...`. To re-copy a worktree's index, delete its `.codegraph/` and start a new session there.
