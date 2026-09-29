'use strict';
// Adds the "what are they actually running" layer on top of claude.js's usage
// scan: skills, slash commands, MCP tool calls, ordinary tools, failures, and
// a health verdict per agent and per skill/mcp/command/agentType. Zero deps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const claude = require('./claude');

const MAX_FULL_READ = 8 * 1024 * 1024; // ponytail: same 8MB ceiling as claude.js's parseFileCached

const DEFAULT_THRESHOLDS = {
  thrashing: { toolCalls: 60 },
  flaky: { errorRate: 0.2, minUses: 5 },
  looping: { repeats: 3 },
  expensive: { costUsd: 2.0 },
  sprawl: { fanOut: 6, depth: 3 },
  compacting: { ctxPct: 80 },
  starved: { toolCalls: 3, costUsd: 0.05 },
};

// claude.js doesn't export tryParse/collapseWs/toolDetail or its cache -- smallest
// local reimplementations, mirroring claude.js's own shapes.
function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}
function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function toolDetail(name, input) {
  input = input || {};
  const raw = input.command || input.file_path || input.pattern || input.description || JSON.stringify(input);
  return collapseWs(raw).slice(0, 60);
}

const profileCache = new Map(); // path+':'+mtime -> profile result

function profile(jsonlPath) {
  let st;
  try { st = fs.statSync(jsonlPath); } catch { return null; }
  const key = jsonlPath + ':' + st.mtimeMs;
  if (profileCache.has(key)) return profileCache.get(key);

  let raw, partial = false;
  if (st.size <= MAX_FULL_READ) {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } else {
    raw = claude.readTail(jsonlPath, MAX_FULL_READ); // ponytail: 8MB ceiling, upgrade to a streaming reduce if this bites
    partial = true;
  }

  const skills = new Map();   // name -> {name, uses, args, errors}
  const commands = new Map(); // name -> uses
  const mcp = new Map();      // server\0tool -> {server, tool, uses, errors}
  const tools = new Map();    // name -> {name, uses, errors}
  const loops = new Map();    // name\0JSON(input) -> {tool, detail, repeats}
  const idIndex = new Map();  // tool_use id -> entry object to bump .errors on, exact attribution
  let toolCalls = 0, errorsTotal = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const r = tryParse(line);
    if (!r) continue;

    if (r.type === 'user') {
      const cmd = line.match(/<command-name>([^<]+)<\/command-name>/);
      if (cmd) commands.set(cmd[1].trim(), (commands.get(cmd[1].trim()) || 0) + 1);
      if (r.message && Array.isArray(r.message.content)) {
        for (const b of r.message.content) {
          if (!b || b.type !== 'tool_result' || !b.is_error) continue;
          errorsTotal++;
          const entry = b.tool_use_id && idIndex.get(b.tool_use_id);
          if (entry) entry.errors++; // exact attribution when matched; else counted only in the total
        }
      }
      continue;
    }

    if (r.type !== 'assistant' || !r.message || !Array.isArray(r.message.content)) continue;
    for (const b of r.message.content) {
      if (!b || b.type !== 'tool_use') continue;
      toolCalls++;
      const name = b.name, input = b.input || {};

      const sig = name + '\u0000' + JSON.stringify(input);
      let loop = loops.get(sig);
      if (!loop) { loop = { tool: name, detail: toolDetail(name, input), repeats: 0 }; loops.set(sig, loop); }
      loop.repeats++;

      let entry;
      if (name === 'Skill') {
        const sname = input.skill || 'unknown';
        entry = skills.get(sname);
        if (!entry) { entry = { name: sname, uses: 0, args: [], errors: 0 }; skills.set(sname, entry); }
        if (input.args) {
          const a = collapseWs(input.args).slice(0, 80);
          if (a && entry.args.length < 3 && !entry.args.includes(a)) entry.args.push(a);
        }
      } else if (name && name.startsWith('mcp__')) {
        const rest = name.slice(5);
        const sep = rest.indexOf('__');
        const server = sep === -1 ? rest : rest.slice(0, sep);
        const tool = sep === -1 ? '' : rest.slice(sep + 2);
        const mkey = server + '\u0000' + tool;
        entry = mcp.get(mkey);
        if (!entry) { entry = { server, tool, uses: 0, errors: 0 }; mcp.set(mkey, entry); }
      } else {
        entry = tools.get(name);
        if (!entry) { entry = { name, uses: 0, errors: 0 }; tools.set(name, entry); }
      }
      entry.uses++;
      if (b.id) idIndex.set(b.id, entry);
    }
  }

  const result = {
    skills: [...skills.values()].sort((a, b) => b.uses - a.uses),
    commands: [...commands.entries()].map(([name, uses]) => ({ name, uses })).sort((a, b) => b.uses - a.uses),
    mcp: [...mcp.values()].sort((a, b) => b.uses - a.uses),
    tools: [...tools.values()].sort((a, b) => b.uses - a.uses),
    toolCalls,
    errors: errorsTotal,
    errorRate: errorsTotal / Math.max(1, toolCalls),
    loops: [...loops.values()].filter((l) => l.repeats >= 2).sort((a, b) => b.repeats - a.repeats),
  };
  if (partial) result.partial = true;
  profileCache.set(key, result);
  return result;
}

