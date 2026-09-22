// Embrulha o PNG 32x32 da AlteaPay num container ICO (ICO aceita PNG embutido).
const fs = require("fs"), path = require("path")
const ROOT = path.resolve(__dirname, "../..")
const png = fs.readFileSync(path.join(ROOT, "public/icon-light-32x32.png"))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)   // reserved
header.writeUInt16LE(1, 2)   // type = icon
header.writeUInt16LE(1, 4)   // count = 1
const entry = Buffer.alloc(16)
entry.writeUInt8(32, 0)      // width
entry.writeUInt8(32, 1)      // height
entry.writeUInt8(0, 2)       // palette
entry.writeUInt8(0, 3)       // reserved
entry.writeUInt16LE(1, 4)    // planes
entry.writeUInt16LE(32, 6)   // bpp
entry.writeUInt32LE(png.length, 8)  // size
entry.writeUInt32LE(22, 12)  // offset
const ico = Buffer.concat([header, entry, png])
fs.writeFileSync(path.join(ROOT, "public/favicon.ico"), ico)
// Next App Router: app/favicon.ico tem precedência e é servido em /favicon.ico
fs.writeFileSync(path.join(ROOT, "app/favicon.ico"), ico)
console.log("favicon.ico AlteaPay gerado (public + app), bytes:", ico.length)
