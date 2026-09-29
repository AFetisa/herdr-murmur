'use strict'

// murmur inventory — reconciles what's INSTALLED (plugins, the MCP servers/
// skills/agents they contribute, user-configured MCP servers, connectors)
// against what's ACTUALLY BEEN USED (Claude Code's own skillUsage/pluginUsage
// counters, plus a bounded scan of recent transcripts for MCP-server and
// subagent-type calls, neither of which gets a persistent counter). The point
// is the negative space: installed-and-never-called is the headline.
//
// Rows are restricted to things with an actual on/off switch -- plugins, MCP
// servers, connectors. You can't individually disable one skill inside a
// plugin, so a skill's usage is evidence rolled into its plugin's row (see
// `contributes`), not a row of its own. This view drives deletions, so a
// false "never used" is the worst failure mode: a 0 usage-counter is only
// trusted when nothing else contradicts it (see verdictFor), and an orphan
// is only flagged when we can actually confirm the thing used to be real
// (see isRealRemovedPlugin). Zero deps, reuses render.js's string plumbing
// and skills.js's profiler.
//
// SECURITY: this module reads MCP server definitions only to list SERVER
// NAMES (Object.keys of an mcpServers object). It never reads/returns/logs
// any value nested under env/headers/args/command/url/token — see
// pluginMcpServers() and localServerNames() below, the only two places that
// touch a config file containing those keys.

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { vlen, paint, truncate, fmtAge, padLine, reverseLine, wrapText, glyph } = require('./render')
const skills = require('./skills')

const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')
const PROJECTS_ROOT = path.join(CLAUDE_DIR, 'projects')
const CACHE_FILE = path.join(process.env.HERDR_PLUGIN_STATE_DIR || os.tmpdir(), 'murmur-inventory-cache.json')

// ---- classify: which of the three mcp__ name shapes is this? ----

function classify(toolName) {
  const name = String(toolName || '')
  if (!name.startsWith('mcp__')) return { kind: 'local', plugin: null, server: null }
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  const server = sep === -1 ? rest : rest.slice(0, sep)
  if (server.startsWith('plugin_')) {
    const body = server.slice('plugin_'.length)
    // ponytail: plugin short-names use hyphens not underscores (see installed_plugins.json),
    // so the first underscore in the body is always the plugin/server boundary.
    const us = body.indexOf('_')
    const plugin = us === -1 ? body : body.slice(0, us)
    const srv = us === -1 ? body : body.slice(us + 1)
    return { kind: 'plugin', plugin, server: srv }
  }
  if (server.startsWith('claude_ai_')) {
    return { kind: 'connector', plugin: null, server: server.slice('claude_ai_'.length) }
  }
  return { kind: 'local', plugin: null, server }
}

// ---- verdictFor ----

function sinceText(ms, now) {
  const age = now - ms
  return age < 86400000 ? 'today' : Math.floor(age / 86400000) + 'd ago'
}

function verdictFor(row, opts) {
  opts = opts || {}
  row = row || {}
  const idleDays = opts.idleDays != null ? opts.idleDays : 30
  const lookbackDays = opts.lookbackDays != null ? opts.lookbackDays : 30
  const now = opts.now || Date.now()

  if (row.installed === false) {
    const n = row.uses || 0
    return {
      verdict: 'orphaned',
      reason: `${n} use${n === 1 ? '' : 's'} recorded for "${row.name}", but it is not currently installed — this config entry is stale and can be cleaned up.`
    }
  }

  if (!row.uses) {
    // A 0 usageCount can still coexist with a real lastUsedAt -- Claude Code doesn't
    // increment every counter for every interaction type. This view drives deletions,
    // so trusting a zero over a timestamp that contradicts it is the worst failure
    // mode it can have: the timestamp always wins, and the reason says the counter
    // is unreliable rather than asserting the thing was never used.
    if (row.lastUsed != null) {
      const ageDays = Math.floor((now - row.lastUsed) / 86400000)
      const reason = `no recorded invocations, but last active ${sinceText(row.lastUsed, now)} — counter unreliable for this entry.`
      return { verdict: ageDays > idleDays ? 'idle' : 'active', reason }
    }
    if (row.evidence === 'transcript') {
      return { verdict: 'never used', reason: `not seen in the last ${lookbackDays}d of scanned transcripts — installed, but no evidence of use in that window.` }
    }
    if (row.evidence === 'counter') {
      return { verdict: 'never used', reason: `installed but never used (0 uses recorded) — a disable candidate.` }
    }
    return { verdict: 'never used', reason: `no usage evidence available for "${row.name}" — neither a usage counter nor a transcript scan covers it.` }
  }
  if (row.lastUsed != null) {
    const ageDays = Math.floor((now - row.lastUsed) / 86400000)
    if (ageDays > idleDays) return { verdict: 'idle', reason: `not called in ${ageDays}d.` }
  }
  return { verdict: 'active', reason: `used ${row.uses} time${row.uses === 1 ? '' : 's'}.` }
}

