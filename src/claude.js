'use strict';
// Builds a subagent org-chart node from a Claude Code session on disk, given
// an agent's cwd. Tail-biased reads, no deps. See task spec for verified
// on-disk shapes (projects/<slug>/<sessionId>.jsonl + .../subagents/*).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');
// Activity/gitBranch only need the tail -- but records are fat (hook output and
// attachments run to tens of KB each), so 16KB held ~18 records and reached zero tool
// calls on a real session. 256KB reliably covers the last tool_use.
// ponytail: fixed window, not a backward scan. If a single record ever exceeds this,
// activity goes null rather than wrong; widen the constant if that shows up.
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 256 * 1024; // instructions: real prompt can sit after verbose session-start hook output
const MAX_FULL_READ = 8 * 1024 * 1024; // ponytail: 8MB usage-sum ceiling, see parseFileCached
const INSTR_CAP = 2000; // task prompt chars kept for the briefing panel

const usageCache = new Map(); // path+':'+mtime -> {usage, model, raw}
let pricingCache = null;

function clearCache() {
  usageCache.clear();
  pricingCache = null;
}

function loadPricing() {
  if (pricingCache) return pricingCache;
  pricingCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8'));
  return pricingCache;
}

function familyFor(modelId, pricing) {
  const id = String(modelId || '').toLowerCase();
  let fam = pricing.default;
  if (id.includes('opus')) fam = 'opus';
  else if (id.includes('sonnet')) fam = 'sonnet';
  else if (id.includes('haiku')) fam = 'haiku';
  else if (id.includes('fable')) fam = 'fable';
  const rates = pricing.models[fam] || pricing.models[pricing.default];
  const is1m = /\[1m\]|(?:^|[^a-z0-9])1m(?:$|[^a-z0-9])/.test(id);
  return { name: fam, in: rates.in, out: rates.out, ctx: is1m ? 1000000 : rates.ctx };
}

function cost(model, usage, pricing) {
  pricing = pricing || loadPricing();
  const fam = familyFor(model, pricing);
  const u = usage || {};
  return (
    ((u.in || 0) / 1e6) * fam.in +
    ((u.out || 0) / 1e6) * fam.out +
    ((u.cacheWrite || 0) / 1e6) * fam.in * pricing.cacheWriteMultiplier +
    ((u.cacheRead || 0) / 1e6) * fam.in * pricing.cacheReadMultiplier
  );
}

// Slug transform, verified empirically against real project dirs.
function projectDirFor(cwd) {
  const slug = String(cwd).replace(/[:\\/._ ]/g, '-');
  return path.join(PROJECTS_ROOT, slug);
}

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // we started mid-file: the first line is (probably) a partial fragment - drop it.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function readHeadLines(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.pop(); // last line may be a partial fragment - drop it
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  return '';
}

