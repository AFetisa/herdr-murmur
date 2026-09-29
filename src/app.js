#!/usr/bin/env node
// murmur — live org chart of Herdr agents and their subagents.
// Reads local state only: the Herdr socket/CLI plus Claude Code's own transcripts.
// Never calls a model.

const { execFile } = require('child_process')
const herdr = require('./herdr')
const claude = require('./claude')
const render = require('./render')
const skills = require('./skills')
const lens = require('./lens')
const inventory = require('./inventory')
const contextView = require('./context')

const HERDR_BIN = process.env.HERDR_BIN_PATH || 'herdr'

const thresholds = skills.loadThresholds()

const POLL_MS = 1500        // snapshot refresh
const STALL_MS = 90000      // "working" with no transcript write for this long => stalled

// ponytail: Node/libuv cannot dial AF_UNIX on Windows (ENOTSOCK), so there is no event
// subscription there and we poll the CLI instead. Same code path, detected at runtime;
// Windows gets push for free if Herdr ever exposes TCP or a named pipe.
const CAN_SUBSCRIBE = process.platform !== 'win32'

const state = {
  now: Date.now(), connected: false, workspaces: [], tabs: [], agents: [],
  selected: 0, selectedId: null, panel: null,
  expandedDone: new Set(), view: 'tree',
  screens: {},      // pane_id -> visible text of a blocked pane
  prompts: {},      // pane_id -> true when that screen shows a Claude Code prompt
  confirm: null,    // pending action awaiting a second `y`
  flash: null       // {text, until, error} one-line result in the footer
}
const blockedSince = new Map()   // pane_id -> ms epoch when it entered `blocked`
let client = null
let dirty = true
let lastFrame = ''

// ---- data ----

async function refresh() {
  let snap
  try {
    snap = await herdr.snapshot(client)
    state.connected = true
  } catch (e) {
    state.connected = false
    return
  }
  const n = herdr.normalize(snap)
  state.workspaces = n.workspaces
  state.tabs = n.tabs

  const now = Date.now()
  const claimed = resolveSessions(n.agents)
  state.agents = n.agents.map(a0 => {
    const session = a0.cwd ? claude.scan(a0.cwd, claimed.get(a0.pane_id)) : null
    // Herdr 0.7.5 reports a pane sitting on a permission prompt as `done`. If the
    // transcript has an unanswered tool call AND the screen shows a prompt, it is
    // waiting on the human, whatever Herdr says.
    const a = (a0.agent_status !== 'blocked' && session && session.pendingTool && state.prompts[a0.pane_id])
      ? Object.assign({}, a0, { agent_status: 'blocked', herdr_status: a0.agent_status })
      : a0
    // Track how long a blocked agent has been waiting on the human.
    if (a.agent_status === 'blocked') {
      if (!blockedSince.has(a.pane_id)) blockedSince.set(a.pane_id, now)
    } else {
      blockedSince.delete(a.pane_id)
    }
    const mtime = session && session.mtime
    return Object.assign({}, a, {
      session,
      blockedSince: blockedSince.get(a.pane_id) || null,
      stalled: a.agent_status === 'working' && !!mtime && (now - mtime) > STALL_MS
    })
  })
  state.now = now
  annotate()
  clampSelection()
  readBlockedScreens()
  dirty = true
}

// Claude Code's permission / question dialogs. Matched on the visible screen only.
const PROMPT_RE = /Do you want to|❯\s*1\.\s|Esc to cancel/

// A blocked agent's question lives on its screen, not in the transcript, so read it:
// the briefing shows exactly what y / n would be answering. Only panes that are blocked,
// or have an unanswered tool call, are read -- never an idle or plainly working one.
function readBlockedScreens() {
  const watch = new Set(state.agents
    .filter(a => a.agent_status === 'blocked' || (a.session && a.session.pendingTool))
    .map(a => a.pane_id))
  for (const id of Object.keys(state.screens)) if (!watch.has(id)) { delete state.screens[id]; delete state.prompts[id] }
  watch.forEach(id => {
    execFile(HERDR_BIN, ['pane', 'read', id, '--source', 'visible', '--lines', '30'], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return
      const prompt = PROMPT_RE.test(stdout)
      if (state.screens[id] === stdout && state.prompts[id] === prompt) return
      state.screens[id] = stdout
      state.prompts[id] = prompt
      dirty = true
    })
  })
}