// Rule order doubles as tie-break order within a severity band.
const RULES = ['thrashing', 'flaky', 'looping', 'expensive', 'sprawl', 'compacting', 'starved'];
const SEVERITY = { expensive: 'warn', flaky: 'warn', looping: 'warn', thrashing: 'warn', sprawl: 'info', compacting: 'info', starved: 'info' };

function health(node, ctx) {
  try {
    node = node || {};
    ctx = ctx || {};
    const th = ctx.thresholds || DEFAULT_THRESHOLDS;
    const p = node.profile || {};
    const usage = node.usage || {};
    const toolCalls = p.toolCalls || 0;
    const errorRate = p.errorRate || 0;
    const loops = p.loops || [];
    const children = node.children || [];
    const fanOut = children.length || ctx.fanOut || 0;
    const depth = typeof ctx.depth === 'number' ? ctx.depth : (node.spawnDepth || 0);
    const cost = usage.cost || 0;

    // A whole session is a day's work, not a unit you tune. Judging one by subagent
    // thresholds flagged a normal session as "thrashing" at 327 tool calls, which is
    // exactly the cry-wolf that makes people stop reading flags. Volume rules scale
    // for sessions; "tune me" rules (flaky/looping/starved) only apply to the
    // reusable units -- subagents and aggregate rows.
    const isSession = ctx.kind === 'session';
    const scale = isSession ? (th.sessionScale || 8) : 1;

    const checks = {
      thrashing: () => toolCalls > th.thrashing.toolCalls * scale && { reason: `${toolCalls} tool calls${isSession ? ' this session' : ''} without finishing` },
      flaky: () => !isSession && errorRate > th.flaky.errorRate && toolCalls >= th.flaky.minUses && { reason: `${p.errors || 0} of ${toolCalls} tool calls failed (${Math.round(errorRate * 100)}%)` },
      looping: () => {
        const worst = loops.find((l) => l.repeats >= th.looping.repeats);
        return worst && { reason: `${worst.tool} repeated ${worst.repeats}x with the same input (${worst.detail})` };
      },
      expensive: () => cost > th.expensive.costUsd * scale && { reason: `$${cost.toFixed(2)} spent${isSession ? ' this session' : ' on one subagent'}` },
      sprawl: () => (fanOut > th.sprawl.fanOut || depth >= th.sprawl.depth) && { reason: `${fanOut} child agents at depth ${depth}` },
      compacting: () => (usage.ctxPct || 0) >= th.compacting.ctxPct && { reason: `context at ${usage.ctxPct}% -- due to compact soon` },
      starved: () => !isSession && toolCalls < th.starved.toolCalls && cost < th.starved.costUsd && { reason: `only ${toolCalls} tool calls and $${cost.toFixed(3)} spent -- inline it instead` },
    };

    const flags = [];
    for (const flag of RULES) {
      const hit = checks[flag]();
      if (hit) flags.push({ flag, severity: SEVERITY[flag], reason: hit.reason });
    }
    flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
    return flags;
  } catch {
    return []; // never throw
  }
}

