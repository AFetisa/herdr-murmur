'use strict'

// murmur context view (`c`) — where instructions and hooks go, fleet-wide.
// The tree answers "what did this agent get?"; this answers the reverse: "which agents
// got this file, and what does it cost across all of them?" plus which hooks eat time.
// Pure: aggregate() takes the agents app.js already scanned, draw() returns a string.

const { vlen, paint, padLine, reverseLine, truncate, fmtTokens, glyph, contextLines, shortPath, wrapText } = require('./render')

function num(x) { return (typeof x === 'number' && !Number.isNaN(x)) ? x : 0 }
function tok(ch) { return '~' + fmtTokens(Math.round(num(ch) / 4)) }
function fmtDur(ms) {
  ms = num(ms)
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'
  return (ms / 60000).toFixed(1) + 'm'
}

function label(agent, node) {
  if (node === agent.session) return (agent.agent || 'agent') + ' · ' + (node.gitBranch || agent.title || agent.pane_id)
  return (node.agentType || node.slug || 'agent') + (node.description ? ' "' + node.description + '"' : '')
}

function aggregate(agents) {
  const load = { tools: 0, files: 0, skills: 0, agents: 0, mcp: 0, deferred: 0, hooks: 0, task: 0 }
  const files = new Map(), hooks = new Map()
  let sessions = 0, subs = 0

  const visit = (agent, node) => {
    if (node === agent.session) sessions++; else subs++
    const who = label(agent, node)
    const c = node.context || {}
    for (const k of Object.keys(load)) load[k] += num(c[k])
    ;(node.instrFiles || []).forEach(f => {
      const key = String(f.path).toLowerCase()
      const e = files.get(key) || { path: f.path, type: f.type, chars: f.chars, loads: 0, total: 0, by: [] }
      e.loads++
      e.total += num(f.chars)
      e.by.push(who)
      files.set(key, e)
    })
    for (const [name, h] of Object.entries(node.hooks || {})) {
      const e = hooks.get(name) || { name, event: h.event, command: h.command, n: 0, ms: 0, err: 0, timeouts: 0, chars: 0, agents: 0 }
      e.n += h.n; e.ms += h.ms; e.err += h.err; e.timeouts += h.timeouts; e.chars += h.chars; e.agents++
      if (!e.command && h.command) e.command = h.command
      hooks.set(name, e)
    }
    ;(node.children || []).forEach(k => visit(agent, k))
  }
  ;(agents || []).forEach(a => { if (a.session) visit(a, a.session) })

  return {
    load, sessions, subs,
    files: [...files.values()].sort((a, b) => b.total - a.total),
    hooks: [...hooks.values()].sort((a, b) => b.ms - a.ms)
  }
}

// Selectable rows, in display order: files first, then hooks.
function items(data) {
  return (data.files || []).map(f => ({ kind: 'file', v: f })).concat((data.hooks || []).map(h => ({ kind: 'hook', v: h })))
}

function cell(s, w, right) {
  s = s == null ? '' : String(s)
  const v = vlen(s)
  if (v > w) return truncate(s, w, !right)
  return right ? ' '.repeat(w - v) + s : s + ' '.repeat(w - v)
}

function fileRow(f, cols, noColor) {
  const fixed = 9 + 7 + 9 + 10 + 4
  return cell(paint(f.type, 'cyan', noColor), 9) + ' ' + cell(truncate(shortPath(f.path), cols - fixed, true), cols - fixed) + ' ' +
    cell(f.loads + '×', 7, true) + ' ' + cell(tok(f.chars), 9, true) + ' ' + cell(paint(tok(f.total), 'bold', noColor), 10, true)
}

function hookIssues(h) {
  const bits = []
  if (h.timeouts) bits.push(h.timeouts + ' timeout' + (h.timeouts > 1 ? 's' : ''))
  if (h.err) bits.push(h.err + ' error' + (h.err > 1 ? 's' : ''))
  return bits.join(', ')
}

function hookRow(h, cols, noColor) {
  const fixed = 6 + 8 + 8 + 9 + 14 + 5
  const issues = hookIssues(h)
  return cell(h.name, cols - fixed) + ' ' + cell(h.n, 6, true) + ' ' + cell(paint(fmtDur(h.ms), h.ms >= 60000 ? 'yellow' : null, noColor), 8, true) + ' ' +
    cell(fmtDur(h.n ? h.ms / h.n : 0), 8, true) + ' ' + cell(h.chars ? tok(h.chars) : '-', 9, true) + ' ' +
    cell(issues ? paint(issues, 'yellow', noColor) : '', 14, true)
}

