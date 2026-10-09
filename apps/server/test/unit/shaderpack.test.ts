import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShaderpackPin } from '../../src/launcher/mods.js';
import { installShaderpack, seedIrisProperties } from '../../src/launcher/shaderpack.js';
import { silentLogger } from '../../src/log.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-shader-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const irisFile = (game: string) => join(game, 'config', 'iris.properties');

describe('seedIrisProperties', () => {
  it('creates the file with the pack selected and shaders on', async () => {
    const game = tmp();
    expect(await seedIrisProperties(game, 'Bliss.zip')).toBe('created');
    expect(readFileSync(irisFile(game), 'utf8')).toBe('enableShaders=true\nshaderPack=Bliss.zip\n');
  });

  it('selects the pack when none is chosen, keeping the other lines', async () => {
    const game = tmp();
    mkdirSync(join(game, 'config'));
    writeFileSync(irisFile(game), '#Iris\ncolorSpace=SRGB\nenableShaders=false\nshaderPack=\n');
    expect(await seedIrisProperties(game, 'Bliss.zip')).toBe('selected');
    expect(readFileSync(irisFile(game), 'utf8')).toBe(
      '#Iris\ncolorSpace=SRGB\nenableShaders=true\nshaderPack=Bliss.zip\n',
    );
  });

  it("leaves the player's own choice alone", async () => {
    const game = tmp();
    mkdirSync(join(game, 'config'));
    for (const text of [
      'enableShaders=true\nshaderPack=Other.zip\n',
      'enableShaders=false\nshaderPack=Bliss.zip\n',
    ]) {
      writeFileSync(irisFile(game), text);
      expect(await seedIrisProperties(game, 'Bliss.zip')).toBe('unchanged');
      expect(readFileSync(irisFile(game), 'utf8')).toBe(text);
    }
  });
});

describe('installShaderpack', () => {
  const body = Buffer.from('a shaderpack zip');
  const pin: ShaderpackPin = {
    name: 'Test',
    commit: 'a'.repeat(40),
    filename: 'Test.zip',
    size: body.length,
    sha512: createHash('sha512').update(body).digest('hex'),
    url: 'https://codeload.example.test/zip/a',
  };

  it('downloads once, verified, then reuses the file', async () => {
    const game = tmp();
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response(new Uint8Array(body));
    };
    expect(await installShaderpack({ pin, gameDir: game, log: silentLogger(), fetch })).toBe(body.length);
    expect(readFileSync(join(game, 'shaderpacks', 'Test.zip'))).toEqual(body);
    expect(await installShaderpack({ pin, gameDir: game, log: silentLogger(), fetch })).toBe(0);
    expect(calls).toBe(1);
  });

  it('refuses bytes that do not match the pin', async () => {
    const fetch = async () => new Response(new Uint8Array(Buffer.from('something else!')));
    await expect(installShaderpack({ pin, gameDir: tmp(), log: silentLogger(), fetch })).rejects.toThrow();
  });
});