// Evidence for a plugin's own verdict: how much of what it ships ever ran.
// This is what actually justifies disabling a whole plugin -- one unused
// skill proves little, "0 of 11 skills and 0 of 4 agents" does.
function contributesNote(contributes, lookbackDays) {
  if (!contributes) return ''
  const parts = []
  if (contributes.skills.shipped) parts.push(`${contributes.skills.used} of ${contributes.skills.shipped} skills`)
  if (contributes.agents.shipped) parts.push(`${contributes.agents.used} of ${contributes.agents.shipped} agents`)
  return parts.length ? `${parts.join(' and ')} used in ${lookbackDays}d` : ''
}

// ---- disk-level helpers (all best-effort; never throw) ----

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function pluginMcpServers(installPath) {
  const j = readJson(path.join(installPath, '.mcp.json'))
  if (!j) return []
  // ponytail: two real shapes seen in the wild -- some plugins wrap server defs in
  // {mcpServers:{...}} (figma, context7, vercel), others put them directly at the
  // top level (github, supabase, playwright). Missing the bare shape silently
  // dropped those plugins' servers from the inventory entirely -- worse than
  // flagging them wrong, they'd just never appear. Names only either way.
  return Object.keys(j.mcpServers || j)
}

function dirNames(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
}

function mdBaseNames(p) {
  try { return fs.readdirSync(p).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) } catch { return [] }
}

function activeEntry(entries) {
  return entries.slice().sort((a, b) =>
    new Date(b.lastUpdated || b.installedAt || 0) - new Date(a.lastUpdated || a.installedAt || 0))[0]
}

function localServerNames(claudeJson) {
  const set = new Set()
  const addAll = (v) => {
    if (!v) return
    if (Array.isArray(v)) v.forEach(x => { if (typeof x === 'string') set.add(x) })
    else Object.keys(v).forEach(k => set.add(k)) // names only -- never the values
  }
  addAll(claudeJson.mcpServers)
  Object.values(claudeJson.projects || {}).forEach(p => {
    if (!p) return
    addAll(p.mcpServers)
    addAll(p.enabledMcpjsonServers)
  })
  return set
}

// A pluginUsage key like "data@inline" or "operations@synced" is an internal
// connector-category bundle, not something the user ever installed as a
// plugin -- flagging it "orphaned" would tell someone to clean up a config
// entry that was never theirs to remove. Only flag a genuinely removed
// plugin: not currently installed, AND its marketplace is one we can
// confirm was ever real (known_marketplaces.json). Can't confirm -> don't flag.
const NON_PLUGIN_MARKETPLACE_SUFFIXES = new Set(['inline', 'synced', 'builtin'])

function isRealRemovedPlugin(key, installedPlugins, knownMarketplaceNames) {
  if (installedPlugins[key]) return false
  const i = key.lastIndexOf('@')
  if (i === -1) return false
  const marketplace = key.slice(i + 1)
  if (NON_PLUGIN_MARKETPLACE_SUFFIXES.has(marketplace)) return false
  return knownMarketplaceNames.has(marketplace)
}

// Same "don't guess" rule for skillUsage keys. A "plugin:skill" key names its plugin,
// so it's real evidence either way (drift under an installed plugin, or a genuine
// orphan if that plugin is gone). A BARE (colon-free) key -- "init", "claude-api",
// "schedule" -- names no plugin at all; on this machine roughly half of those are
// live built-in skills, not leftovers, and there is no local signal that tells them
// apart. So a bare key is never orphan evidence and never claims a plugin, full stop.
function classifySkillOrphan(name, claimedSkills, installedShortNames) {
  if (claimedSkills.has(name)) return null
  if (!name.includes(':')) return null
  const ns = name.slice(0, name.indexOf(':'))
  return { ns, installed: installedShortNames.has(ns) }
}

// ---- transcript scan: MCP-server calls, skill calls, subagent-type spawns,
// bounded to files whose mtime falls in the lookback window. Disk-cached by
// path+mtime (on top of skills.profile()'s own in-memory cache) so a rescan
// across process runs is near-instant.

function loadCache() { return readJson(CACHE_FILE) || {} }
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)) } catch {} // best-effort; a stale/missing cache just costs one slow run
}

function bump(map, key, uses, label, mtimeMs) {
  if (!key || !uses) return
  let e = map.get(key)
  if (!e) { e = { uses: 0, lastUsed: null, agents: new Map() }; map.set(key, e) }
  e.uses += uses
  if (!e.lastUsed || mtimeMs > e.lastUsed) e.lastUsed = mtimeMs
  e.agents.set(label, (e.agents.get(label) || 0) + uses)
}

function shortLabel(slug) {
  return String(slug || '').replace(/^[A-Za-z]--/, '') // ponytail: slug->path is lossy (dashes vs separators); shown verbatim minus the drive prefix
}

