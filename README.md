# murmur

A [Herdr](https://herdr.dev) plugin that shows your running AI coding agents as a live org chart. It shows who spawned whom, what each agent was told, what it has cost by model, what it carried into context, and which agents are waiting on you. You can answer or interrupt them without leaving the tab.

Herdr shows you terminals. murmur shows you the shape of the work.

```
⛔ 1 NEED YOU · w4 Bash git push ──────── opus-5.5 $2.55 · sonnet-5 $0.47  09:41
                                      STATUS        MODEL      TOKENS  COST │ ◆ SUBAGENT  general-purpose
▣ w4  infra                           ⛔ BLOCKED 4m               41k $0.32 │ "Fix lint gate"
└─ ◉ claude  main                     ⛔ wait 4m    sonnet-5  41k 20% $0.32 │ spawned by claude · release-prep
   └─ waiting: Bash git push                                                │ model      claude-sonnet-5 · Anthropic
▣ w2  webapp                          ● working                  186k $2.71 │ definition built-in (Claude Code)
└─ ◉ claude  release-prep             ● working     opus-5.5 118k 59% $2.71 │ CONTEXT LOAD  ~48k tok before any work
   ├─ ◆ general-purpose "Fix lint…"   ▸ Bash        sonnet-5     14k $0.06 │ ████████████████████████████████
   ├─ ◆ code-reviewer "Review diff"   ▸ Read        opus-5.5     31k $0.71 │ INSTRUCTION FILES (2) ───────────
   └─ ✓ 1 done  →                                                   $0.09 │ User     ~/.claude/CLAUDE.md  ~2k tok
```

- **Runs locally and costs nothing.** murmur never calls a model or the network. It reads state already on your disk: Herdr's API and Claude Code's own session transcripts.
- **Pure Node, no dependencies.** Nothing to `npm install` and no build step.
- **Works on Windows, macOS and Linux.**

## Requirements

- [Herdr](https://herdr.dev) 0.7.0 or newer
- Node.js 18 or newer on your `PATH`
- [Claude Code](https://claude.com/claude-code) running in your Herdr panes. Other agents appear in the tree, but only Claude Code writes the transcripts murmur reads usage from.

## Installation

### From GitHub (recommended)

```sh
herdr plugin install AFetisa/herdr-murmur
```

To pin a release or branch, add `--ref <tag-or-branch>`.

### From a local clone (for hacking on it)

```sh
git clone https://github.com/AFetisa/herdr-murmur
herdr plugin link /absolute/path/to/herdr-murmur
```

A linked plugin runs straight from your clone. Edits take effect the next time you open the pane.

### Check it installed

```sh
herdr plugin list
# portablelabs.murmur (murmur) enabled
```

### Open it

Open **murmur** from Herdr's plugin menu, or run:

```sh
herdr plugin pane open --plugin portablelabs.murmur --entrypoint murmur --placement tab
```

### Update and uninstall

```sh
herdr plugin uninstall portablelabs.murmur && herdr plugin install AFetisa/herdr-murmur   # update to the latest version
herdr plugin disable portablelabs.murmur                  # turn it off, keep it installed
herdr plugin uninstall portablelabs.murmur                # remove (use `unlink` for a linked clone)
```

If you change `herdr-plugin.toml` in a linked clone, run `unlink` then `link` again. Herdr caches the manifest when the plugin is linked.

## Using it

| Key | Action |
|---|---|
| `↑` `↓` | Select a project, agent or subagent |
| `⏎` | Jump to that agent's pane in Herdr |
| `y` / `n` | Approve / deny a blocked agent's prompt (asks you to confirm) |
| `x` | Interrupt a working agent (asks you to confirm) |
| `→` `←` | Expand / collapse finished subagents |
| `i` / `t` | Briefing panel / tokens-by-model panel |
| `[` `]` | Scroll the panel |
| `c` | Context view: instruction files and hooks across all agents |
| `s` | Skill lens: skills, subagent types, MCP servers and commands, ranked |
| `u` | Inventory: installed plugins, MCP servers and connectors, and whether they are used |
| `r` / `q` | Rescan / quit |

At 120 columns or wider, the briefing panel sits beside the tree and follows your selection.

## Features

| | |
|---|---|
| **Org chart** | Project → agent → subagent → sub-subagent, with real spawn depth and aligned status, model, token and cost columns |
| **Waiting on you first** | Blocked agents sort to the top with how long they have waited, and the header says how many need you |
| **Cost by provider and model** | Every turn is priced at its own model's rate, then rolled up per subagent, session, project and in total. The header shows the model mix |
| **Briefing** | For any row: who spawned it, its model, the `.md` file that defines it, the instruction files loaded into its context (from Claude Code's own record), skills available and used, health warnings, cost by model and the full task prompt |
| **Context load** | A stacked bar of what an agent carried before doing any work: tool schemas, instruction files, skill list, agent list, MCP instructions, deferred tools, hook-injected text and the task |
| **Context view (`c`)** | The reverse lookup across all agents. Each instruction file shows how many agents loaded it and its total tokens; each hook shows runs, time, injected text, errors and timeouts |
| **Answer and interrupt** | A blocked agent's briefing shows its actual screen, so you see the exact prompt. `y`, `n` and `x` act on it after a second confirming `y` |
| **Health verdicts** | `thrashing`, `flaky`, `looping`, `expensive`, `sprawl`, `compacting` and `starved`, each showing the number that triggered it |
| **Stall detector** | An agent marked working with no transcript writes for 90 s shows as `⚠ stalled` |
| **Skill lens and inventory** | What you actually use, and what you carry for nothing |
| **ASCII mode** | `MURMUR_ASCII=1` for terminals without Unicode; `NO_COLOR=1` for monochrome |

## Privacy and safety

murmur is a local viewer. Here is exactly what it touches.

**It reads:**
- Herdr's local API: the pane list, statuses and titles.
- Claude Code's transcripts and subagent metadata under `~/.claude/projects/`.
- Instruction files and agent definitions under your project and `~/.claude/`.
- The visible screen of a pane, but only when that agent is waiting on a prompt.

**It never:**
- makes network requests or calls a model
- writes to your projects, transcripts or Claude Code settings
- sends keys to an agent unless you press `y`, `n` or `x` **and then confirm with `y`**

**Keys it can send**, through Herdr's own `herdr pane send-keys`:

| Action | Sends | When |
|---|---|---|
| Approve | `1` | Only while that agent is showing a prompt |
| Deny | Esc | Only while that agent is showing a prompt |
| Interrupt | Esc | Only while that agent is working |

The agent's status is checked again at the moment of sending. If it has moved on, nothing is sent.

**Untrusted text is sanitised.** Transcripts and screens can contain text from anywhere, such as web pages an agent fetched. murmur strips every terminal escape sequence and control character except its own colour codes before drawing. Transcript content cannot move your cursor, rename your window or write to your clipboard.

**Watch what you share.** The briefing shows full task prompts and file paths. Treat a screenshot or screen share of murmur like one of your agent's terminal.

Its only file write is a small inventory cache in Herdr's plugin state directory, or your OS temp directory when running outside Herdr.

## Configuration

| File / variable | Purpose |
|---|---|
| `pricing.json` | $ per million tokens and context window per model family. Update it for your rates and plan |
| `thresholds.json` | Health-verdict thresholds |
| `MURMUR_ASCII=1` | ASCII-only drawing |
| `NO_COLOR=1` | Monochrome output |
| `HERDR_BIN_PATH` | Path to the `herdr` binary if it is not on your `PATH` |

## What the numbers mean

- **Token counts and subagent costs are measured** from Claude Code's usage records.
- **Context-load sizes are estimates** at 4 characters per token, shown with a `~`.
- **Skill, MCP and slash-command costs are estimates**, also shown with a `~`. They run inside an agent, so they get a share of that agent's cost in proportion to their tool calls. murmur never raises a health flag from an estimate.
- **Inventory verdicts are conservative**, because acting on them means removing things:
  - `never used` needs a zero count and no last-used timestamp.
  - `orphaned` needs positive evidence that the plugin is gone.
  - Rows with ambiguous evidence are dropped rather than guessed at.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The tab opens and closes at once | Run `node src/app.js --once` in the plugin folder to see the error. Check `herdr plugin log list` |
| Tab crashes on Windows with `EISDIR: lstat 'C:'` | Fixed in the manifest (`--preserve-symlinks` flags). Update the plugin, or `unlink` and `link` again after pulling |
| Status lags by about a second on Windows | Expected. Windows polls every 1.5 s (see below) |
| Two panes show the same cost | They share a folder and have near-identical titles; see "Pane-to-session matching" below |
| Garbled boxes | `MURMUR_ASCII=1` |
| Costs look wrong | Update `pricing.json` for your rates |

## Known limits

- **Herdr can miss a permission prompt.** Herdr 0.7.5 reports a pane sitting on a Claude Code permission dialog as `done`. murmur therefore treats an agent as waiting when its transcript has an unanswered tool call and its screen shows a Claude Code prompt.
- **No live push events on Windows.** Node cannot connect to Herdr's AF_UNIX socket on Windows, so murmur polls `herdr api snapshot` every 1.5 s. macOS and Linux get live events. This affects latency only.
- **Pane-to-session matching is by title.** Herdr 0.7.5 does not say which session a pane runs. murmur matches the pane title against the session's own title and falls back to the newest unclaimed session. Herdr 0.8's `agent_session` field will replace this.

Tested against Herdr `0.7.5-preview` and Claude Code transcripts as of 2026-09. Fields that only exist in newer Herdr versions are optional, so murmur picks them up automatically when you upgrade.

## Development

```sh
npm test                 # every module's built-in self-test; no framework, no dependencies
node src/app.js          # run standalone in any terminal
node src/app.js --once   # print one frame and exit
node src/render.js       # render the built-in demo fixture
```

| Module | Role |
|---|---|
| `src/herdr.js` | Herdr API and CLI |
| `src/claude.js` | Transcript parsing: usage by model, instruction files, context load, hooks |
| `src/render.js` | Tree and panels |
| `src/context.js` | Context view |
| `src/skills.js` and `src/lens.js` | Skill profiling and the skill lens |
| `src/inventory.js` | Installed-versus-used inventory |
| `src/app.js` | State, keys and actions |

## Licence

[Apache-2.0](LICENSE).
