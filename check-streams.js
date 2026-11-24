// Tests every stream in a playlist and writes a new playlist with only the
// ones that respond, plus a report of the ones that didn't.
//
// Usage: node check-streams.js <input.m3u> <output.m3u> <report.txt>
//
// A stream counts as working if its address answers within the time limit
// and, for HLS (.m3u8) streams, returns a real HLS playlist whose first
// sub-playlist also answers. Each failing stream is tried twice.
// The address is tested from GitHub's servers (in the US), so streams that
// only work from certain countries may be judged differently than at home.
// Streams with tvg-ids in keep.txt (next to this script) are never removed.

const fs = require('fs');
const path = require('path');

const [input, output, report] = process.argv.slice(2);
if (!input || !output || !report) {
  console.error('Usage: node check-streams.js <input.m3u> <output.m3u> <report.txt>');
  process.exit(1);
}

const TIMEOUT_MS = 12000;
const PARALLEL = Number(process.env.PARALLEL) || 40;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const keep = new Set();
const keepFile = path.join(__dirname, 'keep.txt');
if (fs.existsSync(keepFile)) {
  for (const l of fs.readFileSync(keepFile, 'utf8').split(/\r?\n/)) {
    if (l.trim() && !l.trim().startsWith('#')) keep.add(l.trim());
  }
}

// ---- read the playlist into entries ----
const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const header = lines[0] && lines[0].startsWith('#EXTM3U') ? lines.shift() : '#EXTM3U';
const entries = [];
let block = null;
for (const line of lines) {
  if (line.startsWith('#EXTINF')) block = [line];
  else if (block) {
    block.push(line);
    if (line.trim() && !line.startsWith('#')) {
      const inf = block[0];
      const opt = k => {
        for (const b of block) {
          const m = b.match(new RegExp(`#EXTVLCOPT:${k}=(.*)`));
          if (m) return m[1].trim();
        }
        const a = inf.match(new RegExp(`${k.replace('http-', '')}="([^"]*)"`)) || inf.match(new RegExp(`${k}="([^"]*)"`));
        return a ? a[1] : '';
      };
      entries.push({
        block,
        url: line.trim(),
        id: (inf.match(/tvg-id="([^"]*)"/) || [])[1] || '',
        name: inf.split(',').slice(1).join(',').trim(),
        ua: opt('http-user-agent') || DEFAULT_UA,
        referer: opt('http-referrer'),
      });
      block = null;
    }
  }
}

// ---- testing ----
async function get(url, e) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'User-Agent': e.ua };
    if (e.referer) headers.Referer = e.referer;
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    // read only the start of the response (streams can be endless)
    const reader = res.body.getReader();
    let text = '', bytes = 0;
    while (bytes < 65536) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += Buffer.from(value).toString('latin1');
      if (!/^\s*#EXTM3U/.test(text) && bytes > 1024) break;  // not a playlist: enough read
    }
    reader.cancel().catch(() => {});
    return { ok: true, text, finalUrl: res.url, bytes };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timed out' : (err.cause?.code || err.message) };
  } finally {
    clearTimeout(t);
  }
}

async function test(e) {
  const r = await get(e.url, e);
  if (!r.ok) return r;
  if (/^\s*#EXTM3U/.test(r.text)) {
    // HLS: if it's a master playlist, the first variant must also answer
    const sub = r.text.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
    if (!sub) return { ok: false, why: 'empty HLS playlist' };
    if (/#EXT-X-STREAM-INF/.test(r.text)) {
      const r2 = await get(new URL(sub.trim(), r.finalUrl).href, e);
      if (!r2.ok) return { ok: false, why: `variant ${r2.why}` };
      if (!/^\s*#EXTM3U/.test(r2.text)) return { ok: false, why: 'variant is not HLS' };
    }
    return { ok: true };
  }
  if (/\.m3u8(\?|$)/i.test(e.url)) return { ok: false, why: 'not an HLS playlist' };
  return r.bytes > 0 ? { ok: true } : { ok: false, why: 'no data' };
}

async function main() {
  const results = new Array(entries.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      let r = await test(e);
      if (!r.ok) { await new Promise(s => setTimeout(s, 3000)); r = await test(e); }
      results[i] = r;
      if (++done % 250 === 0) console.log(`Tested ${done}/${entries.length}`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const out = [header], dead = [];
  entries.forEach((e, i) => {
    if (results[i].ok || keep.has(e.id)) out.push(...e.block);
    else dead.push(`${e.id || '(no id)'}\t${e.name}\t${results[i].why}\t${e.url}`);
  });
  fs.writeFileSync(output, out.join('\n') + '\n');
  fs.writeFileSync(report, `Streams that failed the check on ${new Date().toISOString().slice(0, 10)}\n` +
    `tvg-id\tname\treason\taddress\n` + dead.join('\n') + '\n');
  console.log(`Working: ${entries.length - dead.length}, removed as dead: ${dead.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