// Attach a skills/tools profile and health flags to every node, and build the inverted
// index behind the lens. Profiles are cached by path+mtime inside skills.js, so an idle
// refresh re-reads nothing.
function annotate() {
  const flat = []
  for (const a of state.agents) {
    const s = a.session
    if (!s) continue
    walk(s, 0, null, flat, a)
  }
  state.lensRows = skills.aggregate(flat, thresholds)
  state.flagged = flat.filter(x => x.node.flags && x.node.flags.length).length
}

function walk(node, depth, parent, flat, agent) {
  if (!node) return
  const kids = node.children || []
  if (node.file) {
    node.profile = skills.profile(node.file)
    node.flags = skills.health(
      Object.assign({}, node, { profile: node.profile }),
      { thresholds, depth, fanOut: kids.length, kind: parent ? 'agent' : 'session' }
    )
  }
  flat.push({
    node,
    profile: node.profile,
    agentType: node.agentType || (parent ? null : agent.agent),
    model: node.model,
    label: node.description || node.agentType || agent.title || agent.pane_id
  })
  kids.forEach(c => walk(c, depth + 1, node, flat, agent))
}

// Decide which on-disk session each pane is running, and give each session to at most
// one pane. Panes commonly share a cwd, and without this every pane on that cwd shows
// the newest session -- same subagents drawn three times, cost counted three times.
// Title match first (Herdr's pane title is the session's own aiTitle), then newest
// unclaimed session with real work in it.
// ponytail: title is the only join key Herdr 0.7.5 exposes. When it starts sending
// agent_session, read that instead and delete this.
function resolveSessions(agents) {
  const out = new Map()
  const byCwd = new Map()
  for (const a of agents) {
    if (!a.cwd) continue
    if (!byCwd.has(a.cwd)) byCwd.set(a.cwd, claude.listSessions(a.cwd))
    const sessions = byCwd.get(a.cwd)
    const want = claude.normalizeTitle(a.title)
    const hit = want && sessions.find(s => !s.taken && claude.normalizeTitle(s.title) === want)
    if (hit) { hit.taken = true; out.set(a.pane_id, hit.sessionId) }
  }
  // Second pass so every title match wins before fallbacks start consuming sessions.
  for (const a of agents) {
    if (!a.cwd || out.has(a.pane_id)) continue
    const sessions = byCwd.get(a.cwd) || []
    const next = sessions.find(s => !s.taken && s.hasWork)
    if (next) { next.taken = true; out.set(a.pane_id, next.sessionId) }
  }
  return out
}

function rows() {
  return render.flatten(state, { cols: cols() })
}

// A row's stable identity. Rows re-sort on every refresh (blocked float to the top), so
// an index selects a different agent the moment anything changes status -- and ⏎ would
// then focus the wrong pane. Identity is what the cursor actually points at; the index is
// recomputed from it at paint time.
function rowId(row) {
  if (!row || !row.node) return null
  const n = row.node
  return (row.type || '') + ':' + (n.pane_id || n.agentId || n.id || n.sessionId || '?')
}

// Re-derive the index from the selected identity, keeping the cursor on the same agent
// across refreshes. Falls back to the nearest valid index if that row is gone.
function clampSelection() {
  const list = rows()
  if (!list.length) { state.selected = 0; state.selectedId = null; return }
  if (state.selectedId) {
    const i = list.findIndex(r => rowId(r) === state.selectedId)
    if (i >= 0) { state.selected = i; return }
  }
  state.selected = Math.min(Math.max(state.selected, 0), list.length - 1)
  state.selectedId = rowId(list[state.selected])
}

function moveSelection(delta) {
  const list = rows()
  if (!list.length) return
  const i = Math.min(Math.max(state.selected + delta, 0), list.length - 1)
  if (i !== state.selected) state.panelScroll = 0 // new row, briefing starts at the top
  state.selected = i
  state.selectedId = rowId(list[i])
}

// ---- output ----

function cols() { return process.stdout.columns || 100 }

function paint() {
  const opts = {
    cols: cols(),
    rows: process.stdout.rows || 0,
    noColor: !!process.env.NO_COLOR,
    ascii: process.env.MURMUR_ASCII === '1'
  }
  const frame =
    state.view === 'lens'
      ? lens.drawLens(state.lensRows || [], Object.assign({
          selected: state.lensSelected || 0, expanded: !!state.lensExpanded
        }, opts))
    : state.view === 'context'
      ? contextView.drawContext(state.contextData = contextView.aggregate(state.agents), Object.assign({
          selected: state.ctxSelected || 0, expanded: !!state.ctxExpanded
        }, opts))
    : state.view === 'inventory'
      ? inventory.drawInventory(state.inventory, Object.assign({
          selected: state.invSelected || 0, expanded: !!state.invExpanded
        }, opts))
    : render.draw(state, opts)
  if (frame === lastFrame) return
  lastFrame = frame
  process.stdout.write('\x1b[H\x1b[2J' + frame)
}