// Visible text length of a string / array of strings / blocks.
function textLen(v) {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((s, x) => s + textLen(x), 0);
  if (v && typeof v.text === 'string') return v.text.length;
  return 0;
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function ctxPctFor(ctx, window) {
  if (!window || !ctx) return 0;
  const w = ctx > window ? Math.max(window, 1000000) : window;
  return Math.round((ctx / w) * 100);
}

function toolDetail(name, input) {
  input = input || {};
  const detail =
    input.command || input.file_path || input.pattern || input.description || JSON.stringify(input);
  // Collapse whitespace before truncating: a raw newline from a multi-line Bash
  // command would inject extra lines into the rendered frame and desync the
  // selection index from the row it points at.
  return collapseWs(detail).slice(0, 60);
}

// Sums usage over a whole jsonl file, caching by path+mtime so repeat scans
// of an unchanged file are free. Used for both the session file and every
// subagent file.
function parseFileCached(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = file + ':' + st.mtimeMs;
  if (usageCache.has(key)) return usageCache.get(key);

  let raw;
  let partial = false;
  if (st.size <= MAX_FULL_READ) {
    raw = fs.readFileSync(file, 'utf8');
  } else {
    raw = readTail(file, MAX_FULL_READ); // ponytail: 8MB sum ceiling; upgrade to a streaming reduce if this bites
    partial = true;
  }

  let inTok = 0, out = 0, cacheRead = 0, cacheWrite = 0, lastModel = null, lastCtx = 0;
  // Priced per model, not per file: a session switched with /model used to be billed
  // entirely at whatever model it ended on.
  const byModel = {};
  let instrFiles = null, skillCount = null;
  // What this agent carried into context before (and alongside) its task, in chars.
  // Every field comes from a record Claude Code wrote about its own prompt assembly.
  const context = { tools: 0, files: 0, skills: 0, agents: 0, mcp: 0, deferred: 0, hooks: 0, task: 0 };
  const hooks = {}; // hookName -> {n, ms, err, timeouts, chars, event, command}
  const hook = (a) => hooks[a.hookName || '?'] || (hooks[a.hookName || '?'] = { n: 0, ms: 0, err: 0, timeouts: 0, chars: 0, event: a.hookEvent || '', command: a.command || '' });
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const r = tryParse(line);
    if (!r) continue;
    // Claude Code records exactly which CLAUDE.md / memory files it loaded into this
    // agent's context, and how many skills it could see. Ground truth, not a guess.
    if (r.attachment) {
      const a = r.attachment;
      if (a.type === 'instructions' && Array.isArray(a.files)) {
        if (!instrFiles) instrFiles = a.files.map((f) => ({ type: f.type || '?', path: f.path || '', chars: String(f.content || '').length }));
        context.files += a.files.reduce((s, f) => s + String(f.content || '').length, 0);
      } else if (a.type === 'skill_listing') {
        if (skillCount == null && typeof a.skillCount === 'number') skillCount = a.skillCount;
        context.skills += textLen(a.content);
      } else if (a.type === 'prompt_snapshot' && a.tools) {
        context.tools = JSON.stringify(a.tools).length; // latest snapshot wins; it is the full set
      } else if (a.type === 'agent_listing_delta') {
        context.agents += textLen(a.addedLines);
      } else if (a.type === 'mcp_instructions_delta') {
        context.mcp += textLen(a.addedBlocks);
      } else if (a.type === 'deferred_tools_delta') {
        context.deferred += textLen(a.addedLines);
      } else if (a.type === 'hook_success' || a.type === 'hook_cancelled') {
        const h = hook(a);
        h.n++;
        h.ms += a.durationMs || 0;
        if (a.exitCode) h.err++;
        if (a.timedOut) h.timeouts++;
        const injected = textLen(a.content);
        h.chars += injected;
        context.hooks += injected;
      } else if (a.type === 'hook_additional_context' || a.type === 'hook_system_message') {
        const injected = textLen(a.content);
        hook(a).chars += injected;
        context.hooks += injected;
      }
      continue;
    }
    if (!context.task && r.type === 'user' && !r.isMeta && r.message) {
      const t = extractText(r.message.content);
      if (t && !t.startsWith('<')) context.task = t.length;
    }
    if (r.type !== 'assistant' || !r.message || !r.message.usage) continue;
    const u = r.message.usage;
    const m = r.message.model || lastModel || 'unknown';
    if (m === '<synthetic>') continue; // local placeholder turns, never billed
    const bm = byModel[m] || (byModel[m] = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    bm.in += u.input_tokens || 0;
    bm.out += u.output_tokens || 0;
    bm.cacheRead += u.cache_read_input_tokens || 0;
    bm.cacheWrite += u.cache_creation_input_tokens || 0;
    inTok += u.input_tokens || 0;
    out += u.output_tokens || 0;
    cacheRead += u.cache_read_input_tokens || 0;
    cacheWrite += u.cache_creation_input_tokens || 0;
    lastModel = m;
    lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }

  const pricing = loadPricing();
  const fam = familyFor(lastModel, pricing);
  let total = 0;
  for (const m of Object.keys(byModel)) {
    byModel[m].cost = cost(m, byModel[m], pricing);
    total += byModel[m].cost;
  }
  const usage = {
    in: inTok,
    out,
    cacheRead,
    cacheWrite,
    cost: total,
    byModel,
    ctx: lastCtx,
    // A model id does not always carry its window: a 1M-context run still reports
    // "claude-opus-5", which scored a real session at 110% and fired a false
    // "about to compact" warning. Observed context is the better evidence -- if it
    // exceeds the assumed window, the window was wrong, so widen it.
    // ponytail: only the 1M tier exists above the default; revisit if that changes.
    ctxPct: ctxPctFor(lastCtx, fam.ctx),
  };
  if (partial) usage.partial = true;

  const result = { usage, model: lastModel, raw, instrFiles, skillCount, context, hooks };
  usageCache.set(key, result);
  return result;
}

// Last tool_use + gitBranch seen in a tail chunk. Shared by session + agent parsing.
function tailInfo(file) {
  const lines = readTail(file, TAIL_BYTES).split('\n').filter(Boolean);
  let activity = null, gitBranch = null, lastRecord = null;
  const open = new Map(); // tool_use id -> activity, until its tool_result lands
  for (const line of lines) {
    const r = tryParse(line);
    if (!r) continue;
    lastRecord = r;
    if (r.gitBranch) gitBranch = r.gitBranch;
    if (!r.message || !Array.isArray(r.message.content)) continue;
    for (const b of r.message.content) {
      if (r.type === 'assistant' && b.type === 'tool_use') {
        activity = { tool: b.name, detail: toolDetail(b.name, b.input), at: r.timestamp || null };
        open.set(b.id, activity);
      } else if (b.type === 'tool_result') {
        open.delete(b.tool_use_id);
      }
    }
  }
  // A tool call with no result yet: running, or waiting on a permission prompt. The
  // screen tells those two apart (app.js); the transcript alone cannot.
  const pendingTool = open.size ? [...open.values()].pop() : null;
  return { activity, gitBranch, lastRecord, pendingTool };
}

function isDone(lastRecord, mtimeMs) {
  if (Date.now() - mtimeMs > 120000) return true;
  if (lastRecord && lastRecord.type === 'assistant' && lastRecord.message && Array.isArray(lastRecord.message.content)) {
    return !lastRecord.message.content.some((b) => b.type === 'tool_use');
  }
  return false;
}

// FALL BACK: direct slug path missed - scan every project dir's newest jsonl
// for a matching cwd field.
function findProjectDirByCwd(cwd) {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  const target = String(cwd).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  for (const name of dirs) {
    const dir = path.join(PROJECTS_ROOT, name);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    let newest = null, newestMtime = -1;
    for (const f of files) {
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > newestMtime) { newestMtime = m; newest = f; }
    }
    if (!newest) continue;
    for (const line of readHeadLines(path.join(dir, newest), HEAD_BYTES)) {
      const r = tryParse(line);
      if (r && r.cwd) {
        if (String(r.cwd).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') === target) return dir;
        break;
      }
    }
  }
  return null;
}

function findMemory(cwd, projectDir, sessionId, sessionFile) {
  const candidates = [
    { kind: 'CLAUDE.md', path: path.join(cwd, 'CLAUDE.md') },
    { kind: 'CLAUDE.md', path: path.join(cwd, '.claude', 'CLAUDE.md') },
    { kind: 'CLAUDE.md', path: path.join(HOME, '.claude', 'CLAUDE.md') },
    { kind: 'memory', path: path.join(projectDir, 'memory') },
    { kind: 'memory', path: path.join(projectDir, 'memory', 'MEMORY.md') },
    { kind: 'remember', path: path.join(cwd, '.remember') },
    { kind: 'tool-results', path: path.join(projectDir, sessionId, 'tool-results') },
    { kind: 'transcript', path: sessionFile },
  ];
  return candidates.filter((c) => fs.existsSync(c.path));
}

// Built into Claude Code itself: no .md on disk to point at.
const BUILTIN_AGENTS = new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude-code-guide', 'fork', 'claude']);
const agentDefCache = new Map();

// The .md file that defines a subagent type: project .claude/agents, then user
// ~/.claude/agents, then a plugin's agents/ dir ("plugin:name" types). Returns
// 'built-in' for Claude Code's own types, null when nothing matches.
// ponytail: newest plugin version dir wins; cached per cwd+type for the process lifetime.
function findAgentDef(agentType, cwd) {
  if (!agentType) return null;
  const key = (cwd || '') + '|' + agentType;
  if (agentDefCache.has(key)) return agentDefCache.get(key);
  let found = null;
  const [plugin, name] = agentType.includes(':') ? agentType.split(':', 2) : [null, agentType];
  if (!plugin && BUILTIN_AGENTS.has(agentType.toLowerCase())) found = 'built-in';
  const direct = [cwd && path.join(cwd, '.claude', 'agents', name + '.md'), path.join(HOME, '.claude', 'agents', name + '.md')];
  if (!found && !plugin) found = direct.find((p) => p && fs.existsSync(p)) || null;
  if (!found && plugin) {
    const cacheRoot = path.join(HOME, '.claude', 'plugins', 'cache');
    let best = null, bestM = -1;
    try {
      for (const market of fs.readdirSync(cacheRoot)) {
        const pdir = path.join(cacheRoot, market, plugin);
        let versions;
        try { versions = fs.readdirSync(pdir); } catch { continue; }
        for (const v of versions) {
          const p = path.join(pdir, v, 'agents', name + '.md');
          try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { bestM = m; best = p; } } catch {}
        }
      }
    } catch {}
    found = best;
  }
  agentDefCache.set(key, found);
  return found;
}

