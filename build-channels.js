// Builds english.channels.xml from the live iptv-org English playlist.
// For every tvg-id in the playlist, it picks one listing source from the
// iptv-org/epg grabber's own channel files (English-language sources first).
//
// If a playlist channel has no listing of its own (e.g. a local US station), it
// borrows the listing of another feed of the same channel, but ONLY when both
// feeds are in the same time zone (checked against iptv-org's feeds.csv), so
// programme times are never shifted.
//
// Usage: node build-channels.js <epg-repo-dir> <feeds.csv> <output-file> [playlist-url] [previous-channels-file]
// If a previous channels file is given, a channel keeps the source it already
// had there whenever the grabber still offers that exact source.
// Optional: a file "exclude.txt" next to this script, one tvg-id per line,
// lists channels you don't want in the guide.

const fs = require('fs');
const path = require('path');

const [epgDir, feedsCsv, outFile, playlistUrl = 'https://iptv-org.github.io/iptv/languages/eng.m3u', previousFile] = process.argv.slice(2);
if (!epgDir || !feedsCsv || !outFile) {
  console.error('Usage: node build-channels.js <epg-repo-dir> <feeds.csv> <output-file> [playlist-url]');
  process.exit(1);
}

function listChannelFiles(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listChannelFiles(p));
    else if (e.name.endsWith('.channels.xml')) out.push(p);
  }
  return out;
}

// UTC offsets of a time zone in January and July, e.g. "-05:00/-04:00"
const offsetCache = new Map();
function offsets(zone) {
  if (!zone) return null;
  if (offsetCache.has(zone)) return offsetCache.get(zone);
  let v = null;
  try {
    v = [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)].map(t =>
      new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(t).find(p => p.type === 'timeZoneName').value).join('/');
  } catch { v = null; }
  offsetCache.set(zone, v);
  return v;
}

function readFeedZones(file) {
  const zones = new Map(); // "Channel@Feed" -> first time zone
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = rows.shift().split(',');
  const ci = head.indexOf('channel'), ii = head.indexOf('id'), ti = head.indexOf('timezones');
  for (const row of rows) {
    // feeds.csv fields may be quoted and contain commas
    const cols = [...row.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map(m => m[1].replace(/^"|"$/g, ''));
    if (cols.length <= ti) continue;
    zones.set(`${cols[ci]}@${cols[ii]}`, (cols[ti] || '').split(';')[0]);
  }
  return zones;
}

function attrs(tag) {
  const a = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) a[m[1]] = m[2];
  return a;
}

async function main() {
  // 1. Playlist IDs
  let m3u;
  if (/^https?:/.test(playlistUrl)) {
    const res = await fetch(playlistUrl);
    if (!res.ok) throw new Error(`Playlist download failed: ${res.status}`);
    m3u = await res.text();
  } else {
    m3u = fs.readFileSync(playlistUrl, 'utf8');
  }
  const wanted = new Set([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(m => m[1]));

  const excludeFile = path.join(__dirname, 'exclude.txt');
  if (fs.existsSync(excludeFile)) {
    for (const line of fs.readFileSync(excludeFile, 'utf8').split(/\r?\n/)) {
      if (line.trim()) wanted.delete(line.trim());
    }
  }

  const zones = readFeedZones(feedsCsv);
  const base = id => id.split('@')[0];
  const wantedBases = new Set([...wanted].map(base));

  // 2. Every source the grabber knows about
  const sources = new Map(); // xmltv_id -> [{site, lang, site_id, name}]
  for (const file of listChannelFiles(path.join(epgDir, 'sites'))) {
    const xml = fs.readFileSync(file, 'utf8');
    for (const m of xml.matchAll(/<channel\s([^>]*)>([^<]*)<\/channel>/g)) {
      const a = attrs(m[1]);
      if (!a.xmltv_id || !a.site || !a.site_id || !wantedBases.has(base(a.xmltv_id))) continue;
      if (!sources.has(a.xmltv_id)) sources.set(a.xmltv_id, []);
      sources.get(a.xmltv_id).push({ site: a.site, lang: a.lang || 'en', site_id: a.site_id, name: m[2] });
    }
  }

  // 3. One source per channel, English-language listings preferred
  const byBase = new Map(); // base -> [xmltv_id with sources]
  for (const id of sources.keys()) {
    if (!byBase.has(base(id))) byBase.set(base(id), []);
    byBase.get(base(id)).push(id);
  }
  const previous = new Map(); // xmltv_id -> "site|site_id"
  if (previousFile && fs.existsSync(previousFile)) {
    for (const m of fs.readFileSync(previousFile, 'utf8').matchAll(/<channel\s([^>]*)>/g)) {
      const a = attrs(m[1]);
      if (a.xmltv_id) previous.set(a.xmltv_id, `${a.site}|${a.site_id}`);
    }
  }
  const best = list => list.find(s => s.lang === 'en') || list[0];
  const bestFor = (id, list) =>
    list.find(s => previous.get(id) === `${s.site}|${s.site_id}`) || best(list);
  const esc = s => s.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;').replace(/"/g, '&quot;');
  const lines = [];
  let own = 0, borrowed = 0, skippedTz = 0;
  for (const id of [...wanted].sort()) {
    let pick = null;
    if (sources.has(id)) { pick = bestFor(id, sources.get(id)); own++; }
    else {
      const myTz = offsets(zones.get(id));
      const sibling = (byBase.get(base(id)) || []).find(s => myTz && offsets(zones.get(s)) === myTz);
      if (sibling) { pick = bestFor(sibling, sources.get(sibling)); borrowed++; }
      else if (byBase.has(base(id))) skippedTz++;
    }
    if (pick) lines.push(`  <channel site="${esc(pick.site)}" lang="${esc(pick.lang)}" xmltv_id="${esc(id)}" site_id="${esc(pick.site_id)}">${pick.name}</channel>`);
  }

  fs.writeFileSync(outFile, `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${lines.join('\n')}\n</channels>\n`);
  console.log(`Playlist channels: ${wanted.size}`);
  console.log(`Channels with their own listing: ${own}`);
  console.log(`Channels borrowing a same-time-zone listing: ${borrowed}`);
  console.log(`Left out (only a different-time-zone listing exists): ${skippedTz}`);
  console.log(`Channels with no listing at all: ${wanted.size - lines.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