// Subagent identity comes straight from <projectDir>/<sessionId>/subagents/agent-*.meta.json,
// which carries {"agentType": "general-purpose", ...} for every spawn -- see claude.js's
// buildChildren(). That's the only place a subagent type is ever recorded, so it's also
// the only evidence an "agent" contribution has; there is no persistent counter for it.
function scanTranscripts(lookbackDays, now) {
  const cutoff = now - lookbackDays * 86400000
  const mcpUses = new Map()      // raw skills.js server key ("plugin_figma_figma", "supabase", "claude_ai_Gmail") -> {uses,lastUsed,agents}
  const skillUses = new Map()    // skill name as it appears in skillUsage -> {uses,lastUsed,agents}
  const agentTypeUses = new Map() // subagent agentType -> {uses,lastUsed,agents}
  let filesScanned = 0
  const cache = loadCache()
  let dirty = false

  function profileCached(file, mtimeMs) {
    const key = file + ':' + mtimeMs
    if (cache[key]) return cache[key]
    const p = skills.profile(file)
    if (!p) return null
    const slim = {
      skills: p.skills.map(s => ({ name: s.name, uses: s.uses })),
      mcp: p.mcp.map(m => ({ server: m.server, uses: m.uses }))
    }
    cache[key] = slim
    dirty = true
    return slim
  }

  let projectDirs
  try { projectDirs = dirNames(PROJECTS_ROOT) } catch { projectDirs = [] }

  for (const d of projectDirs) {
    const dir = path.join(PROJECTS_ROOT, d)
    let files
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    const label = shortLabel(d)

    for (const f of files) {
      const fp = path.join(dir, f)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (st.mtimeMs < cutoff) continue
      filesScanned++
      const p = profileCached(fp, st.mtimeMs)
      if (!p) continue
      p.skills.forEach(s => bump(skillUses, s.name, s.uses, label, st.mtimeMs))
      p.mcp.forEach(m => bump(mcpUses, m.server, m.uses, label, st.mtimeMs))

      const subDir = path.join(dir, f.replace(/\.jsonl$/, ''), 'subagents')
      let metas
      try { metas = fs.readdirSync(subDir).filter(x => x.endsWith('.meta.json')) } catch { continue }
      for (const m of metas) {
        const jp = path.join(subDir, m.replace(/\.meta\.json$/, '') + '.jsonl')
        let st2
        try { st2 = fs.statSync(jp) } catch { continue }
        if (st2.mtimeMs < cutoff) continue
        filesScanned++
        const meta = readJson(path.join(subDir, m)) || {}
        const agentType = meta.agentType || meta.slug || null
        if (agentType) bump(agentTypeUses, agentType, 1, label, st2.mtimeMs)
        const p2 = profileCached(jp, st2.mtimeMs)
        if (!p2) continue
        const subLabel = agentType || label
        p2.skills.forEach(s => bump(skillUses, s.name, s.uses, subLabel, st2.mtimeMs))
        p2.mcp.forEach(mm => bump(mcpUses, mm.server, mm.uses, subLabel, st2.mtimeMs))
      }
    }
  }

  if (dirty) saveCache(cache)
  return { mcpUses, skillUses, agentTypeUses, filesScanned }
}

function toAgents(entry) {
  if (!entry) return []
  return [...entry.agents.entries()].map(([label, uses]) => ({ label, uses })).sort((a, b) => b.uses - a.uses)
}

function mergeAgentsInto(combined, entry) {
  if (!entry) return
  entry.agents.forEach((u, l) => combined.set(l, (combined.get(l) || 0) + u))
}

// ---- build ----