function buildAgentNode(jsonlPath, metaPath, cwd) {
  const parsed = parseFileCached(jsonlPath);
  if (!parsed) return null;
  const st = fs.statSync(jsonlPath);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    // tolerate missing/broken meta.json
  }
  const first = tryParse(readHeadLines(jsonlPath, 8192)[0] || '');
  const instructions = first && first.message ? collapseWs(extractText(first.message.content)).slice(0, INSTR_CAP) : '';
  const slug = first ? first.slug || null : null;
  const { activity, lastRecord } = tailInfo(jsonlPath);

  const id = path.basename(jsonlPath, '.jsonl').replace(/^agent-/, '');
  return {
    agentId: meta.agentId || id,
    file: jsonlPath, // skills.js profiles this transcript for tool/skill/error counts
    slug,
    agentType: meta.agentType || null,
    description: meta.description || null,
    model: parsed.model || meta.model || null,
    spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1,
    toolUseId: meta.toolUseId || null,
    status: isDone(lastRecord, st.mtimeMs) ? 'done' : 'running',
    instructions,
    instrFiles: parsed.instrFiles,
    skillCount: parsed.skillCount,
    context: parsed.context,
    hooks: parsed.hooks,
    agentDef: findAgentDef(meta.agentType, cwd),
    activity,
    usage: parsed.usage,
    mtime: st.mtimeMs,
    children: [],
    _raw: parsed.raw, // internal only, used to locate a deeper agent's parent; stripped below
  };
}

