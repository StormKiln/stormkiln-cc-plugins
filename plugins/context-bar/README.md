# context-bar

`context-bar` draws your context window as a stacked bar above the Claude Code prompt. Each category gets its own color, the same as `/context`. Beside the bar it shows what the context costs, how close you are to auto-compact, and how much each subagent costs, including when a subagent's prompt cache had to be written again.

```
█████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒ 60k/200k · 39% of compact
■ Messages 38k $0.008  ■ MCP tools 18k $0.004  ■ System prompt 4k $0.001  per request
$1.25 session (API billing) · main ~$0.92 · 1 subagent ~$0.33 · next request $0.01 warm / $0.30 cold · 88% cached · ⟳1 cache rewrite +$0.15 · cache warm 3m of 5m (usual for this billing)
  ● Explore: find auth code  █░░░░░░░ 31.2k ctx · 2 req · ~$0.33 · 5m cache · ⟳1 rewrite +$0.15 (last 1m ago: idle 7m, 31k)
→ MCP tools hold 18k ($0.004/request). Disable servers you are not using in /mcp.
→ Subagent "find auth code" rewrote 31k of cache (+$0.15) after 7m between requests. Keep slow commands and waits out of subagents, or resume them sooner.
```

## Install

```
/plugin install context-bar --marketplace StormKiln/stormkiln-cc-plugins
```

Answer `y` to add the marketplace, then choose the **user** scope so it loads in every session. The bar appears after your next turn.

## Use

| Command | Effect |
| --- | --- |
| `/context-bar` | Toggle the bar on or off in every session. Sessions that are already open follow within 15 seconds. |
| `/context-bar on` / `off` | Show or hide it explicitly, in every session. |
| `/context-bar on --here` / `off --here` | Show or hide it in this session only. This session then ignores the shared setting until you run `/context-bar on` or `off` without `--here`. |
| `/context-bar reset` | Zero the cost and cache counters, for example before measuring one task. |

Collapse the band for a moment with `ctrl+x ctrl+a`, or the `[-]` mark beside it.

## What each row means