function build(opts) {
  opts = opts || {}
  const lookbackDays = opts.lookbackDays || 30
  const idleDays = opts.idleDays || 30
  const now = opts.now || Date.now()

  try {
    const pluginsJson = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))
    const installedPlugins = (pluginsJson && pluginsJson.plugins) || {}
    const claudeJson = readJson(path.join(HOME, '.claude.json')) || {}
    const skillUsage = claudeJson.skillUsage || {}
    const pluginUsage = claudeJson.pluginUsage || {}
    const knownMarketplaceNames = new Set(Object.keys(readJson(path.join(CLAUDE_DIR, 'plugins', 'known_marketplaces.json')) || {}))
    const t = scanTranscripts(lookbackDays, now)

    const rows = []
    const claimedSkills = new Set()
    const pluginRowByShort = new Map()

    // plugins, and every skill/agent/mcp-server they contribute. Skills and agents
    // don't get their own rows -- there's no individual on/off switch for one skill
    // inside a plugin -- they roll up into `contributes`, the evidence for the
    // plugin's own verdict. MCP servers DO get their own switch (a plugin's
    // .mcp.json entry can be disabled independently), so those stay top-level rows.
    for (const key of Object.keys(installedPlugins)) {
      const entries = installedPlugins[key] || []
      if (!entries.length) continue
      const active = activeEntry(entries)
      const installPath = active.installPath
      const pluginShort = key.split('@')[0]
      const usageRec = pluginUsage[key]
      const combinedAgents = new Map()

      const contributes = { skills: { shipped: 0, used: 0, unused: [] }, agents: { shipped: 0, used: 0, unused: [] }, mcp: [] }

      if (installPath) {
        const mcpServers = pluginMcpServers(installPath)
        contributes.mcp = mcpServers
        mcpServers.forEach(server => {
          const rawKey = `plugin_${pluginShort}_${server}`
          const entry = t.mcpUses.get(rawKey)
          mergeAgentsInto(combinedAgents, entry)
          rows.push({
            kind: 'mcp', name: rawKey, source: `${pluginShort} plugin`, installed: true,
            uses: entry ? entry.uses : 0, evidence: 'transcript',
            lastUsed: entry ? entry.lastUsed : null, staleVersions: 0, agents: toAgents(entry)
          })
        })

        const skillList = dirNames(path.join(installPath, 'skills')).map(d => {
          const name = `${pluginShort}:${d}`
          claimedSkills.add(name)
          const usage = skillUsage[name]
          mergeAgentsInto(combinedAgents, t.skillUses.get(name))
          return { name, uses: usage ? usage.usageCount : 0 }
        })
        contributes.skills = {
          shipped: skillList.length,
          used: skillList.filter(s => s.uses > 0).length,
          unused: skillList.filter(s => s.uses === 0).map(s => s.name)
        }

        const agentList = mdBaseNames(path.join(installPath, 'agents')).map(a => {
          const entry = t.agentTypeUses.get(a)
          mergeAgentsInto(combinedAgents, entry)
          return { name: a, uses: entry ? entry.uses : 0 }
        })
        contributes.agents = {
          shipped: agentList.length,
          used: agentList.filter(a => a.uses > 0).length,
          unused: agentList.filter(a => a.uses === 0).map(a => a.name)
        }
      }

      const row = {
        kind: 'plugin', name: key, source: 'marketplace', installed: true,
        uses: usageRec ? usageRec.usageCount : 0, evidence: 'counter',
        lastUsed: usageRec ? usageRec.lastUsedAt : null,
        staleVersions: entries.length - 1, contributes,
        agents: [...combinedAgents.entries()].map(([label, uses]) => ({ label, uses })).sort((a, b) => b.uses - a.uses)
      }
      rows.push(row)
      pluginRowByShort.set(pluginShort, row)
    }

    // orphaned plugin usage records -- only when we can confirm the marketplace was real
    for (const key of Object.keys(pluginUsage)) {
      if (!isRealRemovedPlugin(key, installedPlugins, knownMarketplaceNames)) continue
      const usage = pluginUsage[key]
      rows.push({
        kind: 'plugin', name: key, source: '(not installed)', installed: false,
        uses: usage.usageCount, evidence: 'counter', lastUsed: usage.lastUsedAt,
        staleVersions: 0, agents: []
      })
    }

    // user-defined skills (~/.claude/skills/*) have no parent plugin to roll into and
    // no on/off switch murmur can usefully surface -- not a row, but still claimed so
    // they never get mistaken for orphaned usage below.
    dirNames(path.join(CLAUDE_DIR, 'skills')).forEach(name => claimedSkills.add(name))

    // orphaned skill usage: grouped into ONE row per removed plugin/namespace rather
    // than one row per skill (a removed plugin can leave a dozen skill entries behind).
    // A "plugin:skill" namespace that still matches an installed plugin (e.g. a
    // "vercel:deploy" usage record for a skill the vercel plugin no longer ships)
    // isn't a removed plugin -- it's drift under a plugin that's still here, so it's
    // folded into that plugin's row instead of becoming a new one.
    //
    // A BARE (colon-free) skillUsage key -- "init", "schedule", "claude-api" -- is
    // never treated as plugin evidence at all. Namespaced keys ("plugin:skill") name
    // their plugin; bare keys don't, and on this machine roughly half of them are
    // live built-in skills (claude-api, artifact-design, run, ...), not leftovers
    // from anything removed. There is no reliable way to tell a bare built-in from a
    // bare leftover from local state alone, and this view drives deletions -- a wrong
    // "(removed)" label here is the most damaging thing it can produce. So: no
    // positive evidence, no row, full stop.
    const installedShortNames = new Set(pluginRowByShort.keys())
    const orphanGroups = new Map()
    for (const name of Object.keys(skillUsage)) {
      const c = classifySkillOrphan(name, claimedSkills, installedShortNames)
      if (!c) continue
      const usage = skillUsage[name]
      const item = { name, uses: usage.usageCount, lastUsed: usage.lastUsedAt }
      if (c.installed) {
        (pluginRowByShort.get(c.ns).orphanedSkills = pluginRowByShort.get(c.ns).orphanedSkills || []).push(item)
        continue
      }
      if (!orphanGroups.has(c.ns)) orphanGroups.set(c.ns, [])
      orphanGroups.get(c.ns).push(item)
    }
    pluginRowByShort.forEach(row => { if (row.orphanedSkills) row.orphanedSkills.sort((a, b) => b.uses - a.uses) })
    for (const [ns, items] of orphanGroups) {
      rows.push({
        kind: 'plugin', name: `${ns} (removed)`, source: '(not installed)', installed: false,
        uses: items.reduce((s, i) => s + i.uses, 0),
        evidence: 'counter',
        lastUsed: items.reduce((m, i) => (m == null || i.lastUsed > m) ? i.lastUsed : m, null),
        staleVersions: 0, agents: [],
        orphanedSkills: items.slice().sort((a, b) => b.uses - a.uses)
      })
    }

    // locally configured mcp servers (user config + project overrides)
    localServerNames(claudeJson).forEach(server => {
      const entry = t.mcpUses.get(server)
      rows.push({
        kind: 'mcp', name: server, source: 'user config', installed: true,
        uses: entry ? entry.uses : 0, evidence: 'transcript',
        lastUsed: entry ? entry.lastUsed : null, staleVersions: 0, agents: toAgents(entry)
      })
    })

    // residual mcp evidence: called in transcripts but not covered by any plugin
    // manifest or local config above -- either a claude.ai connector (its own
    // actionable kind, disconnect it from claude.ai) or a genuinely orphaned local
    // server (config removed, old calls remain in transcript history).
    const claimedMcp = new Set(rows.filter(r => r.kind === 'mcp' || r.kind === 'connector').map(r => r.name))
    for (const [rawKey, entry] of t.mcpUses) {
      if (claimedMcp.has(rawKey)) continue
      const c = classify('mcp__' + rawKey + '__x')
      if (c.kind === 'connector') {
        rows.push({
          kind: 'connector', name: c.server, source: 'connector', installed: true,
          uses: entry.uses, evidence: 'transcript', lastUsed: entry.lastUsed,
          staleVersions: 0, agents: toAgents(entry)
        })
      } else {
        rows.push({
          kind: 'mcp', name: rawKey, source: '(not installed)', installed: false,
          uses: entry.uses, evidence: 'transcript', lastUsed: entry.lastUsed,
          staleVersions: 0, agents: toAgents(entry)
        })
      }
    }

    const vopts = { lookbackDays, idleDays, now }
    rows.forEach(r => {
      const v = verdictFor(r, vopts)
      r.verdict = v.verdict
      r.reason = v.reason
      if (r.kind === 'plugin' && r.contributes && (r.verdict === 'never used' || r.verdict === 'idle')) {
        const note = contributesNote(r.contributes, lookbackDays)
        if (note) r.reason = `${r.reason} (${note})`
      }
    })

    const order = { 'never used': 0, orphaned: 1, idle: 2, active: 3 }
    rows.sort((a, b) => (order[a.verdict] - order[b.verdict]) || a.name.localeCompare(b.name))

    return {
      rows,
      scanned: { files: t.filesScanned, windowDays: lookbackDays },
      totals: {
        installed: rows.filter(r => r.installed).length,
        neverUsed: rows.filter(r => r.verdict === 'never used').length,
        idle: rows.filter(r => r.verdict === 'idle').length,
        orphaned: rows.filter(r => r.verdict === 'orphaned').length
      }
    }
  } catch (e) {
    if (process.env.CLAUDE_JS_DEBUG) console.error(e)
    return { rows: [], scanned: { files: 0, windowDays: lookbackDays }, totals: { installed: 0, neverUsed: 0, idle: 0, orphaned: 0 } }
  }
}