// Nest agents under the session by spawnDepth. A depth-2 agent's parent is
// the most recent depth-1 agent whose jsonl mentions its toolUseId; deeper
// depths look one level up the same way.
function nestAgents(agents) {
  const byDepth = new Map();
  for (const a of agents) {
    if (!byDepth.has(a.spawnDepth)) byDepth.set(a.spawnDepth, []);
    byDepth.get(a.spawnDepth).push(a);
  }
  const depths = [...byDepth.keys()].sort((x, y) => x - y);
  const roots = [];
  for (const d of depths) {
    for (const a of byDepth.get(d)) {
      if (d <= 1) {
        roots.push(a);
        continue;
      }
      const parents = (byDepth.get(d - 1) || []).filter((p) => a.toolUseId && p._raw && p._raw.includes(a.toolUseId));
      if (parents.length) {
        parents.sort((x, y) => y.mtime - x.mtime)[0].children.push(a);
      } else {
        roots.push(a); // ponytail: fallback - flat under session when no parent match is found
      }
    }
  }
  for (const a of agents) delete a._raw;
  return roots;
}

function buildChildren(projectDir, sessionId, cwd) {
  const subDir = path.join(projectDir, sessionId, 'subagents');
  let files;
  try {
    files = fs.readdirSync(subDir);
  } catch {
    return [];
  }
  const agents = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    const base = f.replace(/\.meta\.json$/, '');
    const jsonlPath = path.join(subDir, base + '.jsonl');
    if (!fs.existsSync(jsonlPath)) continue;
    const node = buildAgentNode(jsonlPath, path.join(subDir, f), cwd);
    if (node) agents.push(node);
  }
  return nestAgents(agents);
}