// ---- actions ----

function focusSelected() {
  const row = rows()[state.selected]
  if (!row) return
  // Workspace/subagent rows resolve up to the pane that owns them.
  const paneId = row.node && (row.node.pane_id ||
    (state.agents.find(a => a.session && containsNode(a.session, row.node)) || {}).pane_id)
  if (!paneId) return
  herdr.focusAgent(client, paneId).catch(() => {
    // ponytail: socket may be down on Windows; fall back to the CLI, ignore failure.
    execFile(process.env.HERDR_BIN_PATH || 'herdr', ['agent', 'focus', paneId], () => {})
  })
}

// ---- control: answer or interrupt an agent ----
// Every action is two keys: the first arms it and names exactly what will be sent where,
// the second (`y`) sends it. Anything else cancels. Keys go through Herdr's own CLI.

const ACTIONS = {
  approve: { keys: ['1'], needs: 'blocked', verb: 'approve', send: 'sends "1"' },
  deny: { keys: ['esc'], needs: 'blocked', verb: 'deny', send: 'sends Esc' },
  interrupt: { keys: ['esc'], needs: 'working', verb: 'interrupt', send: 'sends Esc' }
}

function paneOf(row) {
  if (!row || !row.node) return null
  return row.pane || (row.node.pane_id ? row.node : null)
}

function paneName(a) {
  const ws = state.workspaces.find(w => w.id === a.workspace_id)
  return 'w' + (ws && ws.number != null ? ws.number : '?') + ' ' + (a.agent || 'agent')
}

function flash(text, error) {
  state.flash = { text, error: !!error, until: Date.now() + 4000 }
}

function arm(kind) {
  const act = ACTIONS[kind]
  const a = paneOf(rows()[state.selected])
  if (!a) return flash('select an agent first', true)
  if (a.agent_status !== act.needs) {
    return flash(paneName(a) + ' is ' + (a.agent_status || 'unknown') + ' — ' + act.verb + ' only applies to a ' + act.needs + ' agent', true)
  }
  const what = a.agent_status === 'blocked'
    ? (render.shortActivity((a.session && (a.session.pendingTool || a.session.activity)) || null) || 'its question')
    : ((a.session && a.session.activity && a.session.activity.tool) || 'its current turn')
  state.confirm = { kind, paneId: a.pane_id, label: act.verb + ' ' + paneName(a) + ' (' + what + ') — ' + act.send }
}

function confirmKey(k) {
  const c = state.confirm
  state.confirm = null
  if (k !== 'y') return flash('cancelled — nothing sent')
  const act = ACTIONS[c.kind]
  // Re-check at send time: if the agent moved on, "1" would land in its prompt as text.
  const a = state.agents.find(x => x.pane_id === c.paneId)
  if (!a || a.agent_status !== act.needs) return flash('not sent — agent is no longer ' + act.needs, true)
  // The prompt is being answered: forget it now, so a quick second `y` cannot re-arm
  // against a screen that is about to change.
  state.prompts[c.paneId] = false
  execFile(HERDR_BIN, ['pane', 'send-keys', c.paneId].concat(act.keys), (err) => {
    flash(err ? 'send failed: ' + String(err.message).split('\n')[0] : act.verb + ' sent to ' + paneName(a), !!err)
    dirty = true
    paint()
    setTimeout(refresh, 300)
  })
}

function containsNode(node, target) {
  if (node === target) return true
  return (node.children || []).some(c => containsNode(c, target))
}

// ---- input ----

