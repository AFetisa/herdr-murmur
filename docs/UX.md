# murmur — UX design notes and v2 plan

## What v0.1 does today

| Feature | Detail |
|---|---|
| Org chart | Workspace → agent → subagent → sub-subagent, real spawn depth from `spawnDepth` |
| Live status | `working` / `blocked` / `idle` / `done` from Herdr, push on POSIX, 1.5s poll on Windows |
| Blocked first | Blocked workspaces sort to the top, with wait age |
| Jump to agent | `⏎` focuses that pane in Herdr — a control surface, not a poster |
| Stall detector | `working` but no transcript write for 90s → `⚠ stalled` |
| Cost rollup | Per subagent → session → workspace → total, from real `usage` records |
| Context pressure | Live context vs model window, coloured at 60% / 80% |
| Instructions | `i` — exactly what each subagent was told to do |
| Memory map | `m` — CLAUDE.md chain, memory dir, `.remember/`, tool-results |
| Token detail | `t` — in/out/cache-read/cache-write rolled up |
| Zero model tokens | Herdr socket/CLI + Claude Code transcripts. No network, no keys |

## Where it sits in the market

Langfuse, LangSmith, Arize and AgentOps all instrument *an application you ship*, via an
SDK, and they agree the hard problem is **attribution** — knowing which agent or workflow
drove the spend. None of them watch the agents on your own machine, and all of them cost
tokens or money to run.

murmur's position: **zero-instrumentation observability for the agents you are running
right now.** No SDK, no exporter, no account. The data already exists on disk; murmur is
the first thing to read it as a system rather than as chat scrollback.

That position only pays off if murmur does the thing those tools do *not*: give a
**verdict**, not just a trace. Dashboards show you numbers and leave the judgement to you.
At 9 agents deep that is still cognitive load, just prettier. murmur should say
*"this subagent needs fine-tuning, and here is why."*

## UX critique of v0.1

Seven issues, worst first.

### 1. Selection is an index, not an identity — *correctness*
`state.selected` indexes a list that re-sorts on every refresh. When an agent's status
flips, rows move underneath the cursor, so the selection silently lands on a different
agent — and `⏎` then focuses the wrong pane. Selection must key on `pane_id` / `agentId`.

### 2. The header buries the only question that matters
"Do I need to do anything?" is the reason you glance at this. Today it reads
`3 agents · 0 blocked · $50.3 · 78.7M tok` — four facts of equal weight, and the one that
demands action is third. It should lead with the verdict and go quiet when the answer is
no: `all clear · 3 working · $50.3` versus `⛔ 2 NEED YOU · w4 permission · w7 question`.

### 3. Everything is always expanded
Every subagent renders forever, including ones that finished hours ago. Twenty done
subagents push the one live agent off-screen. Progressive disclosure: collapse `done`
children into a single `✓ 18 done · $12.40` line, expandable with `→`.

### 4. Colour is decoration, not signal
Cyan working, green done, yellow ctx, red pressure, plus reverse-video selection — five
colours competing, so nothing wins. Reserve **one** accent (red) exclusively for "needs
you". Everything else greyscale with glyph-encoded state. A glance should find the red.

### 5. Sorting causes jitter
Status-ordered sorting means rows jump while you are reading them. Freeze row order for
~3s after any keypress, and mark a row that wants to move rather than moving it.

### 6. No empty or first-run state
With no agents, murmur renders a header and a footer around nothing. It should say what it
is and what to do — a first impression is a feature.

### 7. Unicode assumptions
`⛔ ◆ ● ○ └─` break on Windows `cmd.exe` and older terminals. Needs an ASCII fallback,
auto-detected, overridable with `MURMUR_ASCII=1`.

## v2: the skills layer

The org chart shows *who*. It cannot yet show *what they run* — which is where sprawl
actually accumulates. All of it is recoverable from the same zero-token source, verified
against real transcripts:

| Layer | Signal in transcript |
|---|---|
| Skill | `tool_use` `{name:"Skill", input:{skill, args}}` |
| Slash command | `<command-name>/foo</command-name>` |
| MCP server | tool names prefixed `mcp__<server>__<tool>` |
| Tool mix | `tool_use` name frequency |
| Failures | `is_error:true` in tool results |

### Layered view (`l`)

Four layers, each rolling up cost and error rate from the layer below:

```
workspace → agent → subagent → skill / MCP / tool
```

### Skill lens (`s`) — the inverted index

The org chart answers "what is this agent doing". The lens answers the question you
actually have at review time: **"which of my skills and subagent types are pulling their
weight?"**

```
murmur · skill lens ─ 14 skills · 3 flagged ──────────────────────────
 SKILL / AGENT TYPE        USES   COST    ERR   AVG TOOLS   HEALTH
 general-purpose            19   $28.40   11%      47       ⚑ thrashing
 superpowers:brainstorming   6    $3.10    0%       8       ok
 firecrawl:scrape           12    $0.90   33%       3       ⚑ flaky
 claude-api                  9    $1.20    0%       2       ok
 Explore                     2    $6.80    0%      88       ⚑ expensive
```

Selecting a row lists every agent that used it, so a bad number is one keypress from the
transcript that caused it.

### Health thresholds

Defaults, all editable in `thresholds.json` — these are calibration knobs, and the right
numbers differ per person and per repo:

| Flag | Rule | Why it means "tune me" |
|---|---|---|
| `thrashing` | > 60 tool calls in one subagent | Instructions too vague; it is exploring, not executing |
| `flaky` | error rate > 20% over ≥ 5 uses | The skill's own steps are wrong or brittle |
| `looping` | same tool + same input ≥ 3 times | Stuck retrying; a guard or a better prompt is missing |
| `expensive` | > $2 for one subagent | Wrong model for the job, or scope too broad |
| `sprawl` | fan-out > 6 children, or depth ≥ 3 | Work was split past the point of benefit |
| `compacting` | context > 80% of window | Will compact and lose fidelity mid-task |
| `starved` | < 3 tool calls and cost < $0.05 | Spawned for nothing; inline it |

A flag is a **prompt to act**, not an error. Each renders with the one-line reason and the
agent that triggered it, so the fix is obvious: tighten this skill, downgrade that model,
stop spawning that subagent.

### Why this is the standout feature

Every observability tool shows spend. Almost none close the loop to *"change this
instruction"*. Because murmur can read the instructions, the tool calls, the errors and the
cost in one place, it can connect a cost number to the sentence that caused it. That is the
part worth demoing.

## Build order

| # | Task | File |
|---|---|---|
| 1 | Selection by identity | `src/app.js` |
| 2 | Skill/tool/MCP extraction + health scoring | `src/skills.js` |
| 3 | Skill lens + layered view | `src/lens.js` |
| 4 | Header verdict, collapse-done, ASCII fallback, empty state | `src/render.js` |

## Privacy

The lens shows skill names, task descriptions and paths. Fine locally; a hazard in a
screenshot or a demo. `MURMUR_REDACT=1` should blank descriptions and path tails before
this goes public.
