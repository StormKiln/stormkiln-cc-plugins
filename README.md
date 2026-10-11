# stormkiln-cc-plugins

A [Claude Code](https://claude.com/claude-code) plugin marketplace from StormKiln.

## Plugins

| Plugin | What it does |
| --- | --- |
| [context-bar](plugins/context-bar) | A stacked context-window bar above the prompt, colored like `/context`. It shows per-category and per-subagent cost estimates, warns as you approach auto-compact or high spend, and tracks when a subagent's prompt cache was rewritten. Toggle it with `/context-bar`. |

## Install

In a Claude Code terminal session:

```
/plugin install context-bar --marketplace StormKiln/stormkiln-cc-plugins
```

Answer `y` to add the marketplace, then pick the **user** scope so the plugin loads in every session.

Or from a shell:

```
claude plugin marketplace add StormKiln/stormkiln-cc-plugins
claude plugin install context-bar@stormkiln-cc-plugins
```

To update later: `claude plugin update context-bar@stormkiln-cc-plugins`, then `/reload-plugins` in any open session.

## Repository layout

```
.claude-plugin/marketplace.json   the marketplace: lists each plugin and where it lives
plugins/<name>/                   one folder per plugin, with its own README
Makefile                          make check: validate and test every plugin
.github/workflows/check.yml       runs make check on every pull request and push to main
```

## Contributing

1. Add the plugin under `plugins/<name>/` with a `.claude-plugin/plugin.json` and a README.
2. List it in `.claude-plugin/marketplace.json`.
3. Run `make check` and open a pull request. CI runs the same check with a pinned Claude Code CLI; bump `CLAUDE_CODE_VERSION` in the workflow to move it.

MIT licensed.
