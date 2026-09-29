# murmur — plan

A Herdr pane plugin that draws your running agents as a live org chart, with token/cost
and "who is blocking on me" surfaced. **Zero LLM tokens at runtime** — it is a local
data viewer, not an agent.

## Why it exists

Running 5–10 agents across workspaces, the human loses: who is waiting on me, who is
stalled, who spawned whom, what each one was told to do, what it has cost, and where its
memory/decisions landed. Herdr shows terminals. murmur shows the *shape of the work*.

## Zero-token guarantee

Every datum is read from local state that already exists:

| Need | Source | Cost |
|---|---|---|
| Live agents, status, workspace/tab/pane, focus | Herdr socket `session.snapshot` + `events.subscribe` | 0 |
| Subagent tree, agent type, task description, model, spawn depth | `~/.claude/projects/<proj>/<session>/subagents/agent-*.meta.json` | 0 |
| Instructions given to each agent | first `user` record of the agent's `.jsonl` | 0 |
| Tokens / cache / cost / context pressure | `message.usage` on `assistant` records | 0 |
| Current activity | last `tool_use` name + input summary in the tail | 0 |
| Memory & decision locations | CLAUDE.md chain, `~/.claude/projects/.../memory`, `.remember/`, `tool-results/` | 0 |

No network calls. No model calls. Reads are tail-biased (last N KB), so a 50 MB transcript
costs the same as a 5 KB one.

## Architecture

```
herdr pane (tab placement)
  └── node src/app.js            main loop, keys, ~150 lines
        ├── src/herdr.js         socket client: snapshot + event subscription + focus
        ├── src/claude.js        transcript scanner -> agent tree + usage
        └── src/render.js        ANSI tree renderer
      pricing.json               $/Mtok table (editable calibration knob)
```

No npm dependencies. Node only. Nothing to build → `herdr plugin install` is instant.

### Data contract (shared by all modules)

`herdr.js` emits:

```js
{ workspaces:[{id,label,number,focused,agent_status}],
  tabs:[{id,workspace_id,label,number}],
  agents:[{pane_id,tab_id,workspace_id,agent,agent_status,cwd,
           terminal_title_stripped,focused}] }
```

`claude.js` exports `scan(cwd) -> SessionNode | null`:

```js
SessionNode = {
  sessionId, projectDir, file, cwd, gitBranch, model,
  instructions,            // first user prompt, trimmed to 400 chars
  activity,                // {tool, detail, at} from tail
  usage,                   // {in,out,cacheRead,cacheWrite,cost,ctx,ctxPct}
  memory: [{kind,path}],   // CLAUDE.md chain, memory dir, .remember, tool-results
  children: [AgentNode]
}
AgentNode = {
  agentId, agentType, description, model, spawnDepth, toolUseId,
  status,                  // running | done | error  (inferred from tail)
  instructions, activity, usage, children:[]   // nested via spawnDepth/toolUseId
}
```

`render.js` exports `draw(state) -> string` (full-frame ANSI, no cursor math).

### Refresh model

- Subscribe to `pane.agent_status_changed` → instant redraw on status flips.
- Rescan transcripts on a 2 s timer, but only `stat()` first; re-read only files whose
  `mtime` moved. Idle cost ≈ one `stat` per agent per 2 s.

## Screen

```
murmur ─ 7 agents · 3 blocked · $4.18 · 312k tok ──────────────── 09:41
 w2  webapp                                    ● working
  └─ claude  m7-prep-planner                    118k ctx 59%  $1.84
     ├─ ◆ code-explorer   "Map planner impl"     sonnet  22k  $0.09  done
     ├─ ◆ general-purpose "Fix pnpm lint gate"   sonnet  14k  $0.06  ▸ Bash pnpm lint
     └─ ◆ code-reviewer   "Review m7 diff"       opus    31k  $0.71  ▸ Read src/...
 w4  infra                                           ⛔ BLOCKED 4m
  └─ claude  main                                 41k ctx 20%  $0.32
     └─ waiting: permission — Bash(git push)
 w6  docs-site                                            ○ idle 22m
```

Keys: `↑↓` select · `⏎` focus that pane in Herdr · `i` instructions · `m` memory paths ·
`t` token detail · `r` force rescan · `q` quit.

## Features beyond the ask (the ones that earn their place)

1. **Blocked-first ordering + age.** Blocked agents sort to the top with how long they
   have been waiting. This is the actual daily pain.
2. **Jump-to-agent.** `⏎` calls `agent.focus` over the socket — the map becomes a control
   surface, not a poster.
3. **Stall detector.** Status `working` but transcript mtime unchanged > 90 s → `⚠ stalled`.
   Catches the hung-tool case that silently eats an afternoon.
4. **Context pressure.** `cache_read + input` vs the model's window → "who compacts next".
5. **Cost rollup.** Per agent → per session → per workspace → total, plus `$/hr` burn.
6. **Memory map.** Per agent: which CLAUDE.md files are in force, where memory and
   tool-results land. Answers "where did that decision go".

Deliberately skipped: web UI, history/graphs over time, multi-machine. Add when v1 proves
the shape.

## Build order (subagent-parallel)

| Task | File | Depends on |
|---|---|---|
| A | `src/herdr.js` | contract only |
| B | `src/claude.js` + `pricing.json` | contract only |
| C | `src/render.js` | contract only |
| D | `src/app.js`, `herdr-plugin.toml`, `README.md` | A+B+C |

A, B, C run in parallel against the contract above; D wires them.

## Testing

`node src/app.js` runs standalone outside Herdr (falls back to `herdr api snapshot`).
Each module ships a `--selftest` assert block run by `npm test` (no framework).
Install for real with `herdr plugin link /absolute/path/to/herdr-murmur`.

## Publishing

Public repo `AFetisa/herdr-murmur`, tagged with the GitHub topic `herdr-plugin` so Herdr's
plugin marketplace can index it. Installs with `herdr plugin install AFetisa/herdr-murmur`.
