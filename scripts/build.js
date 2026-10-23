/* Build a standard ZIP with Node alone; no shell-specific tools or runtime dependencies. */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "src");
const manifest = JSON.parse(
  fs
    .readFileSync(path.join(source, "manifest.json"), "utf8")
    .replace(/^\uFEFF/, ""),
);
const referenced = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((entry) => entry.js),
];
for (const file of referenced)
  if (!fs.existsSync(path.join(source, file)))
    throw new Error(`Manifest references missing file: ${file}`);
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? files(file) : [file];
    });
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [],
  directory = [];
let offset = 0;
const entries = files(source);
for (const file of entries) {
  const name = Buffer.from(
    path.relative(source, file).split(path.sep).join("/"),
  );
  const bytes = fs.readFileSync(file),
    compressed = zlib.deflateRawSync(bytes),
    crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12); // Stable date: 1980-01-01, for reproducible builds.
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const central = Buffer.concat(directory),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...chunks, central, end]);
fs.writeFileSync(path.join(root, "ecoprompt.zip"), archive);
console.log(
  `Built ecoprompt.zip: ${entries.length} files, ${archive.length.toLocaleString()} bytes. Manifest v${manifest.version}.`,
);
