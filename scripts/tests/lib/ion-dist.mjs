// Read-only access to the official .deb's ion-dist SPA (the 3P-config pages
// served on app://localhost) for the feature harnesses.
//
// Up to v3.x the .deb shipped it as a directory, resources/ion-dist/. Since
// v4.29.0 it ships packed as resources/ion-dist.asar (no .unpacked sibling).
// openIonDist() accepts the install tree and returns whichever form is there,
// behind one interface, so a harness never extracts 190 MB to read a few files.
// The asar wins when both exist, like upstream's packaged path: since v4.16336.0
// the .deb also ships resources/ion-dist/ with only a static placeholder
// index.html for pre-4.29.0 processes, which the app never loads.
//
// The asar reader is the minimal subset of @electron/asar's format: an 8-byte
// size pickle (uint32 payload size = 4, uint32 header size), then the header
// pickle (uint32 payload size, uint32 string length, JSON string). File data
// starts at 8 + header size; each file entry carries its offset (a decimal
// string) and size relative to that base. Unpacked entries are refused: the
// upstream archive has none, and reading one would need the .unpacked tree.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

function readAsarHeader(fd) {
  const size = Buffer.alloc(8);
  readSync(fd, size, 0, 8, 0);
  const headerSize = size.readUInt32LE(4);
  const header = Buffer.alloc(headerSize);
  readSync(fd, header, 0, headerSize, 8);
  const strLen = header.readUInt32LE(4);
  return { base: 8 + headerSize, root: JSON.parse(header.toString("utf8", 8, 8 + strLen)) };
}

function asarNode(root, rel) {
  let node = root;
  for (const part of rel.split("/").filter(Boolean)) {
    node = node && node.files ? node.files[part] : undefined;
    if (!node) return undefined;
  }
  return node;
}

// openIonDist(tree): tree is an install tree (the dir holding resources/), e.g.
// tmp/extract/usr/lib/claude-desktop. Returns null when neither form exists,
// else { kind: "dir" | "asar", path, list(relDir), read(relFile) }.
export function openIonDist(tree) {
  const dir = join(tree, "resources", "ion-dist");
  const asar = join(tree, "resources", "ion-dist.asar");
  if (existsSync(asar) && statSync(asar).isFile()) {
    const fd = openSync(asar, "r");
    let parsed;
    try {
      parsed = readAsarHeader(fd);
    } finally {
      closeSync(fd);
    }
    const { base, root } = parsed;
    return {
      kind: "asar",
      path: asar,
      list: (rel) => {
        const node = asarNode(root, rel);
        if (!node || !node.files) throw new Error(`ion-dist.asar: no directory ${rel}`);
        return Object.keys(node.files);
      },
      read: (rel) => {
        const node = asarNode(root, rel);
        if (!node || node.files || node.size === undefined) throw new Error(`ion-dist.asar: no file ${rel}`);
        if (node.unpacked) throw new Error(`ion-dist.asar: ${rel} is unpacked (not supported)`);
        const buf = Buffer.alloc(node.size);
        const f = openSync(asar, "r");
        try {
          readSync(f, buf, 0, node.size, base + Number(node.offset));
        } finally {
          closeSync(f);
        }
        return buf;
      },
    };
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    return {
      kind: "dir",
      path: dir,
      list: (rel) => readdirSync(join(dir, rel)),
      read: (rel) => readFileSync(join(dir, rel)),
    };
  }
  return null;
}
