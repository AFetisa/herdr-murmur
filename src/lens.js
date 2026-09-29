'use strict'

// murmur skill lens — inverted index over skills.js's aggregate() rows,
// answering "which skills / subagent types are pulling their weight?"
// Pure string building, zero deps. Reuses render.js's helpers rather than
// re-implementing width/color/wrap plumbing.

const { vlen, paint, fmtCost, truncate, padLine, joinLR, reverseLine, wrapText } = require('./render')

function num(x) { return (typeof x === 'number' && !Number.isNaN(x)) ? x : 0 }

// left-align, truncate-with-… to width w
function padKey(s, w) {
  const t = truncate(s, w)
  return t + ' '.repeat(Math.max(0, w - t.length))
}

// right-align (numeric columns) to width w
function padR(s, w) {
  s = String(s)
  if (s.length >= w) return s.slice(0, w)
  return ' '.repeat(w - s.length) + s
}

function healthOf(row) {
  const flags = Array.isArray(row.flags) ? row.flags : []
  if (!flags.length) return { text: 'ok', color: 'dim' }
  const names = flags.map(f => f && f.flag).filter(Boolean).join(' ')
  const anyWarn = flags.some(f => f && f.severity === 'warn')
  return { text: '⚑ ' + names, color: anyWarn ? 'red' : 'yellow' }
}

function rowLine(row, w, showErr, showTools, noColor) {
  const key = padKey(String(row.key || '-'), w.key)
  const uses = padR(row.uses != null ? String(Math.round(num(row.uses))) : '-', w.uses)
  // A "~" marks a cost this row does not strictly own: skills, MCP servers and slash
  // commands get their share of the agent they ran inside. Showing an estimate with
  // the same authority as a measured number is how dashboards mislead.
  const costText = fmtCost(typeof row.cost === 'number' ? row.cost : NaN)
  const cost = padR(row.estimated && costText !== '-' ? '~' + costText : costText, w.cost)
  let line = key + ' ' + uses + ' ' + cost

  if (showErr) {
    const ep = row.errorRate != null && !Number.isNaN(row.errorRate) ? row.errorRate * 100 : null
    const errText = ep == null ? '-' : Math.round(ep) + '%'
    const errColor = ep == null ? 'dim' : ep > 20 ? 'red' : ep > 5 ? 'yellow' : 'dim'
    line += ' ' + paint(padR(errText, w.err), errColor, noColor)
  }
  if (showTools) {
    const at = row.avgTools != null && !Number.isNaN(row.avgTools) ? String(Math.round(row.avgTools)) : '-'
    line += ' ' + padR(at, w.tools)
  }
  const h = healthOf(row)
  line += ' ' + paint(padKey(h.text, w.health), h.color, noColor)
  return line
}

function expandedLines(row, cols, noColor) {
  const out = []
  const agents = Array.isArray(row.agents) ? row.agents : []
  agents.slice(0, 8).forEach(a => {
    const label = (a && a.label) || '-'
    const cost = fmtCost(a && typeof a.cost === 'number' ? a.cost : NaN)
    const er = a && a.errorRate != null && !Number.isNaN(a.errorRate) ? Math.round(a.errorRate * 100) + '%' : '-'
    const left = '    ' + truncate(label, Math.max(4, cols - 20))
    out.push(paint(joinLR(left, cost + '  ' + er, cols), 'dim', noColor))
  })
  if (agents.length > 8) out.push(paint('    +' + (agents.length - 8) + ' more', 'dim', noColor))

  const flags = Array.isArray(row.flags) ? row.flags : []
  flags.forEach(f => {
    const reason = f && f.reason
    if (!reason) return
    wrapText(reason, Math.max(10, cols - 6)).forEach(l => {
      out.push(paint('    ' + l, f.severity === 'warn' ? 'red' : 'yellow', noColor))
    })
  })
  return out
}

function emptyState(cols, noColor) {
  const lines = [
    'murmur · skill lens',
    '',
    'no skill or subagent activity has been recorded yet.',
    'this view fills in once agents run.'
  ]
  return lines.map(l => padLine(l ? paint(l, 'dim', noColor) : l, cols)).join('\n')
}