// Inverted index: rolls per-transcript profiles up by skill/agentType/mcp server/command.
// agentType cost/errors are summed directly from the nodes that ran as that type. A
// skill/mcp/command has no per-tool-call cost of its own in the transcript, so its cost
// is an ESTIMATE: the containing node's total cost split by that key's share of the
// node's tool calls -- good for ranking, not a ledger. Errors, by contrast, ARE exact:
// profile() matches each is_error result back to its tool_use via tool_use_id, so a
// skill/mcp entry's .errors is a real count, not a share.
function aggregate(nodes, thresholds) {
  thresholds = thresholds || DEFAULT_THRESHOLDS;
  const rows = new Map(); // kind\0key -> row

  function row(kind, key) {
    const rk = kind + '\u0000' + key;
    let r = rows.get(rk);
    if (!r) {
      r = { key, kind, uses: 0, cost: 0, errors: 0, errorRate: 0, avgTools: 0, agents: [], _opp: 0, _toolsSum: 0, _n: 0 };
      rows.set(rk, r);
    }
    return r;
  }

  for (const item of nodes || []) {
    const node = item.node, p = item.profile;
    if (!node || !p) continue;
    const label = item.agentType || item.model || 'session';
    const nodeCost = (node.usage && node.usage.cost) || 0;
    const nodeToolCalls = p.toolCalls || 0;

    if (item.agentType) {
      const r = row('agentType', item.agentType);
      r.uses += 1;
      r.cost += nodeCost;
      r.errors += p.errors || 0;
      r._opp += nodeToolCalls;
      r._toolsSum += nodeToolCalls;
      r._n += 1;
      r.agents.push({ label, cost: nodeCost, errorRate: p.errorRate || 0 });
    }

    const buckets = [
      ['skill', p.skills || []],
      ['mcp', (p.mcp || []).map((m) => ({ name: m.server, uses: m.uses, errors: m.errors }))],
      ['command', (p.commands || []).map((c) => ({ name: c.name, uses: c.uses, errors: 0 }))],
    ];
    for (const [kind, entries] of buckets) {
      // mcp entries are merged by server here (several tools -> one server key), so
      // re-fold duplicates before rolling into rows.
      const bySame = new Map();
      for (const e of entries) {
        const cur = bySame.get(e.name) || { uses: 0, errors: 0 };
        cur.uses += e.uses; cur.errors += e.errors;
        bySame.set(e.name, cur);
      }
      for (const [name, e] of bySame) {
        const share = e.uses / Math.max(1, nodeToolCalls);
        const r = row(kind, name);
        r.uses += e.uses;
        r.cost += nodeCost * share;
        r.errors += e.errors;
        r._opp += e.uses;
        r._toolsSum += nodeToolCalls;
        r._n += 1;
        r.agents.push({ label, cost: nodeCost * share, errorRate: e.uses ? e.errors / e.uses : 0 });
      }
    }
  }

  const out = [];
  for (const r of rows.values()) {
    r.errorRate = r.errors / Math.max(1, r._opp);
    r.avgTools = r._n ? Math.round(r._toolsSum / r._n) : 0;
    r.agents.sort((a, b) => b.cost - a.cost);
    delete r._opp; delete r._toolsSum; delete r._n;
    // Only a subagent genuinely owns its cost and tool calls. A skill, MCP server or
    // slash command merely ran inside one, so its cost and avgTools are this row's
    // share of the containing agent -- an estimate. Uses and errors stay exact.
    r.estimated = r.kind !== 'agentType';

    // ponytail: health() on a rollup has no real ctxPct/depth/fanOut of its own, so
    // compacting/sprawl never fire here -- only cost/error/loop-shaped rules apply.
    r.flags = health(
      { usage: { cost: r.cost, ctxPct: 0 }, children: [], spawnDepth: 0,
        profile: { toolCalls: r.avgTools || r.uses, errors: r.errors, errorRate: r.errorRate, loops: [] } },
      { thresholds, depth: 0, fanOut: 0 }
    );
    // Never flag on an estimate. Crediting /compact with its agent's 15 tool calls
    // produced a "thrashing" verdict on a one-shot command -- the kind of wrong that
    // teaches people to stop trusting the column. Error-shaped flags survive because
    // errors are attributed exactly, by tool_use_id.
    if (r.estimated) r.flags = r.flags.filter((f) => f.flag === 'flaky' || f.flag === 'looping');
    out.push(r);
  }
  return out.sort((a, b) => b.cost - a.cost);
}

function loadThresholds() {
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'thresholds.json'), 'utf8'));
  } catch {
    loaded = {};
  }
  const merged = {};
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) merged[k] = Object.assign({}, DEFAULT_THRESHOLDS[k], loaded[k]);
  return merged;
}