function expandedLines(it, cols, noColor) {
  const pad = '    '
  const w = Math.max(10, cols - pad.length)
  if (it.kind === 'file') {
    const f = it.v
    return [paint(pad + 'loaded by ' + f.loads + ':', 'dim', noColor)]
      .concat(f.by.slice(0, 12).map(b => pad + '· ' + truncate(b, w - 2)))
      .concat(f.by.length > 12 ? [paint(pad + '… ' + (f.by.length - 12) + ' more', 'dim', noColor)] : [])
      .concat([paint(pad + shortPath(f.path), 'dim', noColor)])
  }
  const h = it.v
  const out = [paint(pad + (h.event || 'hook') + ' · ' + h.agents + ' agent' + (h.agents > 1 ? 's' : '') + ' · injected ' + (h.chars ? tok(h.chars) + ' tok into context' : 'nothing into context'), 'dim', noColor)]
  if (h.command) wrapText(h.command, w).slice(0, 4).forEach(l => out.push(pad + l))
  return out
}

function drawContext(data, opts) {
  opts = opts || {}
  const cols = Math.max(40, opts.cols || 100)
  const noColor = !!opts.noColor
  const list = items(data || {})
  const sel = Math.min(Math.max(0, opts.selected || 0), Math.max(0, list.length - 1))
  const lines = []
  const loadTotal = Object.values((data && data.load) || {}).reduce((s, x) => s + num(x), 0)
  const title = 'murmur · context ─ ' + num(data && data.sessions) + ' agents · ' + num(data && data.subs) + ' subagents · ' + tok(loadTotal) + ' tok loaded in total'
  lines.push(title + ' ' + paint('─'.repeat(Math.max(0, cols - vlen(title) - 1)), 'dim', noColor))

  if (!list.length && !loadTotal) {
    lines.push('', paint('No context records yet. They appear once an agent in Herdr has started a Claude Code session.', 'dim', noColor))
    return lines.map(l => padLine(glyph(l, opts.ascii), cols)).join('\n')
  }

  // Fleet load: same bar as the briefing, summed over every agent and subagent.
  const spawns = num(data.sessions) + num(data.subs)
  lines.push(...contextLines({ context: data.load }, cols, noColor).map((l, i) => i === 0
    ? paint(('FLEET LOAD  ' + tok(loadTotal) + ' tok · avg ' + tok(spawns ? loadTotal / spawns : 0) + ' per agent ' + '─'.repeat(cols)).slice(0, cols), 'dim', noColor)
    : l))

  const selLine = { at: 0 }
  const rowsFor = (kind, head, draw) => {
    lines.push('', paint(head, 'dim', noColor))
    list.forEach((it, i) => {
      if (it.kind !== kind) return
      const ln = draw(it.v, cols, noColor)
      if (i === sel) { selLine.at = lines.length; lines.push(reverseLine(ln, cols, noColor)) } else lines.push(ln)
      if (i === sel && opts.expanded) lines.push(...expandedLines(it, cols, noColor))
    })
  }
  const fixedF = 9 + 7 + 9 + 10 + 4
  rowsFor('file', 'INSTRUCTION FILES'.padEnd(10 + cols - fixedF) + ' ' + cell('LOADS', 7, true) + ' ' + cell('EACH', 9, true) + ' ' + cell('TOTAL', 10, true), fileRow)
  const fixedH = 6 + 8 + 8 + 9 + 14 + 5
  rowsFor('hook', cell('HOOKS', cols - fixedH) + ' ' + cell('RUNS', 6, true) + ' ' + cell('TIME', 8, true) + ' ' + cell('AVG', 8, true) + ' ' + cell('INJECTED', 9, true) + ' ' + cell('ISSUES', 14, true), hookRow)

  // Keep the selected row on screen: scroll the body, header line stays.
  const footer = paint(truncate('↑↓ select · ⏎ details · r rescan · c/esc back · q quit', cols), 'dim', noColor)
  let body = lines.slice(1)
  const room = opts.rows ? Math.max(3, opts.rows - 2) : body.length
  if (body.length > room) {
    const want = selLine.at - 1
    const start = Math.max(0, Math.min(want - Math.floor(room / 2), body.length - room))
    body = body.slice(start, start + room)
  }
  return [lines[0]].concat(body, [footer]).map(l => padLine(glyph(l, opts.ascii), cols)).join('\n')
}