function drawLens(rows, opts) {
  opts = opts || {}
  const cols = Math.max(20, opts.cols || 100)
  const noColor = !!opts.noColor
  const selected = opts.selected
  const expanded = !!opts.expanded
  rows = Array.isArray(rows) ? rows : []

  if (!rows.length) return emptyState(cols, noColor)

  const showTools = cols >= 80
  const showErr = cols >= 64
  const w = {
    uses: 6, cost: 7, err: 5, tools: 9,
    health: Math.max(12, showTools ? 20 : (showErr ? 16 : cols - 30))
  }
  const reserved = w.uses + w.cost + (showErr ? w.err : 0) + (showTools ? w.tools : 0) + w.health
  const gaps = 2 + (showErr ? 1 : 0) + (showTools ? 1 : 0) + 1 // one gap before each column
  w.key = Math.max(8, cols - reserved - gaps)

  const lines = []
  const flagged = rows.filter(r => (r.flags || []).length).length
  const title = `murmur · skill lens ─ ${rows.length} skills · ${flagged} flagged`
  lines.push(title + ' ' + '─'.repeat(Math.max(0, cols - vlen(title) - 1)))

  let hdr = padKey('SKILL / AGENT TYPE', w.key) + ' ' + padR('USES', w.uses) + ' ' + padR('COST', w.cost)
  if (showErr) hdr += ' ' + padR('ERR', w.err)
  if (showTools) hdr += ' ' + padR('AVG TOOLS', w.tools)
  hdr += ' ' + padKey('HEALTH', w.health)
  lines.push(paint(hdr, 'dim', noColor))

  rows.forEach((row, i) => {
    const line = rowLine(row, w, showErr, showTools, noColor)
    const isSel = selected === i
    lines.push(isSel ? reverseLine(line, cols, noColor) : line)
    if (isSel && expanded) lines.push(...expandedLines(row, cols, noColor))
  })

  return lines.map(l => padLine(l, cols)).join('\n')
}

module.exports = { drawLens }

// ---- self-test / demo ----

if (require.main === module) {
  const fixtureRows = [
    {
      key: 'general-purpose', kind: 'agentType', uses: 19, cost: 28.40, errors: 12, errorRate: 0.11, avgTools: 47,
      agents: [
        { label: 'w4 fix-lint-gate', cost: 0.71, errorRate: 0.2 },
        { label: 'w2 prep-planner', cost: 1.84, errorRate: 0 }
      ],
      flags: [{ flag: 'thrashing', severity: 'warn', reason: '47 tool calls, no file writes — probably stuck exploring instead of making progress.' }]
    },
    { key: 'superpowers:brainstorming', kind: 'skill', uses: 6, cost: 3.10, errors: 0, errorRate: 0, avgTools: 8, agents: [], flags: [] },
    {
      key: 'firecrawl:scrape', kind: 'mcp', uses: 12, cost: 0.90, errors: 4, errorRate: 0.33, avgTools: 3,
      agents: [], flags: [{ flag: 'flaky', severity: 'info', reason: 'intermittent timeouts on scrape calls, usually resolves on retry.' }]
    },
    {
      key: 'Explore', kind: 'agentType', uses: 2, cost: 6.80, errors: 0, errorRate: 0, avgTools: 88,
      agents: [], flags: [{ flag: 'expensive', severity: 'warn', reason: 'unusually high token spend for only two uses.' }]
    }
  ]

  if (process.argv.includes('--selftest')) {
    const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }

    ;[40, 64, 80, 100, 140].forEach(cols => {
      const out = drawLens(fixtureRows, { cols })
      out.split('\n').forEach(l => assert(vlen(l) <= cols, `lens line width <= ${cols}: "${l}"`))
    })

    const withExpanded = drawLens(fixtureRows, { cols: 100, selected: 0, expanded: true })
    assert(typeof withExpanded === 'string', 'expanded renders')
    assert(withExpanded.includes('thrashing'), 'expanded still shows the flag name in HEALTH')
    assert(withExpanded.includes('probably stuck exploring'), 'expanded shows flag reason sentence')
    assert(withExpanded.includes('fix-lint-gate'), 'expanded shows per-agent rows')

    const plain = drawLens(fixtureRows, { cols: 100, noColor: true })
    assert(!plain.includes('\x1b'), 'noColor strips ANSI')

    const infoOnly = drawLens([fixtureRows[2]], { cols: 100, selected: 0, expanded: true })
    assert(infoOnly.includes('flaky'), 'info-severity flag renders')

    const noFlags = drawLens([fixtureRows[1]], { cols: 100 })
    assert(noFlags.includes('ok'), 'no-flags row shows ok health')

    const empty = drawLens([], { cols: 100 })
    assert(empty.toLowerCase().includes('no skill or subagent activity'), 'empty state explains no activity yet')

    ;[fixtureRows, [], null, undefined, [{}]].forEach(r => { drawLens(r, { cols: 100 }) }) // must not throw

    console.log('selftest OK')
  } else {
    console.log(drawLens(fixtureRows, { cols: process.stdout.columns || 100 }))
  }
}