// ---- drawInventory ----

function padKey(s, w) { const t = truncate(s, w); return t + ' '.repeat(Math.max(0, w - vlen(t))) }
function padR(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s }

function verdictGlyph(v) {
  if (v === 'idle') return { ch: '⚑', color: 'yellow' }
  if (v === 'active') return { ch: '', color: 'dim' }
  return { ch: '⚑', color: 'red' } // never used / orphaned
}

function lastText(row, now) {
  if (row.lastUsed == null) return row.uses ? '-' : 'never'
  const age = now - row.lastUsed
  return age < 86400000 ? 'today' : fmtAge(age)
}

function rowLine(row, w, showSource, showLast, noColor, now) {
  let line = padKey(row.kind, w.kind) + ' ' + padKey(row.name, w.name)
  if (showSource) line += ' ' + padKey(row.source || '-', w.source)
  line += ' ' + padR(row.uses != null ? String(row.uses) : '-', w.used)
  if (showLast) line += ' ' + padR(lastText(row, now), w.last)
  const g = verdictGlyph(row.verdict)
  const vtext = row.verdict === 'active' ? 'active' : (g.ch + ' ' + row.verdict)
  line += ' ' + paint(padKey(vtext, w.verdict), g.color, noColor)
  return line
}

function expandedLines(row, cols, noColor) {
  const out = []
  wrapText(row.reason || '', Math.max(10, cols - 4)).forEach(l => out.push(paint('    ' + l, 'dim', noColor)))

  if (row.contributes) {
    const c = row.contributes
    if (c.skills.unused && c.skills.unused.length) {
      wrapText('unused skills: ' + c.skills.unused.join(', '), Math.max(10, cols - 8)).forEach(l => out.push(paint('      ' + l, 'yellow', noColor)))
    }
    if (c.agents.unused && c.agents.unused.length) {
      wrapText('unused agents: ' + c.agents.unused.join(', '), Math.max(10, cols - 8)).forEach(l => out.push(paint('      ' + l, 'yellow', noColor)))
    }
  }
  if (row.orphanedSkills && row.orphanedSkills.length) {
    out.push(paint('    orphaned skill usage rolled into this row:', 'dim', noColor))
    row.orphanedSkills.slice(0, 8).forEach(s => out.push(paint(`      ${s.name}  ${s.uses}x`, 'dim', noColor)))
    if (row.orphanedSkills.length > 8) out.push(paint('      +' + (row.orphanedSkills.length - 8) + ' more', 'dim', noColor))
  }

  const agents = Array.isArray(row.agents) ? row.agents : []
  if (agents.length) {
    out.push(paint('    used by:', 'dim', noColor))
    agents.slice(0, 8).forEach(a => out.push(paint(`      ${a.label}  ${a.uses}x`, 'dim', noColor)))
    if (agents.length > 8) out.push(paint('      +' + (agents.length - 8) + ' more', 'dim', noColor))
  }
  if (row.staleVersions > 0) out.push(paint(`    ${row.staleVersions} stale cached version${row.staleVersions === 1 ? '' : 's'} on disk`, 'yellow', noColor))
  return out
}