1. **Bar.** The main conversation's window as `/context` breaks it down. `█` is used, `░` is free, and `▒` is the auto-compact buffer. The right side shows tokens used against the window and how far you are toward auto-compact. It turns yellow at the warning threshold and red at 95%.
2. **Legend.** Each category, largest first, with what it costs per request at cache-read prices. Use it to spot fixed overhead such as MCP tool schemas, memory files and skills, which you pay on every request.
3. **Money.**
   - **session** is Claude Code's own running total, the same as `/cost`. It is labelled **API billing** when you pay per token, and **subscription: API-price equivalent** on Pro or Max, where the dollars measure usage rather than a bill.
   - **main** and **subagents** are this plugin's estimates for each loop.
   - **next request** is what re-sending the current context costs with a warm cache and with a cold one.
   - **% cached** is how much of the input came from the prompt cache.
   - **⟳ cache rewrites** shows how many rewrites happened and what they cost beyond a cache read.
   - **cache warm Nm of 5m/1h** counts down to when the main cache expires, followed by where that lifetime came from (see [Cache lifetime](#cache-lifetime)).
4. **Subagents.** One line per subagent: running (`●`) or done (`✓`), its type and task, how much of a window its context fills, requests made, estimated cost, its cache lifetime, and cache rewrites with the cause of the last one.
5. **Advice.** The one or two most useful things to change right now, most urgent first.

## Cache rewrites

Each loop (the main conversation and each subagent) gets its own prompt cache. A request that writes back most of what the loop had cached, instead of reading it, counts as a **cache rewrite**. You pay the write price, which is 1.25× input for the 5-minute TTL or 2× for 1 hour, instead of the read price, which is about 0.05–0.1× input. Every rewrite is labeled with its likely cause:

| Cause | What happened | What to do |
| --- | --- | --- |
| `idle Nm` | More than the cache TTL passed between two requests. | Reply sooner. Keep long waits and slow commands out of subagents. |
| `model switch` | The loop changed model, and caches are per model. | Switch models at task boundaries. |
| `compaction` | The conversation was summarized, so the prefix is new. | Compact at task boundaries, not mid-task. |
| `prompt prefix changed` | Tools, MCP servers, settings or the system prompt changed. | Avoid toggling those mid-task. |

A subagent's first request always writes its cache. That write is not counted as a rewrite.

## Cache lifetime

How long a cache lasts changes both the price of writing it (1.25× input for 5 minutes, 2× for an hour) and when it goes cold. It depends on how you are billed and can differ between the main conversation and subagents, so the plugin works it out for each loop. The first matching row wins:

| Source | Shown as | When it applies |
| --- | --- | --- |
| The `cacheTtl` setting is `5m` or `1h` | `set in /config` | Always, for every loop. |
| Claude Code reports the lifetime | `reported by Claude Code` | The main conversation, after a model switch. |
| The subagent's final usage | `from the subagent's usage` | A subagent, once it finishes: its usage splits cache writes by lifetime. |
| A cache read more than 5 minutes after the previous request | `seen in a cache read` | Any loop: that can only happen with a 1-hour cache. |
| Your billing type | `usual for this billing` | Subscription: 1 hour for the main conversation, 5 minutes for subagents. Per-token billing: 5 minutes. |
| Nothing known yet | `assumed` | 5 minutes, until the first response. |

The billing type comes from the usage windows Claude Code reports: a subscription login reports five-hour and seven-day windows, and per-token billing (an API key, Bedrock, Vertex or a gateway) does not. When a loop's lifetime changes, its cost so far is re-priced.

## Warnings

A toast appears once each time one of these thresholds is crossed:

- context reaches the compaction warning share of the auto-compact threshold (80% by default), and again at 95%
- re-sending the context on a cold cache would cost more than the per-request threshold
- the session's total cost passes the session threshold, and again at each doubling
- any loop rewrites its cache for more than $0.05 extra

## Settings

These settings are in `/config` under the plugin, or in `settings.json` under `pluginConfigs["context-bar"].options`:

| Option | Default | Meaning |
| --- | --- | --- |
| `sessionCostWarnUsd` | `10` | Session cost warning, repeated at each doubling. |
| `requestCostWarnUsd` | `0.5` | Warn when one cold-cache request would cost more than this. |
| `compactWarnPercent` | `80` | Warn at this share of the auto-compact threshold. |
| `cacheTtl` | `auto` | `auto`, `5m` or `1h`. `auto` works the lifetime out per loop (see [Cache lifetime](#cache-lifetime)); the others force it for every loop. |
| `maxSubagentRows` | `4` | Most subagent lines shown. Running agents come first. |

## How costs are estimated

- The **session** figure comes from Claude Code itself. Every other dollar figure multiplies the API's reported token counts (`input`, `output`, `cache_read`, `cache_creation`) by Anthropic first-party list prices. The table is in [`hooks/pricing.ts`](hooks/pricing.ts) and was last updated 2026-10-06.
- Per-category and next-request costs come from `/context`'s token estimates at the main model's prices.
- On a Pro or Max subscription you are not billed per token. Read the figures as relative weight, which still shows what is driving your usage limits.
- Bedrock, Vertex and gateway pricing differ. Update `pricing.ts` if you need exact figures there.
- Each request's usage does not say which lifetime its cache writes used, so they are priced at the loop's lifetime as worked out above and re-priced if that changes.
- Managed setups can set their own per-model prices (`modelPricing`). Claude Code's session total uses them; this plugin's other figures use list prices.
- The Claude Haiku 5.5 cache-read rate is assumed at 0.1× input. The published table did not list it.

## Develop

```
make check                      # validate and run tests for every plugin
make dev PLUGIN=context-bar     # a session with this checkout loaded, reloading on save
```

The plugin is a Claude Code hooks module. [`hooks/register.tsx`](hooks/register.tsx) wires the events and draws the band. [`hooks/logic.ts`](hooks/logic.ts) holds the pure arithmetic: bar layout, rewrite detection, advice and warnings. [`tests/`](tests) runs under `claude plugin test`.
