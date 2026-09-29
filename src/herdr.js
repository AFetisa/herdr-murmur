'use strict';
// Herdr socket API client. NDJSON over a unix socket / windows named pipe.
// See task spec for verified wire shapes (herdr 0.7.5-preview). No deps.

const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const assert = require('assert');

const REQUEST_TIMEOUT_MS = 5000;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 5000;

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = path.join(os.homedir(), '.config', 'herdr');
  if (process.env.HERDR_SESSION) {
    return path.join(base, 'sessions', process.env.HERDR_SESSION, 'herdr.sock');
  }
  return path.join(base, 'herdr.sock');
}

// results are nested (e.g. {snapshot:{...}}); unwrap the wrapper.
// ponytail: spec says "exactly one key" but the real `herdr api snapshot`
// CLI output is {snapshot:{...}, type:"snapshot"} (verified) - so unwrap
// whenever exactly one key holds an object, ignoring sibling primitive keys.
function unwrap(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const objectKeys = Object.keys(result).filter(
      (k) => result[k] && typeof result[k] === 'object' && !Array.isArray(result[k])
    );
    if (objectKeys.length === 1) return result[objectKeys[0]];
  }
  return result;
}

// Extracted so the NDJSON split-across-chunks behaviour is unit-testable
// without a real socket. Returns a feed(chunk) -> string[] closure.
function makeLineFeeder() {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // last element is the (possibly empty) remainder
    return lines.filter((l) => l.length > 0);
  };
}

