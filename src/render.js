'use strict'

// murmur terminal renderer — pure string building, zero deps.
// ponytail: width math runs on visible length (ANSI stripped), and any line that
// overflows is clipped to plain text. Upgrade to a proper cell-grid if rows ever
// need color to survive a clip.

const os = require('os')

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', reverse: '\x1b[7m',
  cyan: '\x1b[36m', red: '\x1b[31m', brightRed: '\x1b[91m',
  green: '\x1b[32m', yellow: '\x1b[33m', grey: '\x1b[90m',
  blue: '\x1b[34m', magenta: '\x1b[35m', white: '\x1b[37m'
}

const glyphs = {
  working: { ch: '●', color: 'cyan' },
  blocked: { ch: '⛔', color: 'brightRed' },
  idle: { ch: '○', color: 'grey' },
  done: { ch: '✓', color: 'green' },
  unknown: { ch: '·', color: 'grey' }
}

// Role icons: what a row IS, independent of its status.
const ROLE = { project: '▣', agent: '◉', sub: '◆' }

// opts.ascii routes every glyph through this single map — cmd.exe mangles
// ● ⛔ ─ └ etc. All substitutions are 1:1 single chars so width math never
// shifts between color/ascii modes. Applied once per line at the end of
// draw(), so no function above needs to know ascii mode exists.
const ASCII_MAP = {
  '●': 'o', '○': 'o', '⛔': '!', '✓': '+', '·': '.', '◆': '*',
  '─': '-', '—': '-', '└': '+', '├': '+', '│': '|', '⚑': '!',
  '…': '.', '▸': '>', '↑': '^', '↓': 'v', '⏎': 'v', '⚠': '!',
  '→': '>', '←': '<', '▣': '#', '◉': '@', '█': '#', '×': 'x'
}
function glyph(s, ascii) {
  if (!ascii) return s
  return String(s).split('').map(c => ASCII_MAP[c] || c).join('')
}

const ANSI_RE = /\x1b\[[0-9;]*m/g
function strip(s) { return String(s).replace(ANSI_RE, '') }
function vlen(s) { return strip(s).length }

function paint(text, colors, noColor) {
  if (noColor || !colors) return text
  const names = Array.isArray(colors) ? colors : [colors]
  return names.map(n => COLORS[n] || '').join('') + text + COLORS.reset
}

// ---- exported formatters (all null/undefined/NaN-safe) ----

function fmtTokens(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '-'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return Math.round(n / 1000) + 'k'
  return (n / 1e6).toFixed(1) + 'M'
}

function fmtCost(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '-'
  return n < 10 ? '$' + n.toFixed(2) : '$' + n.toFixed(1)
}

function fmtAge(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '-'
  ms = Math.max(0, ms)
  if (ms < 60000) return Math.floor(ms / 1000) + 's'
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm'
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h'
  return Math.floor(ms / 86400000) + 'd'
}

function truncate(s, n, fromLeft) {
  if (s == null) return '-'
  s = String(s)
  if (n <= 0) return ''
  if (s.length <= n) return s
  if (n === 1) return '…'
  return fromLeft ? '…' + s.slice(s.length - (n - 1)) : s.slice(0, n - 1) + '…'
}

// "claude-opus-5-5" -> "opus-5.5", "claude-haiku-4-5-20251001" -> "haiku-4.5",
// bare aliases ("sonnet") pass through. Short enough for a table column.
function modelTag(id) {
  if (!id) return '-'
  const s = String(id).toLowerCase()
  const m = s.match(/(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?!\d))?(?:-(\d{1,2})(?!\d))?/)
  if (!m) return truncate(s.replace(/^claude-/, ''), 12)
  return m[1] + (m[2] ? '-' + m[2] + (m[3] ? '.' + m[3] : '') : '')
}

function provider(id) {
  const s = String(id || '').toLowerCase()
  if (/opus|sonnet|haiku|fable|claude/.test(s)) return 'Anthropic'
  if (/gpt|codex|^o\d/.test(s)) return 'OpenAI'
  if (/gemini/.test(s)) return 'Google'
  return 'unknown'
}

// One fixed tint per model family, so the mix reads at a glance. Red is never used:
// it stays reserved for "needs you".
function modelTint(id) {
  const t = modelTag(id)
  if (t.startsWith('opus')) return 'magenta'
  if (t.startsWith('sonnet')) return 'blue'
  if (t.startsWith('haiku')) return 'green'
  if (t.startsWith('fable')) return 'cyan'
  return 'dim'
}

// ---- small internal helpers ----

function num(x) { return (typeof x === 'number' && !Number.isNaN(x)) ? x : 0 }
function pctText(p) { return (p == null || Number.isNaN(p)) ? '-' : Math.round(p) + '%' }
function ctxColorFor(p) { if (p == null || Number.isNaN(p)) return 'dim'; return p >= 80 ? 'red' : p >= 60 ? 'yellow' : 'dim' }
function totalTok(u) { return num(u.in) + num(u.out) + num(u.cacheRead) + num(u.cacheWrite) }

const HOME = os.homedir()
function shortPath(p) {
  if (!p) return ''
  const s = String(p)
  return s.toLowerCase().startsWith(HOME.toLowerCase()) ? '~' + s.slice(HOME.length) : s
}