function onKey(buf) {
  const k = buf.toString()
  // A pending action swallows the next key, whatever view is showing.
  if (state.confirm && k !== '\x03') { confirmKey(k); dirty = true; return paint() }
  if (k === 'q' || k === '\x03') return quit()

  if (state.view === 'context') {
    const n = contextView.items(state.contextData || {}).length
    if (k === 'c' || k === '\x1b') { state.view = 'tree'; state.ctxExpanded = false }
    else if (k === '\x1b[A') state.ctxSelected = Math.max(0, (state.ctxSelected || 0) - 1)
    else if (k === '\x1b[B') state.ctxSelected = Math.min(Math.max(0, n - 1), (state.ctxSelected || 0) + 1)
    else if (k === '\r' || k === '\n') state.ctxExpanded = !state.ctxExpanded
    else if (k === 'r') { claude.clearCache(); refresh() }
    else return
    dirty = true
    return paint()
  }

  // The inventory is its own screen with its own cursor.
  if (state.view === 'inventory') {
    const n = ((state.inventory && state.inventory.rows) || []).length
    if (k === 'u' || k === '\x1b') { state.view = 'tree'; state.invExpanded = false }
    else if (k === '\x1b[A') state.invSelected = Math.max(0, (state.invSelected || 0) - 1)
    else if (k === '\x1b[B') state.invSelected = Math.min(n - 1, (state.invSelected || 0) + 1)
    else if (k === '\r' || k === '\n') state.invExpanded = !state.invExpanded
    else if (k === 'r') { state.inventory = inventory.build({}); }
    else return
    dirty = true
    return paint()
  }

  // The lens is its own screen with its own cursor, so keys route there first.
  if (state.view === 'lens') {
    const n = (state.lensRows || []).length
    if (k === 's' || k === '\x1b') { state.view = 'tree'; state.lensExpanded = false }
    else if (k === '\x1b[A') state.lensSelected = Math.max(0, (state.lensSelected || 0) - 1)
    else if (k === '\x1b[B') state.lensSelected = Math.min(n - 1, (state.lensSelected || 0) + 1)
    else if (k === '\r' || k === '\n') state.lensExpanded = !state.lensExpanded
    else if (k === 'r') { claude.clearCache(); refresh() }
    else return
    dirty = true
    return paint()
  }

  if (k === '\x1b[A') moveSelection(-1)
  else if (k === '\x1b[B') moveSelection(1)
  else if (k === 's') { state.view = 'lens'; state.lensSelected = 0 }
  else if (k === 'c') { state.view = 'context'; state.ctxSelected = 0; state.ctxExpanded = false }
  else if (k === 'y') arm('approve')
  else if (k === 'n') arm('deny')
  else if (k === 'x') arm('interrupt')
  else if (k === 'u') {
    // Built on demand, not every refresh: the first scan walks transcripts across
    // every project, and nobody needs that running behind an idle tree view.
    if (!state.inventory) state.inventory = inventory.build({})
    state.view = 'inventory'
    state.invSelected = 0
  }
  else if (k === '\x1b[C') toggleDone(true)
  else if (k === '\x1b[D') toggleDone(false)
  else if (k === '\r' || k === '\n') focusSelected()
  else if (k === 'i') { state.panel = state.panel === 'instructions' ? null : 'instructions'; state.panelScroll = 0 }
  else if (k === 't') { state.panel = state.panel === 'tokens' ? null : 'tokens'; state.panelScroll = 0 }
  else if (k === ']' || k === '\x1b[6~') {
    state.panelScroll = Math.min((state.panelScroll || 0) + 5, render.maxScroll(state, { cols: cols(), rows: process.stdout.rows || 0 }))
  }
  else if (k === '[' || k === '\x1b[5~') state.panelScroll = Math.max(0, (state.panelScroll || 0) - 5)
  else if (k === 'r') { claude.clearCache(); refresh() }
  else if (k === '\x1b') state.panel = null
  else return
  dirty = true
  paint()
}

// → expands a parent's collapsed "done" children, ← collapses them again.
function toggleDone(expand) {
  const row = rows()[state.selected]
  if (!row || !row.node) return
  const id = row.node.pane_id || row.node.agentId || row.node.sessionId
  if (!id) return
  if (expand) state.expandedDone.add(id)
  else state.expandedDone.delete(id)
}

function quit() {
  process.stdout.write('\x1b[?25h\x1b[H\x1b[2J')
  if (client) client.close()
  process.exit(0)
}

// ---- main ----

async function main() {
  process.stdout.write('\x1b[?25l')   // hide cursor
  process.on('exit', () => process.stdout.write('\x1b[?25h'))

  if (CAN_SUBSCRIBE) {
    client = herdr.connect({
      onStatus: s => { state.connected = (s === 'connected'); dirty = true },
      onEvent: () => refresh()
    })
    try { await client.subscribe(['pane.agent_status_changed']) } catch (e) { /* poll covers it */ }
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onKey)
  }
  process.stdout.on('resize', () => { dirty = true; paint() })

  await refresh()
  paint()
  setInterval(async () => { await refresh(); if (dirty) { dirty = false; paint() } }, POLL_MS)
}

