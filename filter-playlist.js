// Makes your own copy of the iptv-org playlist without the channels listed in
// exclude.txt, and points it at your guide so players can load the EPG
// automatically.
//
// Usage: node filter-playlist.js <input.m3u> <output.m3u> [guide-url]
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
      if (skip) removed++; else { out.push(...block); kept++; }
      block = [];
    }
  } else if (line.trim()) {
    out.push(line);
  }
}

fs.writeFileSync(output, out.join('\n') + '\n');
console.log(`Playlist entries kept: ${kept}, removed by exclude.txt: ${removed}`);