function baseName(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

function addUsage(into, u) {
  into.in += num(u.in); into.out += num(u.out); into.cacheRead += num(u.cacheRead)
  into.cacheWrite += num(u.cacheWrite); into.cost += num(u.cost)
}

function rollup(node) {
  const r = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, partial: false, byModel: {} }
  if (!node) return r
  const u = node.usage || {}
  addUsage(r, u)
  if (u.partial) r.partial = true
  // Older fixtures / partial data carry no byModel: file it under the node's model.
  const bm = u.byModel || (totalTok(u) || num(u.cost) ? { [node.model || 'unknown']: u } : {})
  for (const m of Object.keys(bm)) {
    const into = r.byModel[m] || (r.byModel[m] = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
    addUsage(into, bm[m])
  }
  ;(node.children || []).forEach(c => {
    const cr = rollup(c)
    addUsage(r, cr)
    if (cr.partial) r.partial = true
    for (const m of Object.keys(cr.byModel)) {
      const into = r.byModel[m] || (r.byModel[m] = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
      addUsage(into, cr.byModel[m])
    }
  })
  return r
}

// Merge several rollups (a workspace's agents, or everything).
function rollupMany(nodes) {
  return rollup({ usage: {}, children: nodes.filter(Boolean) })
}

function clipPlain(s, n) {
  if (n <= 0) return ''
  const plain = strip(s)
  return plain.length <= n ? plain : truncate(plain, n)
}

// Pads/truncates to cols; left is clipped (to plain) before right is touched.
function joinLR(left, right, cols) {
  const rv = vlen(right)
  let l = left
  if (vlen(l) + rv + 1 > cols) l = clipPlain(l, Math.max(0, cols - rv - 1))
  const gap = Math.max(1, cols - vlen(l) - rv)
  return l + ' '.repeat(gap) + right
}

// Transcripts and pane screens are untrusted text (a fetched web page can land in a
// prompt). Only murmur's own color codes (ESC [ digits m) may reach the terminal; every
// other escape and control character is dropped, so nothing can move the cursor, set
// the window title or smuggle a newline into a row.
const UNSAFE_RE = /\x1b(?!\[[0-9;]*m)|[\x00-\x1a\x1c-\x1f\x7f-\x9f]/g
function sanitize(s) { return String(s).replace(UNSAFE_RE, '') }

// Every renderer emits its lines through here, so this is the one choke point.
function padLine(s, cols) {
  s = sanitize(s)
  const vl = vlen(s)
  if (vl > cols) return strip(s).slice(0, cols) // ponytail: safety clip loses color on overflow
  return vl < cols ? s + ' '.repeat(cols - vl) : s
}

// Plain text inside the bar: any color reset mid-line would end the reverse video early.
function reverseLine(ln, cols, noColor) {
  const padded = padLine(strip(ln), cols)
  return noColor ? padded : COLORS.reverse + padded + COLORS.reset
}

// Fixed-width table cell; clips to plain text if the content is wider.
function cell(s, w, right) {
  s = s == null ? '' : s
  const v = vlen(s)
  if (v > w) return truncate(strip(s), w)
  const pad = ' '.repeat(w - v)
  return right ? pad + s : s + pad
}

function fmtTime(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function wsStatus(ws, agents) {
  if (ws && ws.agent_status) return ws.agent_status
  if (agents.some(a => a.agent_status === 'blocked')) return 'blocked'
  if (agents.some(a => a.agent_status === 'working')) return 'working'
  return 'idle'
}

// ---- columns ----

// STATUS · MODEL · TOKENS · COST, dropped right-to-left of importance as width shrinks.
// Cost always survives: it is the one number that is never visible elsewhere.
const COLS = [
  { key: 'status', w: 13 }, { key: 'model', w: 10 }, { key: 'tokens', w: 9, right: true }, { key: 'cost', w: 8, right: true }
]
function colSet(width) {
  if (width >= 76) return ['status', 'model', 'tokens', 'cost']
  if (width >= 60) return ['status', 'model', 'cost']
  if (width >= 44) return ['status', 'cost']
  return ['cost']
}
function rightCols(vals, width) {
  const keys = colSet(width)
  return COLS.filter(c => keys.includes(c.key)).map(c => cell(vals[c.key] || '', c.w, c.right)).join(' ')
}
function colHeader(width, noColor) {
  const vals = { status: 'STATUS', model: 'MODEL', tokens: 'TOKENS', cost: 'COST' }
  return joinLR('', paint(rightCols(vals, width), 'dim', noColor), width)
}

function modelCell(id, noColor) { return id ? paint(modelTag(id), modelTint(id), noColor) : '' }

// ---- header ----

// ws label + short reason for each blocked agent, e.g. "w4 permission"
function blockedReasons(state, blockedAgents) {
  const wsList = state.workspaces || []
  return blockedAgents.map(a => {
    const ws = wsList.find(w => w.id === a.workspace_id)
    const wn = ws && ws.number != null ? ws.number : '?'
    // The header is a verdict line, not a transcript. A few words are enough to tell
    // two blocked workspaces apart.
    const s = a.session || {}
    const text = s.pendingTool ? shortActivity(s.pendingTool) : ((s.activity && s.activity.detail) || 'permission').split(' — ')[0]
    return 'w' + wn + ' ' + truncate(text, 22)
  })
}

// "Write C:\...\hello.txt" -> "Write hello.txt": a bare path shrinks to its file name,
// a command (has spaces) is kept as written.
function shortActivity(act) {
  if (!act) return ''
  const d = String(act.detail || '')
  const tail = /[\\/]/.test(d) && !/\s/.test(d) ? d.split(/[\\/]/).filter(Boolean).pop() : d
  return ((act.tool ? act.tool + ' ' : '') + tail).trim()
}

// Top models by cost across everything on screen: "opus-5.5 $412 · sonnet-5 $180".
function modelStrip(agents, noColor, max) {
  const r = rollupMany(agents.map(a => a.session))
  return Object.entries(r.byModel)
    .filter(([, u]) => u.cost > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, max)
    .map(([m, u]) => paint(modelTag(m), modelTint(m), noColor) + ' ' + fmtCost(u.cost))
    .join(paint(' · ', 'dim', noColor))
}

// Leads with the verdict: NEED YOU (blocked) > all clear (working) > idle.
function headerLine(state, agents, cols, noColor, now) {
  const blocked = agents.filter(a => a.agent_status === 'blocked')
  const working = agents.filter(a => a.agent_status === 'working')
  const cost = rollupMany(agents.map(a => a.session)).cost
  const time = fmtTime(now)
  let left
  if (state.connected === false) {
    left = paint('⚠ herdr socket down (fallback polling)', 'yellow', noColor)
  } else if (blocked.length) {
    const reasons = blockedReasons(state, blocked).slice(0, 2).join(' · ')
    left = '⛔ ' + paint(blocked.length + ' NEED YOU', ['bold', 'brightRed'], noColor) + (reasons ? ' · ' + reasons : '')
  } else if (working.length) {
    left = 'all clear · ' + working.length + ' working · ' + fmtCost(cost)
  } else {
    left = 'idle · ' + fmtCost(cost)
  }
  let strip2 = cols >= 90 ? modelStrip(agents, noColor, cols >= 130 ? 4 : 2) : ''
  if (strip2 && vlen(left) + vlen(strip2) + time.length + 8 > cols) strip2 = ''
  const right = (strip2 ? strip2 + '  ' : '') + time
  const fillLen = Math.max(1, cols - vlen(left) - vlen(right) - 2)
  return `${left} ${paint('─'.repeat(fillLen), 'dim', noColor)} ${right}`
}

// ---- tree rows ----

function paneStatus(a, noColor, now) {
  if (!a.session) return paint('no session', 'dim', noColor)
  if (a.agent_status === 'blocked') {
    return paint('⛔ ' + (a.blockedSince ? 'wait ' + fmtAge(now - a.blockedSince) : 'blocked'), ['bold', 'brightRed'], noColor)
  }
  // Stalled age is time since the transcript last moved -- the thing that stalled.
  if (a.stalled) return paint('⚠ stalled ' + fmtAge(now - num(a.session.mtime)), 'yellow', noColor)
  const g = glyphs[a.agent_status] || glyphs.unknown
  return paint(g.ch + ' ' + (a.agent_status || 'unknown'), g.color, noColor)
}

function paneLine(a, prefix, width, noColor, now) {
  const label = (a.session && a.session.gitBranch) || a.title || baseName(a.cwd) || ''
  const left = prefix + paint(ROLE.agent, 'bold', noColor) + ' ' + (a.agent || 'agent') + (label ? '  ' + paint(label, 'dim', noColor) : '')
  const s = a.session
  const u = (s && s.usage) || {}
  const r = s ? rollup(s) : null
  return joinLR(left, rightCols({
    status: paneStatus(a, noColor, now),
    model: s ? modelCell(s.model, noColor) : '',
    tokens: s ? paint(fmtTokens(u.ctx) + ' ' + pctText(u.ctxPct), ctxColorFor(u.ctxPct), noColor) : '',
    cost: r ? fmtCost(r.cost) : ''
  }, width), width)
}

function wsLine(ws, status, agents, width, noColor, now) {
  const wn = ws.number != null ? ws.number : '?'
  const left = paint(ROLE.project + ' w' + wn + '  ' + (ws.label || ws.id || ''), 'bold', noColor)
  let st
  if (status === 'blocked') {
    const since = agents.reduce((m, a) => (a.blockedSince && (!m || a.blockedSince < m)) ? a.blockedSince : m, null)
    st = paint('⛔ BLOCKED' + (since ? ' ' + fmtAge(now - since) : ''), ['bold', 'brightRed'], noColor)
  } else if (status === 'working') {
    st = paint('● working', 'cyan', noColor)
  } else {
    st = paint('○ idle', 'grey', noColor)
  }
  const r = rollupMany(agents.map(a => a.session))
  return joinLR(left, rightCols({
    status: st, model: '', tokens: fmtTokens(totalTok(r)), cost: paint(fmtCost(r.cost), 'bold', noColor)
  }, width), width)
}

function subStatus(node, noColor) {
  if (node.status === 'done') return paint('✓ done', 'green', noColor)
  if (node.activity && node.activity.tool) return '▸ ' + node.activity.tool
  const g = glyphs[node.status] || glyphs.working
  return paint(g.ch + ' running', g.color, noColor)
}

function agentNodeLine(node, prefix, width, noColor) {
  const type = node.agentType || node.slug || 'agent'
  const left = prefix + paint(ROLE.sub, 'dim', noColor) + ' ' + type + (node.description ? '  ' + paint('"' + node.description + '"', 'dim', noColor) : '')
  const r = rollup(node)
  return joinLR(left, rightCols({
    status: subStatus(node, noColor), model: modelCell(node.model, noColor),
    tokens: fmtTokens(totalTok(r)), cost: fmtCost(r.cost)
  }, width), width)
}

// ctx: { width, noColor, lines, flat, expandedDone, pane }
function renderAgentNode(node, parent, prefix, isLast, ctx) {
  ctx.lines.push(agentNodeLine(node, prefix + (isLast ? '└─ ' : '├─ '), ctx.width, ctx.noColor))
  ctx.flat.push({ type: 'agent', node, parent, pane: ctx.pane })
  renderChildren(node.children || [], node, prefix + (isLast ? '   ' : '│  '), ctx)
}

// Done children collapse into one dim summary row per parent unless the
// parent's id (pane_id or agentId) is in expandedDone. Running/other
// children always render individually, listed before the summary row.
function renderChildren(kids, parentNode, prefix, ctx) {
  if (!kids.length) return
  const parentId = parentNode.pane_id || parentNode.agentId
  const doneKids = kids.filter(c => c.status === 'done')
  const expand = (ctx.expandedDone && parentId != null && ctx.expandedDone.has(parentId)) || !doneKids.length
  if (expand) {
    kids.forEach((c, i) => renderAgentNode(c, parentNode, prefix, i === kids.length - 1, ctx))
    return
  }
  kids.filter(c => c.status !== 'done').forEach(c => renderAgentNode(c, parentNode, prefix, false, ctx))
  const cost = doneKids.reduce((s, c) => s + rollup(c).cost, 0)
  const left = prefix + '└─ ' + paint(glyphs.done.ch + ' ' + doneKids.length + ' done  →', 'dim', ctx.noColor)
  ctx.lines.push(joinLR(left, rightCols({ cost: paint(fmtCost(cost), 'dim', ctx.noColor) }, ctx.width), ctx.width))
  ctx.flat.push({ type: 'doneSummary', node: parentNode, pane: ctx.pane })
}

function buildTree(state, agents, width, noColor, now) {
  const lines = [], flat = []
  const byWs = new Map()
  agents.forEach(a => {
    if (!byWs.has(a.workspace_id)) byWs.set(a.workspace_id, [])
    byWs.get(a.workspace_id).push(a)
  })
  const wsList = (state.workspaces || []).slice()
  byWs.forEach((_, k) => { if (!wsList.some(w => w.id === k)) wsList.push({ id: k, label: String(k), number: '?' }) })

  const weight = { blocked: 0, working: 1, idle: 2 }
  wsList.sort((a, b) => {
    const wa = weight[wsStatus(a, byWs.get(a.id) || [])]
    const wb = weight[wsStatus(b, byWs.get(b.id) || [])]
    return wa !== wb ? wa - wb : (num(a.number) - num(b.number))
  })

  wsList.forEach(ws => {
    const wsAgents = byWs.get(ws.id) || []
    lines.push(wsLine(ws, wsStatus(ws, wsAgents), wsAgents, width, noColor, now))
    flat.push({ type: 'workspace', node: ws, agents: wsAgents })
    wsAgents.forEach((a, ai) => {
      const last = ai === wsAgents.length - 1
      lines.push(paneLine(a, last ? '└─ ' : '├─ ', width, noColor, now))
      flat.push({ type: 'pane', node: a, pane: a })
      const childPfx = last ? '   ' : '│  '
      const kids = (a.session && a.session.children) || []
      if (a.session && a.agent_status === 'blocked' && !kids.length) {
        const detail = (a.session.activity && a.session.activity.detail) || 'permission'
        lines.push(childPfx + '└─ ' + paint('waiting: ' + detail, 'yellow', noColor))
        flat.push({ type: 'wait', node: a, pane: a })
      } else {
        renderChildren(kids, a, childPfx, { width, noColor, lines, flat, expandedDone: state.expandedDone, pane: a })
      }
    })
  })
  return { lines, flat }
}

// ---- panels ----

function wrapText(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  words.forEach(w => {
    while (w.length > width) { // hard-break long paths/urls so nothing overflows
      if (cur) { lines.push(cur); cur = '' }
      lines.push(w.slice(0, width)); w = w.slice(width)
    }
    if (!cur.length) cur = w
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w
    else { lines.push(cur); cur = w }
  })
  lines.push(cur)
  return lines
}

function section(title, w, noColor) {
  return paint((title + ' ' + '─'.repeat(w)).slice(0, w), 'dim', noColor)
}
function kv(k, v, w, noColor) {
  const room = Math.max(1, w - 11)
  return paint(k.padEnd(11), 'dim', noColor) + (vlen(v) > room ? clipPlain(v, room) : v)
}

// Cost/token table by provider -> model. Used by the briefing and the `t` panel.
function modelTable(r, w, noColor) {
  const rows = Object.entries(r.byModel || {}).sort((a, b) => b[1].cost - a[1].cost)
  if (!rows.length) return [paint('(no usage recorded)', 'dim', noColor)]
  const wide = w >= 58
  const head = (wide ? cell('PROVIDER', 10) + ' ' : '') + cell('MODEL', 10) + ' ' + cell('IN', 6, true) + ' ' +
    cell('OUT', 6, true) + ' ' + cell('CACHE', 7, true) + ' ' + cell('COST', 8, true)
  const out = [paint(head, 'dim', noColor)]
  rows.forEach(([m, u]) => {
    out.push((wide ? cell(provider(m), 10) + ' ' : '') + cell(modelCell(m, noColor), 10) + ' ' +
      cell(fmtTokens(u.in), 6, true) + ' ' + cell(fmtTokens(u.out), 6, true) + ' ' +
      cell(fmtTokens(num(u.cacheRead) + num(u.cacheWrite)), 7, true) + ' ' + cell(fmtCost(u.cost), 8, true))
  })
  if (rows.length > 1) {
    out.push((wide ? cell('', 10) + ' ' : '') + cell(paint('total', 'bold', noColor), 10) + ' ' +
      cell(fmtTokens(r.in), 6, true) + ' ' + cell(fmtTokens(r.out), 6, true) + ' ' +
      cell(fmtTokens(r.cacheRead + r.cacheWrite), 7, true) + ' ' + cell(paint(fmtCost(r.cost), 'bold', noColor), 8, true))
  }
  if (r.partial) out.push(paint('(partial: transcript over 8MB, oldest turns not counted)', 'yellow', noColor))
  return out
}

// What was loaded into this agent's context. Recorded files are ground truth from the
// transcript; without them we fall back to what exists on disk, and say so.
function filesLines(node, w, noColor) {
  const files = node.instrFiles
  const out = []
  if (files && files.length) {
    out.push(section('INSTRUCTION FILES (' + files.length + ')', w, noColor))
    files.forEach(f => {
      const tok = '~' + fmtTokens(Math.round(f.chars / 4)) + ' tok'
      out.push(cell(paint(f.type, 'cyan', noColor), 9) + joinLR(truncate(shortPath(f.path), Math.max(4, w - 9 - tok.length - 1), true), paint(tok, 'dim', noColor), w - 9))
    })
    return out
  }
  const mem = (node.memory || []).filter(m => m.kind === 'CLAUDE.md')
  out.push(section('INSTRUCTION FILES', w, noColor))
  if (!mem.length) out.push(paint('(none recorded)', 'dim', noColor))
  mem.forEach(m => out.push(cell('?', 9) + truncate(shortPath(m.path), w - 9, true)))
  if (mem.length) out.push(paint('(inferred from disk — transcript has no record)', 'dim', noColor))
  return out
}

// Order = how the prompt is assembled; colors match the stacked bar.
const LOAD_PARTS = [
  ['tools', 'tool schemas', 'blue'], ['files', 'instruction files', 'cyan'],
  ['skills', 'skill list', 'magenta'], ['agents', 'agent list', 'green'],
  ['mcp', 'MCP instructions', 'white'], ['deferred', 'deferred tool list', 'grey'],
  ['hooks', 'hook-injected text', 'yellow'], ['task', 'task prompt', 'bold']
]

// Everything the agent was handed besides the conversation itself, as a stacked bar.
// Tokens are estimated at 4 chars each; the records carry text, not token counts.
function contextLines(node, w, noColor) {
  const c = node.context
  if (!c) return []
  const total = LOAD_PARTS.reduce((s, [k]) => s + num(c[k]), 0)
  if (!total) return []
  const tok = ch => '~' + fmtTokens(Math.round(ch / 4))
  const out = [section('CONTEXT LOAD  ' + tok(total) + ' tok before any work', w, noColor)]
  let bar = '', used = 0
  LOAD_PARTS.forEach(([k, , color]) => {
    const n = Math.round(num(c[k]) / total * w)
    const len = Math.min(n, w - used)
    if (len > 0) { bar += paint('█'.repeat(len), color, noColor); used += len }
  })
  out.push(bar)
  LOAD_PARTS.filter(([k]) => num(c[k]) > 0).sort((a, b) => num(c[b[0]]) - num(c[a[0]])).forEach(([k, label, color]) => {
    const pct = Math.round(num(c[k]) / total * 100) + '%'
    out.push(paint('█', color, noColor) + ' ' + cell(label, Math.max(4, w - 17)) + cell(tok(c[k]), 8, true) + cell(pct, 6, true))
  })
  return out
}

function skillsLine(node, w, noColor) {
  const used = ((node.profile && node.profile.skills) || []).map(s => s.name + (s.uses > 1 ? ' ×' + s.uses : ''))
  const avail = node.skillCount != null ? node.skillCount + ' available' : 'available: ?'
  const text = avail + ' · ' + (used.length ? 'used: ' + used.join(', ') : 'none used')
  return [section('SKILLS', w, noColor), ...wrapText(text, w)]
}

// The blocked agent's own screen: the exact question or permission it is waiting on.
// app.js fills state.screens from `herdr pane read`; nothing here touches the pane.
function screenLines(state, a, w, noColor) {
  const text = state.screens && state.screens[a.pane_id]
  const out = [paint(truncate('WAITING FOR YOU ' + '─'.repeat(w), w), ['bold', 'brightRed'], noColor)]
  if (!text) return out.concat(paint('(reading screen…)', 'dim', noColor))
  const lines = text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
  lines.slice(-12).forEach(l => out.push(truncate(l, w)))
  out.push(paint('y approve (sends 1) · n deny (sends Esc) · both ask to confirm', 'dim', noColor))
  return out
}

function taskLines(text, w, noColor) {
  return [section('TASK', w, noColor), ...(text ? wrapText(text, w) : [paint('(no prompt recorded)', 'dim', noColor)])]
}

function statusText(node, noColor) {
  const a = node.activity
  if (node.status === 'done') return paint('✓ done', 'green', noColor)
  return (a && a.tool) ? '▸ ' + a.tool + (a.detail ? ' ' + a.detail : '') : (node.status || '-')
}

function nodeLabel(n) {
  if (!n) return '-'
  if (n.pane_id) return (n.agent || 'agent') + ' · ' + ((n.session && n.session.gitBranch) || n.title || n.pane_id)
  return (n.agentType || n.slug || 'agent') + (n.description ? ' "' + n.description + '"' : '')
}

function countSubs(node) {
  let total = 0, done = 0
  ;(function walk(n) { (n.children || []).forEach(c => { total++; if (c.status === 'done') done++; walk(c) }) })(node)
  return { total, done }
}

function briefingLines(sel, state, w, noColor, now) {
  if (!sel || !sel.node) return [paint('(select a row)', 'dim', noColor)]
  const out = []
  const K = (k, v) => out.push(kv(k, v, w, noColor))

  if (sel.type === 'workspace') {
    const ws = sel.node, agents = sel.agents || []
    out.push(paint(ROLE.project + ' PROJECT  ', 'bold', noColor) + (ws.label || ws.id))
    const blocked = agents.filter(a => a.agent_status === 'blocked').length
    const working = agents.filter(a => a.agent_status === 'working').length
    K('agents', agents.length + '  (' + working + ' working, ' + blocked + ' blocked)')
    const subs = agents.reduce((s, a) => { const c = a.session ? countSubs(a.session) : { total: 0, done: 0 }; return { total: s.total + c.total, done: s.done + c.done } }, { total: 0, done: 0 })
    K('subagents', subs.total + '  (' + subs.done + ' done)')
    out.push('', section('COST BY MODEL', w, noColor), ...modelTable(rollupMany(agents.map(a => a.session)), w, noColor))
    return out
  }

  // Wait / done-summary rows describe their owner.
  const isPane = sel.type === 'pane' || sel.type === 'wait' || (sel.type === 'doneSummary' && sel.node.pane_id)
  if (isPane) {
    const a = sel.pane || sel.node, s = a.session
    out.push(paint(ROLE.agent + ' AGENT  ', 'bold', noColor) + nodeLabel(a))
    if (!s) { out.push(paint('(no Claude Code session found for this pane)', 'dim', noColor)); return out }
    K('model', (s.model || '-') + ' · ' + provider(s.model))
    K('status', vlen(paneStatus(a, noColor, now)) ? strip(paneStatus(a, true, now)) + (s.activity && s.activity.tool ? '  ▸ ' + s.activity.tool + ' ' + (s.activity.detail || '') : '') : '-')
    K('context', fmtTokens(num(s.usage && s.usage.ctx)) + '  (' + pctText(s.usage && s.usage.ctxPct) + ' of window)')
    const c = countSubs(s)
    K('subagents', c.total + '  (' + (c.total - c.done) + ' running, ' + c.done + ' done)')
    K('cwd', shortPath(s.cwd))
    if (a.agent_status === 'blocked') out.push('', ...screenLines(state, a, w, noColor))
    const load = contextLines(s, w, noColor)
    if (load.length) out.push('', ...load)
    out.push('', ...filesLines(s, w, noColor), '', ...skillsLine(s, w, noColor))
    const extra = (s.memory || []).filter(m => m.kind !== 'CLAUDE.md' && m.kind !== 'transcript')
    if (extra.length) {
      out.push('', section('MEMORY & STATE', w, noColor))
      extra.forEach(m => out.push(cell(paint(m.kind, 'cyan', noColor), 13) + truncate(shortPath(m.path), w - 13, true)))
    }
    out.push('', section('COST BY MODEL', w, noColor), ...modelTable(rollup(s), w, noColor))
    out.push('', ...taskLines(s.instructions, w, noColor))
    return out
  }

  const n = sel.node
  out.push(paint(ROLE.sub + ' SUBAGENT  ', 'bold', noColor) + (n.agentType || n.slug || 'agent'))
  if (n.description) out.push(paint('"' + n.description + '"', 'dim', noColor))
  K('spawned by', nodeLabel(sel.parent || sel.pane))
  K('model', (n.model || '-') + ' · ' + provider(n.model))
  K('status', statusText(n, noColor))
  K('definition', n.agentDef ? (n.agentDef === 'built-in' ? 'built-in (Claude Code)' : shortPath(n.agentDef)) : 'not found on disk')
  const c = countSubs(n)
  if (c.total) K('subagents', c.total + '  (' + c.done + ' done)')
  if (n.flags && n.flags.length) {
    out.push('', section('HEALTH', w, noColor))
    n.flags.forEach(f => out.push(...wrapText('⚠ ' + (f.flag || f) + (f.reason ? ' — ' + f.reason : ''), w).map(l => paint(l, 'yellow', noColor))))
  }
  // Task last: prompts run to dozens of lines and would push everything else off-screen.
  const load = contextLines(n, w, noColor)
  if (load.length) out.push('', ...load)
  out.push('', ...filesLines(n, w, noColor), '', ...skillsLine(n, w, noColor))
  out.push('', section('COST BY MODEL', w, noColor), ...modelTable(rollup(n), w, noColor))
  out.push('', ...taskLines(n.instructions, w, noColor))
  return out
}

function tokenLines(sel, state, w, noColor) {
  const out = []
  let r, title
  if (!sel || !sel.node || sel.type === 'workspace') {
    const agents = sel && sel.type === 'workspace' ? (sel.agents || []) : (state.agents || [])
    r = rollupMany(agents.map(a => a.session))
    title = sel && sel.type === 'workspace' ? 'TOKENS · ' + (sel.node.label || sel.node.id) : 'TOKENS · everything'
  } else {
    const target = sel.node.pane_id ? sel.node.session : sel.node
    r = rollup(target)
    title = 'TOKENS · ' + nodeLabel(sel.node)
  }
  out.push(paint(truncate(title, w), 'bold', noColor), '')
  out.push(...modelTable(r, w, noColor))
  out.push('', ...wrapText('in = fresh input · cache = read + write · rates from pricing.json', w).map(l => paint(l, 'dim', noColor)))
  return out
}

// A pending action owns the footer until it is confirmed or cancelled: the one line
// that must never be missed before keys are sent to an agent.
function footerLine(cols, noColor, wide, state) {
  if (state && state.confirm) {
    const c = state.confirm
    return paint(truncate('▸ ' + c.label + ' — y confirm · any other key cancels', cols), ['bold', 'yellow'], noColor)
  }
  if (state && state.flash && (state.now || Date.now()) < state.flash.until) {
    return paint(truncate(state.flash.text, cols), state.flash.error ? 'yellow' : 'green', noColor)
  }
  const panelKeys = wide ? 'i/t panel · [ ] scroll' : 'i briefing · t tokens'
  return paint(truncate('↑↓ ⏎ focus · y/n answer · x interrupt · →← done · ' + panelKeys + ' · c context · s skills · u inventory · q quit', cols), 'dim', noColor)
}

// Centred "nothing running yet" block — replaces header+tree+footer
// entirely when there are no agents at all.
function emptyStateLines(cols, noColor) {
  const width = Math.max(10, cols)
  const paras = [
    ['murmur', 'bold'],
    ['live org chart for your running Herdr agents, drawn from local data — zero model tokens.', 'dim'],
    ['no running agents found.', 'dim'],
    ['this view fills in as soon as an agent starts in Herdr.', 'dim']
  ]
  const lines = []
  paras.forEach(([text, color]) => {
    wrapText(text, Math.max(10, width - 4)).forEach(l => {
      const pad = Math.max(0, Math.floor((width - l.length) / 2))
      lines.push(' '.repeat(pad) + paint(l, color, noColor))
    })
  })
  return lines
}

// ---- entry point ----

const SPLIT_MIN = 120 // ponytail: below this the briefing is a toggle, above it always shows

function layout(cols) {
  if (cols < SPLIT_MIN) return { wide: false, tw: cols }
  const pw = Math.min(64, Math.floor(cols * 0.42))
  return { wide: true, pw, tw: cols - pw - 3 }
}

function panelContent(state, sel, w, noColor, now) {
  return state.panel === 'tokens' ? tokenLines(sel, state, w, noColor) : briefingLines(sel, state, w, noColor, now)
}

// Slice to the visible window; the last visible line says how much is hidden.
function scrollWindow(lines, scroll, max, noColor) {
  if (!max || lines.length <= max) return lines
  const s = Math.max(0, Math.min(scroll || 0, lines.length - max + 1))
  const view = lines.slice(s, s + max - 1)
  const more = lines.length - (s + max - 1)
  view.push(paint(more > 0 ? '↓ ' + more + ' more · ] scroll' : '↑ [ scroll up', 'dim', noColor))
  return view
}

function draw(state, opts) {
  state = state || {}
  opts = opts || {}
  const cols = Math.max(20, opts.cols || 100)
  const noColor = !!opts.noColor
  const ascii = !!opts.ascii
  const now = state.now || Date.now()
  const agents = state.agents || []

  if (!agents.length) {
    return emptyStateLines(cols, noColor).map(l => padLine(glyph(l, ascii), cols)).join('\n')
  }

  const L = layout(cols)
  const maxBody = opts.rows ? Math.max(3, opts.rows - 3) : 0
  const out = [headerLine(state, agents, cols, noColor, now)]
  const { lines: treeLines, flat } = buildTree(state, agents, L.tw, noColor, now)
  const sel = flat[state.selected]

  if (L.wide) {
    const left = [colHeader(L.tw, noColor)].concat(treeLines.map((ln, i) => i === state.selected ? reverseLine(ln, L.tw, noColor) : ln))
    let right = panelContent(state, sel, L.pw, noColor, now)
    right = scrollWindow(right, state.panelScroll, maxBody ? Math.max(left.length, maxBody) : 0, noColor)
    const h = Math.max(left.length, right.length)
    const bar = paint('│', 'dim', noColor)
    for (let i = 0; i < h; i++) out.push(padLine(left[i] || '', L.tw) + ' ' + bar + ' ' + padLine(right[i] || '', L.pw))
  } else if (state.panel) {
    out.push(...scrollWindow(panelContent(state, sel, cols, noColor, now), state.panelScroll, maxBody, noColor))
  } else {
    out.push(colHeader(cols, noColor))
    treeLines.forEach((ln, i) => out.push(i === state.selected ? reverseLine(ln, cols, noColor) : ln))
  }
  out.push(footerLine(cols, noColor, L.wide, state))
  return out.map(l => padLine(glyph(l, ascii), cols)).join('\n')
}

// The flat row list draw() selects against. app.js needs it to map a selection index
// back to a node, and to know how far the cursor can travel.
function flatten(state, opts) {
  state = state || {}; opts = opts || {}
  return buildTree(state, state.agents || [], layout(Math.max(20, opts.cols || 100)).tw,
    true, state.now || Date.now()).flat
}

// Furthest the panel can scroll at this size, so app.js can clamp the offset.
function maxScroll(state, opts) {
  opts = opts || {}
  const cols = Math.max(20, opts.cols || 100)
  const L = layout(cols)
  if (!L.wide && !state.panel) return 0
  const { flat } = buildTree(state, state.agents || [], L.tw, true, state.now || Date.now())
  const len = panelContent(state, flat[state.selected], L.wide ? L.pw : cols, true, state.now || Date.now()).length
  const max = opts.rows ? Math.max(3, opts.rows - 3) : 0
  return max && len > max ? len - max + 1 : 0
}

module.exports = {
  draw, flatten, maxScroll, glyphs, fmtTokens, fmtCost, fmtAge, truncate, glyph, modelTag, provider,
  // ponytail: exported so lens.js (and any sibling renderer) reuses these
  // instead of re-implementing string/width/color plumbing.
  vlen, paint, padLine, joinLR, reverseLine, wrapText, contextLines, shortPath, strip, shortActivity
}

// ---- self-test / demo ----

if (require.main === module) {
  const u = (i, o, cost, model) => ({ in: i, out: o, cacheRead: 0, cacheWrite: 0, cost, byModel: { [model]: { in: i, out: o, cacheRead: 0, cacheWrite: 0, cost } } })
  const fixture = {
    now: 1737260000000,
    connected: true,
    workspaces: [
      { id: 'ws2', label: 'webapp', number: 2, focused: false },
      { id: 'ws4', label: 'infra', number: 4, focused: true },
      { id: 'ws6', label: 'docs-site', number: 6, focused: false }
    ],
    agents: [
      {
        pane_id: 'p1', workspace_id: 'ws2', tab_id: 't1', agent: 'claude', agent_status: 'working',
        cwd: '/repo/webapp', title: 'm7-prep-planner', focused: false,
        blockedSince: null, stalled: false,
        session: {
          sessionId: 's1', cwd: '/repo/webapp', gitBranch: 'm7-prep-planner', model: 'claude-opus-5-5',
          instructions: 'Prep the planner release for review, covering the pnpm lint gate and the m7 diff.',
          instrFiles: [{ type: 'User', path: '/home/u/.claude/CLAUDE.md', chars: 8400 }, { type: 'Project', path: '/repo/webapp/CLAUDE.md', chars: 5600 }],
          skillCount: 241,
          activity: { tool: 'Bash', detail: 'pnpm build', at: 1737259990000 },
          usage: Object.assign(u(100000, 18000, 1.84, 'claude-opus-5-5'), { ctx: 118000, ctxPct: 59 }),
          memory: [{ kind: 'CLAUDE.md', path: '/repo/webapp/CLAUDE.md' }, { kind: 'remember', path: '/repo/webapp/.remember' }],
          children: [
            { agentId: 'a1', slug: 'code-explorer', agentType: 'feature-dev:code-explorer', description: 'Map planner impl', model: 'claude-sonnet-5', spawnDepth: 1, status: 'done', instructions: '', activity: null, usage: u(20000, 2000, 0.09, 'claude-sonnet-5'), children: [] },
            { agentId: 'a2', slug: 'general-purpose', agentType: 'general-purpose', agentDef: 'built-in', description: 'Fix pnpm lint gate', model: 'claude-sonnet-5', spawnDepth: 1, status: 'working', instructions: 'Make pnpm lint pass without disabling rules.', instrFiles: [{ type: 'Project', path: '/repo/webapp/CLAUDE.md', chars: 5600 }], skillCount: 12, profile: { skills: [{ name: 'simplify', uses: 2 }] }, activity: { tool: 'Bash', detail: 'pnpm lint' }, usage: u(13000, 1000, 0.06, 'claude-sonnet-5'), children: [] },
            {
              agentId: 'a3', slug: 'code-reviewer', agentType: 'code-reviewer', description: 'Review m7 diff', model: 'claude-opus-5-5', spawnDepth: 1, status: 'working', instructions: '', activity: { tool: 'Read', detail: 'src/planner/index.ts' }, usage: u(29000, 2000, 0.71, 'claude-opus-5-5'),
              children: [
                { agentId: 'a4', slug: 'nested-check', agentType: 'checker', description: 'Depth2 check', model: 'claude-haiku-4-5-20251001', spawnDepth: 2, status: 'done', instructions: '', activity: null, usage: u(1000, 200, 0.01, 'claude-haiku-4-5-20251001'), children: [] }
              ]
            }
          ]
        }
      },
      {
        pane_id: 'p2', workspace_id: 'ws4', tab_id: 't2', agent: 'claude', agent_status: 'blocked',
        cwd: '/repo/infra', title: 'main', focused: true,
        blockedSince: 1737259760000, stalled: false,
        session: {
          sessionId: 's2', cwd: '/repo/infra', gitBranch: 'main', model: 'claude-sonnet-5',
          instructions: 'Ship the infra rollup.', activity: { tool: 'Bash', detail: 'permission — Bash(git push)', at: 1737259760000 },
          usage: Object.assign(u(35000, 6000, 0.32, 'claude-sonnet-5'), { ctx: 41000, ctxPct: 20 }),
          memory: [], children: []
        }
      },
      {
        pane_id: 'p3', workspace_id: 'ws6', tab_id: 't3', agent: 'claude', agent_status: 'idle',
        cwd: '/repo/docs-site', title: 'docs-site', focused: false,
        blockedSince: null, stalled: false,
        session: null
      }
    ],
    selected: 3,
    panel: null
  }

  if (process.argv.includes('--selftest')) {
    const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }

    assert(fmtTokens(842) === '842', 'fmtTokens 842')
    assert(fmtTokens(14000) === '14k', 'fmtTokens 14k')
    assert(fmtTokens(1200000) === '1.2M', 'fmtTokens 1.2M')
    assert(fmtTokens(null) === '-', 'fmtTokens null')
    assert(fmtCost(0.06) === '$0.06', 'fmtCost 0.06')
    assert(fmtCost(12.4) === '$12.4', 'fmtCost 12.4')
    assert(fmtCost(NaN) === '-', 'fmtCost NaN')
    assert(fmtAge(240000) === '4m', 'fmtAge 4m')
    assert(fmtAge(null) === '-', 'fmtAge null')
    assert(truncate('hello world', 8) === 'hello w…', 'truncate right')
    assert(truncate('hello world', 8, true) === '…o world', 'truncate left')
    assert(truncate(null, 5) === '-', 'truncate null')

    assert(shortActivity({ tool: 'Write', detail: 'C:\\a\\b\\hello.txt' }) === 'Write hello.txt', 'path shrinks to file name')

    // hostile text from a transcript: title-set OSC, cursor move, bell, newline, C1 CSI
    const evil = 'ok\x1b]0;pwned\x07\x1b[2J\x1b[10;10Hmove\nnl\x9b31m' + COLORS.red + 'kept' + COLORS.reset
    const cleaned = padLine(evil, 60)
    assert(!/\x1b\]|\x07|\x1b\[2J|\x1b\[10;10H|\n|\x9b/.test(cleaned), 'unsafe escapes stripped')
    assert(cleaned.includes(COLORS.red + 'kept'), 'own color codes survive')
    const hostile = JSON.parse(JSON.stringify(fixture))
    hostile.agents[0].session.instructions = 'x\x1b]52;c;ZXZpbA==\x07y\x1b[1A'
    hostile.agents[0].session.children[1].description = 'bad\x1b[H\x1b[2Jdesc'
    assert(!/\x1b\]|\x1b\[H|\x1b\[1A/.test(draw(Object.assign(hostile, { selected: 3 }), { cols: 140 })), 'no injected escapes in a full frame')
    assert(shortActivity({ tool: 'Bash', detail: 'git push origin main' }) === 'Bash git push origin main', 'command kept')

    // model tags and providers
    assert(modelTag('claude-opus-5-5') === 'opus-5.5', 'tag opus-5.5')
    assert(modelTag('claude-sonnet-5') === 'sonnet-5', 'tag sonnet-5')
    assert(modelTag('claude-haiku-4-5-20251001') === 'haiku-4.5', 'tag haiku-4.5 drops date')
    assert(modelTag('claude-fable-5-1') === 'fable-5.1', 'tag fable-5.1')
    assert(modelTag('sonnet') === 'sonnet', 'bare alias')
    assert(modelTag(null) === '-', 'tag null')
    assert(provider('claude-opus-5-5') === 'Anthropic', 'provider anthropic')
    assert(provider('gpt-5-codex') === 'OpenAI', 'provider openai')

    // rollup keeps per-model buckets through the tree
    const r = rollup(fixture.agents[0].session)
    assert(Object.keys(r.byModel).length === 3, 'three models in p1 subtree')
    assert(Math.abs(r.byModel['claude-sonnet-5'].cost - 0.15) < 1e-9, 'sonnet cost summed across subagents')
    assert(Math.abs(r.cost - (1.84 + 0.09 + 0.06 + 0.71 + 0.01)) < 1e-9, 'total cost')

    ;[40, 55, 70, 100, 119, 120, 140, 180].forEach(cols => {
      for (const panel of [null, 'instructions', 'tokens']) {
        for (let selected = 0; selected < 9; selected++) {
          const frame = draw(Object.assign({}, fixture, { panel, selected }), { cols, rows: 30 })
          frame.split('\n').forEach(l => assert(vlen(l) <= cols, `line width <= ${cols} (panel ${panel}, sel ${selected}): "${strip(l)}"`))
        }
      }
    })

    const frame = draw(fixture, { cols: 100 })
    assert(frame.includes('NEED YOU'), 'header shows NEED YOU when an agent is blocked')
    assert(frame.includes('MODEL') && frame.includes('COST'), 'column header row')
    assert(frame.includes('opus-5.5'), 'model tag in tree')
    assert(strip(frame.split('\n')[0]).includes('opus-5.5 $2.55'), 'header model strip sums opus across the tree')

    const clearFixture = Object.assign({}, fixture, {
      agents: fixture.agents.map(a => a.agent_status === 'blocked' ? Object.assign({}, a, { agent_status: 'working' }) : a)
    })
    assert(draw(clearFixture, { cols: 100 }).includes('all clear'), 'header shows all clear when none blocked')

    // done-children collapse
    assert(!frame.includes('Map planner impl'), 'collapsed done child is not rendered individually')
    assert(frame.includes('1 done'), 'done children collapse to one summary row')
    const expandedState = Object.assign({}, fixture, { expandedDone: new Set(['p1']) })
    assert(draw(expandedState, { cols: 100 }).includes('Map planner impl'), 'expandedDone renders the done child')

    ;[fixture, expandedState].forEach(st => {
      const rowCount = draw(st, { cols: 100 }).split('\n').length - 3 // header + column header + footer
      assert(flatten(st, { cols: 100 }).length === rowCount, 'flatten() length matches rendered tree row count')
    })

    // wide layout: briefing beside the tree, for each row type
    const fl = flatten(fixture, { cols: 140 })
    const idx = t => fl.findIndex(t)
    const wide = sel => strip(draw(Object.assign({}, fixture, { selected: sel }), { cols: 140 }))
    const sub = wide(idx(r => r.type === 'agent' && r.node.agentId === 'a2'))
    assert(sub.includes('SUBAGENT') && sub.includes('general-purpose'), 'subagent briefing')
    assert(sub.includes('spawned by') && sub.includes('m7-prep-planner'), 'spawned-by names the parent pane')
    assert(sub.includes('built-in (Claude Code)'), 'definition shown')
    assert(sub.includes('INSTRUCTION FILES (1)') && sub.includes('Project'), 'recorded instruction files')
    assert(sub.includes('simplify ×2') && sub.includes('12 available'), 'skills used and available')
    assert(sub.includes('Make pnpm lint pass'), 'task prompt')
    const pane = wide(idx(r => r.type === 'pane' && r.node.pane_id === 'p1'))
    assert(pane.includes('AGENT') && pane.includes('Anthropic'), 'agent briefing with provider')
    assert(pane.includes('~2k tok'), 'instruction file size estimate')
    assert(pane.includes('.remember'), 'memory & state listed')
    const ws = wide(idx(r => r.type === 'workspace' && r.node.id === 'ws2'))
    assert(ws.includes('PROJECT') && ws.includes('haiku-4.5'), 'project briefing has cost by model')
    const tok = strip(draw(Object.assign({}, fixture, { selected: idx(r => r.type === 'pane' && r.node.pane_id === 'p1'), panel: 'tokens' }), { cols: 140 }))
    assert(tok.includes('PROVIDER') && tok.includes('total'), 'tokens panel is a provider/model table')

    // scrolling: a short window shows a "more" marker
    const tall = strip(draw(Object.assign({}, fixture, { selected: idx(r => r.type === 'pane' && r.node.pane_id === 'p1') }), { cols: 140, rows: 12 }))
    assert(tall.includes('more · ] scroll'), 'briefing scroll marker when clipped')

    // context load: stacked bar + components, largest first, at 4 chars/token
    const withLoad = JSON.parse(JSON.stringify(fixture))
    withLoad.agents[0].session.children[1].context = { tools: 40000, files: 8000, skills: 30000, agents: 0, mcp: 0, deferred: 0, hooks: 2000, task: 0 }
    const loadFrame = strip(draw(Object.assign(withLoad, { selected: idx(r => r.type === 'agent' && r.node.agentId === 'a2') }), { cols: 140 }))
    assert(loadFrame.includes('CONTEXT LOAD  ~20k tok before any work'), 'context load total')
    assert(/tool schemas\s+~10k\s+50%/.test(loadFrame), 'largest component first with share')
    assert(loadFrame.indexOf('tool schemas') < loadFrame.indexOf('skill list'), 'sorted by size')
    assert(!loadFrame.includes('agent list'), 'empty components hidden')

    // blocked agent: its screen, and what y / n will send
    const blockedSel = idx(r => r.type === 'pane' && r.node.pane_id === 'p2')
    const scr = strip(draw(Object.assign({}, fixture, { selected: blockedSel, screens: { p2: 'Bash command\n\n  git push\n❯ 1. Yes\n  2. No\n' } }), { cols: 140 }))
    assert(scr.includes('WAITING FOR YOU') && scr.includes('1. Yes') && scr.includes('y approve (sends 1)'), 'blocked screen shown')

    // a pending action takes over the footer; a flash replaces it after
    const conf = strip(draw(Object.assign({}, fixture, { confirm: { label: 'approve w4 claude' } }), { cols: 100 }))
    assert(conf.split('\n').pop().includes('approve w4 claude — y confirm'), 'confirm bar in footer')
    const fl2 = strip(draw(Object.assign({}, fixture, { flash: { text: 'sent', until: fixture.now + 1000 } }), { cols: 100 }))
    assert(fl2.split('\n').pop().startsWith('sent'), 'flash message')

    // stalled age comes from the transcript, not blockedSince
    const stalled = Object.assign({}, fixture, { agents: [Object.assign({}, fixture.agents[0], { stalled: true, session: Object.assign({}, fixture.agents[0].session, { mtime: fixture.now - 180000 }) })] })
    assert(draw(stalled, { cols: 100 }).includes('stalled 3m'), 'stalled age measured from last transcript write')

    const asciiFrame = draw(fixture, { cols: 140, ascii: true })
    assert(!/[^\x00-\x7F]/.test(asciiFrame), 'ascii:true output is pure ASCII')
    assert(draw(Object.assign({}, fixture, { agents: [] }), { cols: 100 }).toLowerCase().includes('no running agents'), 'empty state')
    assert(draw(Object.assign({}, fixture, { connected: false }), { cols: 100 }).includes('herdr socket down'), 'disconnected banner')
    assert(!draw(fixture, { cols: 140, noColor: true }).includes('\x1b'), 'noColor strips ANSI')

    console.log('selftest OK')
  } else {
    // ponytail: env-var default lives only here in the CLI demo, per spec —
    // draw() itself stays pure and always takes opts.ascii explicitly.
    console.log(draw(fixture, { cols: process.stdout.columns || 140, ascii: process.env.MURMUR_ASCII === '1' }))
  }
}