module.exports = { profile, aggregate, health, loadThresholds };

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    const fixture = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_skill1', name: 'Skill', input: { skill: 'claude-api', args: 'check pricing' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_skill1', content: 'ok', is_error: false }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mcp1', name: 'mcp__supabase__list_tables', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp1', content: 'boom', is_error: true }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'echo hi' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash2', name: 'Bash', input: { command: 'echo hi' } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash3', name: 'Bash', input: { command: 'echo hi' } }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';

    const tmp = path.join(os.tmpdir(), 'murmur-skills-selftest-' + Date.now() + '.jsonl');
    fs.writeFileSync(tmp, fixture);
    try {
      const p = profile(tmp);
      assert.strictEqual(p.toolCalls, 5, 'toolCalls');
      assert.strictEqual(p.errors, 1, 'errors');
      assert.strictEqual(p.errorRate, 0.2, 'errorRate'); // 1/5 -- also the flaky boundary, see below

      assert.strictEqual(p.skills.length, 1);
      assert.deepStrictEqual(p.skills[0], { name: 'claude-api', uses: 1, args: ['check pricing'], errors: 0 });

      assert.strictEqual(p.mcp.length, 1);
      assert.strictEqual(p.mcp[0].server, 'supabase');
      assert.strictEqual(p.mcp[0].tool, 'list_tables');
      assert.strictEqual(p.mcp[0].uses, 1);
      assert.strictEqual(p.mcp[0].errors, 1, 'mcp error should attribute via tool_use_id');

      assert.strictEqual(p.tools.length, 1);
      assert.strictEqual(p.tools[0].name, 'Bash');
      assert.strictEqual(p.tools[0].uses, 3);

      assert.strictEqual(p.loops.length, 1);
      assert.strictEqual(p.loops[0].tool, 'Bash');
      assert.strictEqual(p.loops[0].repeats, 3);
    } finally {
      fs.unlinkSync(tmp);
    }

    const th = loadThresholds();
    const mk = (over) => Object.assign({ usage: { cost: 0 }, children: [], profile: { toolCalls: 1, errorRate: 0, loops: [] } }, over);
    const has = (flags, f) => flags.some((x) => x.flag === f);

    assert.strictEqual(has(health(mk({ profile: { toolCalls: 60, errorRate: 0, loops: [] } }), { thresholds: th }), 'thrashing'), false);
    assert.strictEqual(has(health(mk({ profile: { toolCalls: 61, errorRate: 0, loops: [] } }), { thresholds: th }), 'thrashing'), true);

    assert.strictEqual(has(health(mk({ profile: { toolCalls: 5, errorRate: 0.2, errors: 1, loops: [] } }), { thresholds: th }), 'flaky'), false);
    assert.strictEqual(has(health(mk({ profile: { toolCalls: 5, errorRate: 0.21, errors: 2, loops: [] } }), { thresholds: th }), 'flaky'), true);

    assert.strictEqual(has(health(mk({ profile: { toolCalls: 1, errorRate: 0, loops: [{ tool: 'Bash', detail: 'x', repeats: 2 }] } }), { thresholds: th }), 'looping'), false);
    assert.strictEqual(has(health(mk({ profile: { toolCalls: 1, errorRate: 0, loops: [{ tool: 'Bash', detail: 'x', repeats: 3 }] } }), { thresholds: th }), 'looping'), true);

    assert.strictEqual(has(health(mk({ usage: { cost: 2.0 } }), { thresholds: th }), 'expensive'), false);
    assert.strictEqual(has(health(mk({ usage: { cost: 2.01 } }), { thresholds: th }), 'expensive'), true);

    assert.strictEqual(has(health(mk({ children: new Array(6).fill(0) }), { thresholds: th, depth: 0 }), 'sprawl'), false);
    assert.strictEqual(has(health(mk({ children: new Array(7).fill(0) }), { thresholds: th, depth: 0 }), 'sprawl'), true);
    assert.strictEqual(has(health(mk({}), { thresholds: th, depth: 3 }), 'sprawl'), true);

    assert.strictEqual(has(health(mk({ usage: { cost: 0, ctxPct: 79 } }), { thresholds: th }), 'compacting'), false);
    assert.strictEqual(has(health(mk({ usage: { cost: 0, ctxPct: 80 } }), { thresholds: th }), 'compacting'), true);

    assert.strictEqual(has(health(mk({ usage: { cost: 0.04 }, profile: { toolCalls: 3, errorRate: 0, loops: [] } }), { thresholds: th }), 'starved'), false);
    assert.strictEqual(has(health(mk({ usage: { cost: 0.04 }, profile: { toolCalls: 2, errorRate: 0, loops: [] } }), { thresholds: th }), 'starved'), true);

    assert.deepStrictEqual(health(null, { thresholds: {} }), [], 'never throws on malformed thresholds, just returns []');

    console.log('selftest ok');
  } else {
    const file = process.argv[2];
    if (!file) {
      console.error('usage: node src/skills.js <path to a session .jsonl under ~/.claude/projects>');
      process.exit(1);
    }
    const p = profile(file);
    const usage = claude.summarizeUsage(file) || {};
    // This demo profiles a session transcript, so judge it as one -- subagent
    // thresholds on a whole session produce flags nobody should act on.
    const flags = health({ usage, children: [], spawnDepth: 0, profile: p }, { thresholds: loadThresholds(), kind: 'session' });
    console.log(JSON.stringify({ profile: p, flags }, null, 2));
  }
}
