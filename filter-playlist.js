// Makes your own copy of the iptv-org playlist without the channels listed in
// exclude.txt, and points it at your guide so players can load the EPG
// automatically.
//
// Usage: node filter-playlist.js <input.m3u> <output.m3u> [guide-url]
//
// Optional settings (environment variables, set in update-epg.yml):
//   GROUP_BY=country        sort the playlist by country and use the country
//                           name as each channel's group (folder in players)
//   FIRST_COUNTRIES=...     countries to put at the top, comma-separated,
//                           e.g. Ireland,United Kingdom
// exclude.txt (optional, next to this script): one tvg-id per line.
// Lines starting with # in exclude.txt are treated as comments.

const fs = require('fs');
const path = require('path');

const [input, output, guideUrl] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node filter-playlist.js <input.m3u> <output.m3u> [guide-url]');
  process.exit(1);
}

const exclude = new Set();
const excludeFile = path.join(__dirname, 'exclude.txt');
if (fs.existsSync(excludeFile)) {
  for (const line of fs.readFileSync(excludeFile, 'utf8').split(/\r?\n/)) {
    const id = line.trim();
    if (id && !id.startsWith('#')) exclude.add(id);
  }
}

const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const out = [];
let header = '#EXTM3U';
if (lines[0] && lines[0].startsWith('#EXTM3U')) header = lines.shift();
if (guideUrl) {
  // Replace any existing guide address in the header with yours
  header = header.replace(/\s+(x-tvg-url|url-tvg)="[^"]*"/g, '') + ` x-tvg-url="${guideUrl}"`;
}
out.push(header);

const entries = [];  // kept channel entries
let block = [];   // lines belonging to the current channel entry
let skip = false;
let kept = 0, removed = 0;
for (const line of lines) {
  if (line.startsWith('#EXTINF')) {
    const id = (line.match(/tvg-id="([^"]*)"/) || [])[1] || '';
    skip = exclude.has(id);
    block = [line];
  } else if (block.length) {
    block.push(line);
    if (line.trim() && !line.startsWith('#')) {   // the stream address ends the entry
      if (skip) removed++; else { entries.push(block); kept++; }
      block = [];
    }
  } else if (line.trim()) {
    out.push(line);
  }
}

if ((process.env.GROUP_BY || '').toLowerCase() === 'country') {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const fix = { UK: 'GB', EL: 'GR' };
  const countryOf = inf => {
    const id = (inf.match(/tvg-id="([^"]*)"/) || [])[1] || '';
    const m = id.match(/\.([a-z]{2})(@|$)/i);
    if (!m) return 'Other';
    const code = fix[m[1].toUpperCase()] || m[1].toUpperCase();
    try { const n = names.of(code); return n && n !== code ? n : 'Other'; } catch { return 'Other'; }
  };
  const first = (process.env.FIRST_COUNTRIES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const rank = c => { const i = first.indexOf(c.toLowerCase()); return i < 0 ? first.length : i; };
  const title = inf => inf.split(',').slice(1).join(',').trim().toLowerCase();
  for (const b of entries) {
    const c = countryOf(b[0]);
    b.country = c;
    b[0] = /group-title="[^"]*"/.test(b[0])
      ? b[0].replace(/group-title="[^"]*"/, `group-title="${c}"`)
      : b[0].replace(/^(#EXTINF:[^ ,]*)/, `$1 group-title="${c}"`);
  }
  entries.sort((a, b) =>
    rank(a.country) - rank(b.country) ||
    (a.country === 'Other') - (b.country === 'Other') ||
    a.country.localeCompare(b.country) ||
    title(a[0]).localeCompare(title(b[0])));
  console.log(`Grouped by country: ${new Set(entries.map(b => b.country)).size} countries`);
}
for (const b of entries) out.push(...b);

fs.writeFileSync(output, out.join('\n') + '\n');
console.log(`Playlist entries kept: ${kept}, removed by exclude.txt: ${removed}`);