// ---- selftest / entry ----

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    const assert = require('assert')
    // A frame renders from an empty world without throwing, and selection stays in range.
    state.agents = []; state.workspaces = []
    clampSelection()
    assert.strictEqual(state.selected, 0)
    assert.ok(render.draw(state, { cols: 80, noColor: true }).length > 0)

    // Selection clamps to the row count rather than running off the end.
    state.workspaces = [{ id: 'w1', label: 'repo', number: 1 }]
    state.agents = [{
      pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude',
      agent_status: 'working', cwd: process.cwd(), title: 't', focused: true,
      blockedSince: null, stalled: false, session: null
    }]
    state.selected = 999
    clampSelection()
    assert.ok(state.selected < rows().length, 'selection clamped into range')

    // Selection sticks to the agent, not the row number, when the list re-sorts.
    // This is the bug that made ⏎ focus the wrong pane: blocked agents float to the
    // top, so every index below them shifts by one.
    const mk = (id, status) => ({
      pane_id: id, workspace_id: 'w' + id, tab_id: id + ':t', agent: 'claude',
      agent_status: status, cwd: null, title: id, focused: false,
      blockedSince: null, stalled: false, session: null
    })
    state.workspaces = [
      { id: 'wA', label: 'a', number: 1 }, { id: 'wB', label: 'b', number: 2 }
    ]
    state.agents = [mk('A', 'working'), mk('B', 'working')]
    state.selected = 0; state.selectedId = null
    clampSelection()
    moveSelection(1)
    const pinned = state.selectedId
    // B becomes blocked and its workspace sorts above A.
    state.agents = [mk('A', 'working'), mk('B', 'blocked')]
    state.workspaces = [
      { id: 'wA', label: 'a', number: 1, agent_status: 'working' },
      { id: 'wB', label: 'b', number: 2, agent_status: 'blocked' }
    ]
    clampSelection()
    assert.strictEqual(state.selectedId, pinned, 'selection follows the agent across a re-sort')
    assert.strictEqual(rowId(rows()[state.selected]), pinned, 'index re-derived from identity')

    // Control actions: armed only for the right status, cancelled by any key but `y`,
    // and never sent if the agent stopped waiting between arm and confirm.
    // (No path here reaches execFile: every case below stops before sending.)
    state.agents = [mk('A', 'working'), mk('B', 'blocked')]
    state.selectedId = null; state.selected = 0
    clampSelection()
    const paneRow = i => rows().findIndex(r => r.type === 'pane' && r.node.pane_id === i)
    state.selected = paneRow('A'); arm('approve')
    assert.strictEqual(state.confirm, null, 'approve refused for a working agent')
    assert.ok(/only applies to a blocked agent/.test(state.flash.text))
    state.selected = paneRow('B'); arm('interrupt')
    assert.strictEqual(state.confirm, null, 'interrupt refused for a blocked agent')
    arm('approve')
    assert.ok(state.confirm && state.confirm.paneId === 'B' && /sends "1"/.test(state.confirm.label), 'approve armed with what it sends')
    onKey(Buffer.from('q'))
    assert.strictEqual(state.confirm, null, 'q cancels a pending action instead of quitting')
    assert.ok(/nothing sent/.test(state.flash.text))
    arm('deny')
    state.agents = [mk('A', 'working'), mk('B', 'working')] // B answered elsewhere
    confirmKey('y')
    assert.ok(/no longer blocked/.test(state.flash.text), 'stale confirm is not sent')

    // containsNode walks arbitrary depth.
    const leaf = { children: [] }
    assert.ok(containsNode({ children: [{ children: [leaf] }] }, leaf))
    assert.ok(!containsNode({ children: [] }, leaf))

    console.log('selftest OK')
    process.exit(0)
  }
  if (process.argv.includes('--once')) {
    // One-shot render: handy for piping, screenshots, and smoke tests outside a TTY.
    refresh()
      .then(() => {
        console.log(render.draw(state, {
          cols: cols(),
          noColor: !!process.env.NO_COLOR,
          ascii: process.env.MURMUR_ASCII === '1'
        }))
      })
      .then(() => process.exit(0))
      .catch(e => { console.error(e); process.exit(1) })
  } else {
    main().catch(e => { console.error(e); process.exit(1) })
  }
}

module.exports = { refresh, state, containsNode, arm, confirmKey }