function scan(cwd, sessionId) {
  try {
    let projectDir = projectDirFor(cwd);
    if (!fs.existsSync(projectDir)) {
      const found = findProjectDirByCwd(cwd);
      if (!found) return null;
      projectDir = found;
    }

    let files;
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    if (!files.length) return null;

    let chosen = sessionId && files.includes(sessionId + '.jsonl') ? sessionId + '.jsonl' : null;
    if (!chosen) {
      // Newest mtime, but only among sessions that are real work. A project dir
      // accumulates throwaway sessions (a bare slash command, an aborted start) that
      // are newer than the session actually running, and picking one shows an empty
      // tree for a busy agent. A session with at least one assistant turn is real.
      // ponytail: reads the tail of each candidate, newest first, and stops at the
      // first real one -- so the common case costs a single small read. If Herdr
      // starts populating agent_session (0.8 schema), pass that id in and skip this.
      const ranked = files
        .map((name) => {
          let m = -1;
          try { m = fs.statSync(path.join(projectDir, name)).mtimeMs; } catch {}
          return { name, m };
        })
        .sort((a, b) => b.m - a.m);
      for (const cand of ranked) {
        try {
          if (readTail(path.join(projectDir, cand.name), 65536).includes('"type":"assistant"')) {
            chosen = cand.name;
            break;
          }
        } catch {}
      }
      if (!chosen && ranked.length) chosen = ranked[0].name;
    }
    if (!chosen) return null;

    const file = path.join(projectDir, chosen);
    const sid = chosen.replace(/\.jsonl$/, '');
    const st = fs.statSync(file);
    const parsed = parseFileCached(file);
    if (!parsed) return null;

    let instructions = '', headCwd = null, headBranch = null;
    for (const line of readHeadLines(file, HEAD_BYTES)) {
      const r = tryParse(line);
      if (!r) continue;
      if (!headCwd && r.cwd) headCwd = r.cwd;
      if (r.gitBranch) headBranch = r.gitBranch;
      if (!instructions && r.type === 'user' && !r.isMeta && r.message && r.message.role === 'user') {
        const text = collapseWs(extractText(r.message.content));
        if (text && !text.startsWith('<')) instructions = text.slice(0, INSTR_CAP); // skip caveat/command wrapper records
      }
    }

    const tail = tailInfo(file);

    return {
      sessionId: sid,
      projectDir,
      file,
      cwd: headCwd || cwd,
      gitBranch: tail.gitBranch || headBranch || null,
      model: parsed.model,
      instructions,
      instrFiles: parsed.instrFiles,
      skillCount: parsed.skillCount,
      context: parsed.context,
      hooks: parsed.hooks,
      activity: tail.activity,
      pendingTool: tail.pendingTool,
      usage: parsed.usage,
      memory: findMemory(cwd, projectDir, sid, file),
      mtime: st.mtimeMs,
      children: buildChildren(projectDir, sid, headCwd || cwd),
    };
  } catch (e) {
    if (process.env.CLAUDE_JS_DEBUG) console.error(e);
    return null;
  }
}

function summarizeUsage(file) {
  const parsed = parseFileCached(file);
  return parsed ? parsed.usage : null;
}