function emptyState(cols, noColor) {
  const lines = [
    'murmur · inventory',
    '',
    'nothing to reconcile yet.',
    'this fills in once plugins are installed and skillUsage/pluginUsage or a transcript scan has something to report.'
  ]
  return lines.map(l => padLine(l ? paint(l, 'dim', noColor) : l, cols)).join('\n')
}

function drawInventory(inv, opts) {
  opts = opts || {}
  const cols = Math.max(20, opts.cols || 100)
  const noColor = !!opts.noColor
  const ascii = !!opts.ascii
  const selected = opts.selected
  const expanded = !!opts.expanded
  const now = opts.now || Date.now()
  inv = inv || {}
  const rows = Array.isArray(inv.rows) ? inv.rows : []

  if (!rows.length) return emptyState(cols, noColor).split('\n').map(l => padLine(glyph(l, ascii), cols)).join('\n')

  const totals = inv.totals || {}
  const showLast = cols >= 80
  const showSource = cols >= 64
  const w = { kind: 9, used: 6, last: 6, verdict: cols >= 100 ? 20 : (cols >= 80 ? 16 : Math.max(10, cols - 34)) }
  const sourceW = 16
  const reserved = w.kind + w.used + (showLast ? w.last : 0) + (showSource ? sourceW : 0) + w.verdict
  const gaps = 2 + (showSource ? 1 : 0) + (showLast ? 1 : 0)
  w.source = sourceW
  w.name = Math.max(8, cols - reserved - gaps)

  const lines = []
  const title = `murmur · inventory ─ ${totals.installed || 0} installed · ${totals.neverUsed || 0} never used · ${totals.orphaned || 0} orphaned`
  lines.push(title + ' ' + '─'.repeat(Math.max(0, cols - vlen(title) - 1)))

  let hdr = padKey('KIND', w.kind) + ' ' + padKey('NAME', w.name)
  if (showSource) hdr += ' ' + padKey('SOURCE', w.source)
  hdr += ' ' + padR('USED', w.used)
  if (showLast) hdr += ' ' + padR('LAST', w.last)
  hdr += ' ' + padKey('VERDICT', w.verdict)
  lines.push(paint(hdr, 'dim', noColor))

  rows.forEach((row, i) => {
    const line = rowLine(row, w, showSource, showLast, noColor, now)
    const isSel = selected === i
    lines.push(isSel ? reverseLine(line, cols, noColor) : line)
    if (isSel && expanded) lines.push(...expandedLines(row, cols, noColor))
  })

  return lines.map(l => padLine(glyph(l, ascii), cols)).join('\n')
}

module.exports = { build, classify, drawInventory, verdictFor }

