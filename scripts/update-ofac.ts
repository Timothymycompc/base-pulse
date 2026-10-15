// Refreshes the bundled copy of OFAC's sanctioned EVM addresses (server/data/ofac-evm.json) from Treasury's SDN XML.
//   npx tsx scripts/update-ofac.ts [path/to/sdn.xml]
// With no path it downloads the XML (about 30 MB). The running server also refreshes every 12 hours on its own.
import fs from "fs";
import path from "path";
import { OFAC_SDN_XML, parseSdnXml } from "../server/ofac";

const local = process.argv[2];
const xml = local ? fs.readFileSync(local, "utf8") : await (await fetch(OFAC_SDN_XML, { signal: AbortSignal.timeout(300_000) })).text();
const list = parseSdnXml(xml);
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "server", "data", "ofac-evm.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(list, null, 1) + "\n");
console.log(`Wrote ${Object.keys(list.addresses).length} EVM addresses, published ${list.published}, to ${out}`);