// Sessions in a project dir, newest first, each with the title Claude Code last gave it.
// Several Herdr panes often share one cwd (three terminals open on the same repo), so
// cwd alone cannot say which session a pane is running -- without this they all resolve
// to the newest one and the same work gets drawn, and costed, several times over.
// Herdr's own `agent_session` field would answer this directly, but it is absent in
// 0.7.5; the pane's terminal title is what we have, and it matches `aiTitle` exactly.
function listSessions(cwd) {
  try {
    const dir = projectDirFor(cwd);
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((name) => {
        const file = path.join(dir, name);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
        let title = null;
        let hasWork = false;
        // ponytail: one tail read per session per refresh, mtime-gated by the caller.
        // Titles land near the end, so the tail is where they are.
        try {
          const lines = readTail(file, TAIL_BYTES).split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const r = tryParse(lines[i]);
            if (!r) continue;
            if (!hasWork && r.type === 'assistant') hasWork = true;
            if (!title && r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
            if (title && hasWork) break;
          }
        } catch {}
        return { sessionId: name.replace(/\.jsonl$/, ''), file, mtime, title, hasWork };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// Herdr prefixes a live status glyph onto the pane title ("◑ Build the thing").
function normalizeTitle(s) {
  return collapseWs(String(s || '').replace(/^[^\p{L}\p{N}]+/u, '')).toLowerCase();
}

module.exports = {
  scan, projectDirFor, readTail, summarizeUsage, cost, clearCache,
  listSessions, normalizeTitle
};

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    const pricing = loadPricing();
    // -- cost() against hand-computed numbers --
    const u = { in: 1000000, out: 1000000, cacheRead: 1000000, cacheWrite: 1000000 };
    const r = pricing.models.sonnet;
    const expected = r.in + r.out + r.in * pricing.cacheWriteMultiplier + r.in * pricing.cacheReadMultiplier;
    assert.ok(Math.abs(cost('claude-sonnet-5', u, pricing) - expected) < 1e-9, 'cost() math mismatch');

    // -- readTail drops a partial first line --
    const tmp = path.join(os.tmpdir(), 'claude-selftest-' + Date.now() + '.jsonl');
    fs.writeFileSync(tmp, 'aaa\nbbbb\ncccc\n');
    assert.strictEqual(readTail(tmp, 8), 'cccc\n');
    fs.unlinkSync(tmp);

    // -- mixed-model session: priced per model, instruction files and skills captured --
    const mix = path.join(os.tmpdir(), 'claude-selftest-mix-' + Date.now() + '.jsonl');
    const turn = (model, n) => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: n, output_tokens: n } } });
    fs.writeFileSync(mix, [
      JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'C:\\x\\CLAUDE.md', type: 'Project', content: 'abcd' }] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', skillCount: 7, content: 'x'.repeat(10) } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', tools: [{ name: 'Bash' }] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'hello', durationMs: 40, exitCode: 0 } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_cancelled', hookName: 'Stop', hookEvent: 'Stop', durationMs: 30000, timedOut: true } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'SessionStart:startup', content: ['abc'] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      turn('claude-opus-5-5', 1000000),
      turn('claude-sonnet-5', 1000000),
      turn('<synthetic>', 0),
    ].join('\n') + '\n');
    const pm = parseFileCached(mix);
    fs.unlinkSync(mix);
    assert.deepStrictEqual(Object.keys(pm.usage.byModel).sort(), ['claude-opus-5-5', 'claude-sonnet-5']);
    const po = pricing.models.opus, ps = pricing.models.sonnet;
    assert.ok(Math.abs(pm.usage.cost - (po.in + po.out + ps.in + ps.out)) < 1e-9, 'each model priced at its own rate');
    assert.deepStrictEqual(pm.instrFiles, [{ type: 'Project', path: 'C:\\x\\CLAUDE.md', chars: 4 }]);
    assert.strictEqual(pm.skillCount, 7);
    assert.deepStrictEqual(pm.context, { tools: JSON.stringify([{ name: 'Bash' }]).length, files: 4, skills: 10, agents: 0, mcp: 0, deferred: 0, hooks: 8, task: 12 });
    assert.deepStrictEqual(pm.hooks['SessionStart:startup'], { n: 1, ms: 40, err: 0, timeouts: 0, chars: 8, event: 'SessionStart', command: '' });
    assert.strictEqual(pm.hooks.Stop.timeouts, 1, 'cancelled hook counted as a timeout');

    // -- agent definitions: built-ins are named as such, unknown types are null --
    assert.strictEqual(findAgentDef('general-purpose', null), 'built-in');
    assert.strictEqual(findAgentDef('no-such-agent-xyz', null), null);

    // -- slug transform, verified examples --
    assert.strictEqual(projectDirFor('C:\\Workspaces\\webapp'), path.join(PROJECTS_ROOT, 'C--Workspaces-webapp'));
    assert.strictEqual(projectDirFor('C:\\Users\\me'), path.join(PROJECTS_ROOT, 'C--Users-me'));
    assert.strictEqual(projectDirFor('/home/me/my.app'), path.join(PROJECTS_ROOT, '-home-me-my-app'));

    console.log('selftest ok');
  } else {
    const cwd = process.argv[2] || process.cwd(); // demo: `node src/claude.js <project dir>`
    console.log(JSON.stringify(scan(cwd), null, 2));
  }
}