module.exports = { aggregate, drawContext, items }

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert')
  const { strip } = require('./render')
  const sub = {
    agentType: 'code-reviewer', description: 'Review diff', children: [],
    instrFiles: [{ type: 'User', path: '/h/.claude/CLAUDE.md', chars: 4000 }],
    context: { tools: 4000, files: 4000, skills: 0, agents: 0, mcp: 0, deferred: 0, hooks: 0, task: 400 },
    hooks: { 'PostToolUse:Bash': { n: 10, ms: 5000, err: 1, timeouts: 0, chars: 0, event: 'PostToolUse', command: 'node fmt.js' } }
  }
  const session = {
    gitBranch: 'main', children: [sub],
    instrFiles: [{ type: 'User', path: '/h/.claude/CLAUDE.md', chars: 4000 }, { type: 'Project', path: '/r/CLAUDE.md', chars: 800 }],
    context: { tools: 8000, files: 4800, skills: 30000, agents: 0, mcp: 0, deferred: 0, hooks: 2000, task: 100 },
    hooks: {
      Stop: { n: 3, ms: 90000, err: 0, timeouts: 2, chars: 0, event: 'Stop', command: 'node worker.js session-complete' },
      'PostToolUse:Bash': { n: 5, ms: 1000, err: 0, timeouts: 0, chars: 0, event: 'PostToolUse', command: '' }
    }
  }
  const data = aggregate([{ pane_id: 'p1', agent: 'claude', session }, { pane_id: 'p2', agent: 'claude', session: null }])

  assert.strictEqual(data.sessions, 1)
  assert.strictEqual(data.subs, 1)
  assert.strictEqual(data.load.tools, 12000, 'load summed across session + subagent')
  assert.strictEqual(data.files[0].path, '/h/.claude/CLAUDE.md', 'files ranked by total')
  assert.strictEqual(data.files[0].loads, 2)
  assert.strictEqual(data.files[0].total, 8000)
  assert.deepStrictEqual(data.files[0].by, ['claude · main', 'code-reviewer "Review diff"'])
  assert.strictEqual(data.hooks[0].name, 'Stop', 'hooks ranked by time')
  const bash = data.hooks.find(h => h.name === 'PostToolUse:Bash')
  assert.deepStrictEqual([bash.n, bash.ms, bash.err, bash.agents, bash.command], [15, 6000, 1, 2, 'node fmt.js'])

  ;[40, 80, 120, 160].forEach(cols => {
    for (let s = 0; s < 4; s++) {
      drawContext(data, { cols, rows: 20, selected: s, expanded: true }).split('\n')
        .forEach(l => assert.ok(vlen(l) <= cols, `width ${cols}: "${strip(l)}"`))
    }
  })
  const f = strip(drawContext(data, { cols: 120, selected: 0, expanded: true }))
  assert.ok(f.includes('FLEET LOAD') && f.includes('skill list'), 'fleet load bar')
  assert.ok(f.includes('loaded by 2:') && f.includes('code-reviewer "Review diff"'), 'file expands to its agents')
  const h = strip(drawContext(data, { cols: 120, selected: 2, expanded: true }))
  assert.ok(/Stop\s+3\s+1\.5m\s+30s\s+-\s+2 timeouts/.test(h), 'hook row: runs, time, avg, issues')
  assert.ok(h.includes('node worker.js session-complete'), 'hook expands to its command')
  const tiny = drawContext(data, { cols: 120, rows: 8, selected: 3 }).split('\n')
  assert.strictEqual(tiny.length, 8, 'fits the given rows')
  assert.ok(strip(tiny.join('\n')).includes('PostToolUse:Bash'), 'selected row scrolled into view')
  assert.ok(!/[^\x00-\x7F]/.test(drawContext(data, { cols: 120, ascii: true, expanded: true })), 'ascii mode is pure ASCII')
  assert.ok(strip(drawContext({ files: [], hooks: [], load: {} }, { cols: 80 })).includes('No context records yet'), 'empty state')
  console.log('selftest OK')
}
