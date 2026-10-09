// M9 debugging: a screenshot of the held PC (m9-hold.ts) into out/m9-shot.jpg, plus its window titles.
//   node m9-shot.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, ROOT } from './lib.mjs';
import { connect, ImageFormat } from './spacesd.mjs';

const { vm } = JSON.parse(readFileSync(join(HERE, 'out', 'm9-hold.json'), 'utf8'));
const serve = JSON.parse(readFileSync(join(ROOT, 'serve', 'serve.json'), 'utf8'));
const info = await (await fetch(`http://127.0.0.1:${serve.port}/lume/vms/${vm}?storage=minevibe`)).json();
const token = readFileSync(join(ROOT, 'shares', vm, 'setup', 'env-token'), 'utf8').trim();
const c = await connect(`http://${info.ipAddress}:3211`, token);
const s = await c.screenshot({ format: ImageFormat.Jpeg ?? ImageFormat.JPEG, quality: 80, maxDimension: 1280, includeCursor: false });
writeFileSync(join(HERE, 'out', 'm9-shot.jpg'), Buffer.from(s.image));
console.log(JSON.stringify(JSON.parse(await c.callJson("/cua.env.v1.WindowsService/ListWindows", "{}")), null, 1));
process.exit(0);