function connect({ onEvent, onStatus } = {}) {
  const targetPath = socketPath();
  let socket = null;
  let feed = makeLineFeeder();
  let reqSeq = 0;
  let closed = false;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const subscriptions = []; // events arrays, re-issued on reconnect

  const client = {
    connected: false,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (!socket || !client.connected) {
          reject(Object.assign(new Error('not connected'), { code: 'disconnected' }));
          return;
        }
        const id = 'req_' + (++reqSeq);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('request timed out'), { code: 'timeout' }));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    subscribe(events) {
      subscriptions.push(events);
      return client.request('events.subscribe', { events });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.destroy();
    },
  };

  function failAllPending(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function start() {
    feed = makeLineFeeder();
    socket = net.connect(targetPath);

    socket.on('connect', () => {
      client.connected = true;
      backoff = BACKOFF_MIN_MS;
      onStatus && onStatus('connected');
      for (const events of subscriptions) {
        client.request('events.subscribe', { events }).catch(() => {});
      }
    });

    socket.on('data', (chunk) => {
      const lines = feed(chunk.toString('utf8'));
      for (const line of lines) {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (e) {
          continue; // ponytail: drop malformed lines, no protocol resync logic
        }
        if (frame.id === undefined) {
          onEvent && onEvent(frame);
          continue;
        }
        const p = pending.get(frame.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(frame.id);
        if (frame.error) p.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
        else p.resolve(unwrap(frame.result));
      }
    });

    socket.on('error', (err) => {
      onStatus && onStatus('error', err);
    });

    socket.on('close', () => {
      client.connected = false;
      failAllPending(Object.assign(new Error('connection closed'), { code: 'disconnected' }));
      onStatus && onStatus('disconnected');
      if (!closed) {
        reconnectTimer = setTimeout(start, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    });
  }

  start();
  return client;
}

function snapshotViaCli() {
  return new Promise((resolve, reject) => {
    const bin = process.env.HERDR_BIN_PATH || 'herdr';
    execFile(bin, ['api', 'snapshot'], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(unwrap(JSON.parse(stdout).result));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function snapshot(client) {
  try {
    return await client.request('session.snapshot', {});
  } catch (e) {
    return snapshotViaCli(); // socket down/unavailable -> shell out to the CLI
  }
}

function focusAgent(client, pane_id) {
  return client.request('agent.focus', { pane_id });
}

function normalize(snap) {
  snap = snap || {};
  const workspaces = (snap.workspaces || []).map((w) => ({
    id: w.workspace_id,
    label: w.label,
    number: w.number,
    focused: !!w.focused,
    agent_status: w.agent_status,
  }));
  const tabs = (snap.tabs || []).map((t) => ({
    id: t.tab_id,
    workspace_id: t.workspace_id,
    label: t.label,
    number: t.number,
  }));
  const wsNumber = new Map(workspaces.map((w) => [w.id, w.number]));
  const agents = (snap.agents || [])
    .map((a) => ({
      pane_id: a.pane_id,
      tab_id: a.tab_id,
      workspace_id: a.workspace_id,
      agent: a.agent || a.display_agent || 'unknown',
      agent_status: a.agent_status,
      cwd: a.cwd,
      title: a.terminal_title_stripped || a.title || a.label || null,
      focused: !!a.focused,
    }))
    .sort((a, b) => {
      const an = wsNumber.get(a.workspace_id) ?? 0;
      const bn = wsNumber.get(b.workspace_id) ?? 0;
      if (an !== bn) return an - bn;
      return String(a.pane_id).localeCompare(String(b.pane_id));
    });
  return { workspaces, tabs, agents };
}

module.exports = { connect, snapshot, focusAgent, normalize, socketPath };

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    // -- line feeder: frame split across three chunks --
    const feed = makeLineFeeder();
    assert.deepStrictEqual(feed('{"id":"req_1",'), []);
    assert.deepStrictEqual(feed('"result":{"ok"'), []);
    const lines = feed(':true}}\n');
    assert.deepStrictEqual(lines, ['{"id":"req_1","result":{"ok":true}}']);
    assert.deepStrictEqual(JSON.parse(lines[0]), { id: 'req_1', result: { ok: true } });

    // -- normalize(): tolerant of the 0.7.5 shape, including a missing-fields agent --
    const fixture = {
      workspaces: [
        { workspace_id: 'w1', number: 1, label: 'main', focused: true, pane_count: 2, tab_count: 1, agent_status: 'working' },
        { workspace_id: 'w2', number: 2, label: 'scratch', focused: false, pane_count: 1, tab_count: 1, agent_status: 'idle' },
      ],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'tab1' }],
      agents: [
        { agent: 'claude', agent_status: 'working', cwd: 'C:\\proj', focused: true, pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_title_stripped: 'building thing' },
        // missing-fields agent: no title-ish fields, no display_agent, no agent, no focused
        { agent_status: 'idle', pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
        { agent: 'codex', agent_status: 'idle', pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', label: 'fallback label' },
      ],
    };
    const norm = normalize(fixture);
    assert.strictEqual(norm.agents.length, 3);
    // sorted by workspace number then pane_id: w1:p1, w1:p2, w2:p1
    assert.deepStrictEqual(norm.agents.map((a) => a.pane_id), ['w1:p1', 'w1:p2', 'w2:p1']);
    const missing = norm.agents.find((a) => a.pane_id === 'w1:p1');
    assert.strictEqual(missing.agent, 'unknown');
    assert.strictEqual(missing.title, null);
    assert.strictEqual(missing.focused, false);
    const withTitle = norm.agents.find((a) => a.pane_id === 'w1:p2');
    assert.strictEqual(withTitle.title, 'building thing');
    const fallbackLabel = norm.agents.find((a) => a.pane_id === 'w2:p1');
    assert.strictEqual(fallbackLabel.title, 'fallback label');
    assert.strictEqual(norm.workspaces.length, 2);
    assert.strictEqual(norm.tabs.length, 1);

    console.log('selftest ok');
  } else {
    const client = connect({
      onStatus: (state, detail) => {
        if (state === 'error') process.stderr.write('herdr socket error: ' + (detail && detail.message) + '\n');
      },
    });
    snapshot(client)
      .then((snap) => {
        console.log(JSON.stringify(normalize(snap), null, 2));
        client.close();
        process.exit(0);
      })
      .catch((err) => {
        console.error('snapshot failed:', err.message);
        client.close();
        process.exit(1);
      });
  }
}