// ---- self-test / demo ----

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    const A = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg) }
    const now = 1700000000000

    // classify() -- all three shapes
    A(classify('mcp__plugin_figma_figma__authenticate').kind === 'plugin', 'classify plugin kind')
    A(classify('mcp__plugin_figma_figma__authenticate').plugin === 'figma', 'classify plugin name')
    A(classify('mcp__plugin_figma_figma__authenticate').server === 'figma', 'classify plugin server')
    A(classify('mcp__plugin_fabric-cli_microsoft-learn__microsoft_docs_search').plugin === 'fabric-cli', 'classify hyphenated plugin name')
    A(classify('mcp__plugin_fabric-cli_microsoft-learn__microsoft_docs_search').server === 'microsoft-learn', 'classify hyphenated server name')
    A(classify('mcp__claude_ai_Gmail__search_threads').kind === 'connector', 'classify connector kind')
    A(classify('mcp__claude_ai_Gmail__search_threads').server === 'Gmail', 'classify connector name')
    A(classify('mcp__supabase__list_tables').kind === 'local', 'classify local kind')
    A(classify('mcp__supabase__list_tables').server === 'supabase', 'classify local server')
    A(classify('Bash').kind === 'local', 'classify non-mcp tool falls back to local')

    // verdictFor() -- four verdicts + idle boundary
    A(verdictFor({ installed: false, uses: 5, name: 'gsd:new-project' }, { now }).verdict === 'orphaned', 'orphaned verdict')
    A(verdictFor({ installed: true, uses: 0, evidence: 'counter', name: 'github', lastUsed: null }, { now }).verdict === 'never used', 'never used (counter, no timestamp)')
    const neverTranscript = verdictFor({ installed: true, uses: 0, evidence: 'transcript', name: 'figma', lastUsed: null }, { now, lookbackDays: 30 })
    A(neverTranscript.verdict === 'never used', 'never used (transcript)')
    A(/scanned window|scanned transcripts/.test(neverTranscript.reason), 'never-used transcript reason mentions the window, not an absolute claim')
    A(verdictFor({ installed: true, uses: 3, lastUsed: now - 30 * 86400000, name: 'x' }, { now, idleDays: 30 }).verdict === 'active', 'idle boundary: exactly idleDays is still active')
    A(verdictFor({ installed: true, uses: 3, lastUsed: now - 31 * 86400000, name: 'x' }, { now, idleDays: 30 }).verdict === 'idle', 'idle boundary: idleDays+1 tips to idle')
    A(verdictFor({ installed: true, uses: 12, lastUsed: now - 86400000, name: 'x' }, { now, idleDays: 30 }).verdict === 'active', 'active verdict')
    A(/12/.test(verdictFor({ installed: true, uses: 12, lastUsed: now - 86400000, name: 'x' }, { now }).reason), 'active reason cites the real use count')
    A(verdictFor({ installed: true, uses: 0, evidence: 'none', name: 'x', lastUsed: null }, { now }).verdict === 'never used', 'evidence:none still resolves to a verdict without throwing')

    // Fix 1: a 0 counter that contradicts a real lastUsedAt must NEVER read as never-used
    const contra = verdictFor({ installed: true, uses: 0, evidence: 'counter', lastUsed: now - 7 * 86400000, name: 'feature-dev@claude-plugins-official' }, { now, idleDays: 30 })
    A(contra.verdict !== 'never used', 'uses:0 with a recent lastUsed must not be flagged never used')
    A(contra.verdict === 'active', 'uses:0 but active 7d ago resolves to active, not never-used')
    A(/unreliable/.test(contra.reason), 'contradiction reason says the counter is unreliable, not that it was never used')
    const contraIdle = verdictFor({ installed: true, uses: 0, evidence: 'counter', lastUsed: now - 40 * 86400000, name: 'x' }, { now, idleDays: 30 })
    A(contraIdle.verdict === 'idle', 'uses:0 but lastUsed 40d ago falls through to idle, not never-used')

    // Fix 2: @inline/@synced/@builtin are never orphan candidates; unconfirmed marketplaces are never flagged
    const installedFixture = { 'figma@claude-plugins-official': [{}] }
    const knownFixture = new Set(['claude-plugins-official', 'thedotmack'])
    A(isRealRemovedPlugin('data@inline', installedFixture, knownFixture) === false, 'inline suffix excluded')
    A(isRealRemovedPlugin('operations@synced', installedFixture, knownFixture) === false, 'synced suffix excluded')
    A(isRealRemovedPlugin('agents-md@builtin', installedFixture, knownFixture) === false, 'builtin suffix excluded')
    A(isRealRemovedPlugin('figma@claude-plugins-official', installedFixture, knownFixture) === false, 'still-installed plugin is never orphaned')
    A(isRealRemovedPlugin('gsd@some-fake-marketplace', installedFixture, knownFixture) === false, 'unconfirmed marketplace is never flagged')
    A(isRealRemovedPlugin('gsd@thedotmack', installedFixture, knownFixture) === true, 'known marketplace + not installed = genuinely orphaned')

    // built-in-skills fix: a bare (colon-free) skillUsage key is never orphan evidence,
    // even when it happens to collide with an installed plugin's short name -- a
    // plugin:skill key is the only shape that names its plugin reliably.
    const claimedFixture = new Set()
    const installedShort = new Set(['vercel', 'ui-ux-pro-max'])
    A(classifySkillOrphan('claude-api', claimedFixture, installedShort) === null, 'bare key produces no row -- built-ins like claude-api must never be flagged')
    A(classifySkillOrphan('init', claimedFixture, installedShort) === null, 'bare key produces no row regardless of what it is')
    A(classifySkillOrphan('ui-ux-pro-max', claimedFixture, installedShort) === null, 'bare key is never orphan evidence even if it collides with an installed plugin short name')
    A(classifySkillOrphan('gsd:new-project', claimedFixture, installedShort) !== null, 'plugin:skill key names its plugin -- real evidence')
    A(classifySkillOrphan('gsd:new-project', claimedFixture, installedShort).installed === false, 'gsd is not installed -- genuine orphan candidate')
    A(classifySkillOrphan('vercel:deploy', claimedFixture, installedShort).installed === true, 'plugin:skill key under an installed plugin is drift, not a new orphan row')
    A(classifySkillOrphan('gsd:new-project', new Set(['gsd:new-project']), installedShort) === null, 'a claimed skill is never orphan evidence')

    // Fix 3: rollup counts
    const note1 = contributesNote({ skills: { shipped: 11, used: 0 }, agents: { shipped: 4, used: 0 }, mcp: [] }, 30)
    A(note1 === '0 of 11 skills and 0 of 4 agents used in 30d', 'contributesNote formats the rollup sentence')
    const note2 = contributesNote({ skills: { shipped: 0, used: 0 }, agents: { shipped: 0, used: 0 }, mcp: [] }, 30)
    A(note2 === '', 'contributesNote is empty when the plugin ships neither skills nor agents')

    // drawInventory() fixtures -- plugin/mcp/connector rows only, matching the restructured shape
    const fixtureRows = [
      {
        kind: 'plugin', name: 'figma@claude-plugins-official', source: 'marketplace', installed: true,
        uses: 0, evidence: 'counter', lastUsed: null, staleVersions: 0,
        contributes: { skills: { shipped: 14, used: 0, unused: ['figma:figma-use', 'figma:figma-shaders'] }, agents: { shipped: 0, used: 0, unused: [] }, mcp: ['figma'] },
        agents: [], verdict: 'never used', reason: 'installed but never used (0 uses recorded) — a disable candidate. (0 of 14 skills used in 30d)'
      },
      {
        kind: 'plugin', name: 'feature-dev@claude-plugins-official', source: 'marketplace', installed: true,
        uses: 0, evidence: 'counter', lastUsed: now - 7 * 86400000, staleVersions: 0,
        contributes: { skills: { shipped: 0, used: 0, unused: [] }, agents: { shipped: 3, used: 0, unused: ['code-architect', 'code-explorer', 'code-reviewer'] }, mcp: [] },
        agents: [], verdict: 'active', reason: 'no recorded invocations, but last active 7d ago — counter unreliable for this entry.'
      },
      {
        kind: 'plugin', name: 'gsd (removed)', source: '(not installed)', installed: false,
        uses: 133, evidence: 'counter', lastUsed: now - 194 * 86400000, staleVersions: 0,
        orphanedSkills: [{ name: 'gsd:execute-phase', uses: 19 }, { name: 'gsd:new-project', uses: 5 }],
        agents: [], verdict: 'orphaned', reason: '133 uses recorded for "gsd (removed)", but it is not currently installed — this config entry is stale and can be cleaned up.'
      },
      {
        kind: 'mcp', name: 'supabase', source: 'user config', installed: true,
        uses: 1, evidence: 'transcript', lastUsed: now - 28 * 86400000, staleVersions: 0,
        agents: [{ label: 'webapp', uses: 1 }], verdict: 'idle', reason: 'not called in 28d.'
      },
      {
        kind: 'connector', name: 'Gmail', source: 'connector', installed: true,
        uses: 10, evidence: 'transcript', lastUsed: now - 86400000, staleVersions: 0,
        agents: [{ label: 'C--Users-me', uses: 10 }], verdict: 'active', reason: 'used 10 times.'
      },
      {
        kind: 'plugin', name: 'claude-mem@thedotmack', source: 'marketplace', installed: true,
        uses: 18186, evidence: 'counter', lastUsed: now, staleVersions: 0,
        contributes: { skills: { shipped: 1, used: 1, unused: [] }, agents: { shipped: 0, used: 0, unused: [] }, mcp: ['mcp-search'] },
        agents: [{ label: 'session', uses: 200 }], verdict: 'active', reason: 'used 18186 times.'
      }
    ]
    const fixtureInv = { rows: fixtureRows, scanned: { files: 61, windowDays: 30 }, totals: { installed: 29, neverUsed: 8, idle: 2, orphaned: 1 } }

    ;[40, 64, 80, 100, 140].forEach(cols => {
      const out = drawInventory(fixtureInv, { cols, now })
      out.split('\n').forEach(l => A(vlen(l) <= cols, `inventory line width <= ${cols}: "${l}"`))
    })

    const asciiFrame = drawInventory(fixtureInv, { cols: 100, now, ascii: true })
    A(!/[^\x00-\x7F]/.test(asciiFrame), 'ascii:true output is pure ASCII')

    const plain = drawInventory(fixtureInv, { cols: 100, now, noColor: true })
    A(!plain.includes('\x1b'), 'noColor strips ANSI')

    const expandedFigma = drawInventory(fixtureInv, { cols: 100, now, selected: 0, expanded: true })
    A(expandedFigma.includes('figma-use') || expandedFigma.toLowerCase().includes('unused skills'), 'expanded plugin row surfaces unused skill names as disable evidence')

    const expandedGsd = drawInventory(fixtureInv, { cols: 100, now, selected: 2, expanded: true })
    A(expandedGsd.includes('gsd:execute-phase'), 'expanded orphaned-group row lists the rolled-up skills, one row for the whole removed plugin')

    const expandedSupabase = drawInventory(fixtureInv, { cols: 100, now, selected: 3, expanded: true })
    A(expandedSupabase.includes('webapp'), 'expanded row shows which agent used it')
    A(expandedSupabase.includes('not called in 28d'), 'expanded row shows the reason sentence')

    const empty = drawInventory({ rows: [] }, { cols: 100 })
    A(empty.length > 0, 'empty state is non-empty')
    A(empty.toLowerCase().includes('nothing to reconcile'), 'empty state is a helpful sentence')

    ;[fixtureInv, { rows: [] }, {}, null, undefined, { rows: [{}] }].forEach(inv => { drawInventory(inv, { cols: 100 }) }) // must not throw

    console.log('selftest OK')
  } else {
    const inv = build({})
    console.log(drawInventory(inv, {
      cols: process.stdout.columns || 100,
      noColor: !!process.env.NO_COLOR,
      ascii: process.env.MURMUR_ASCII === '1'
    }))
    console.log(`\n${inv.rows.length} rows · scanned ${inv.scanned.files} files over ${inv.scanned.windowDays}d`)
  }
}
