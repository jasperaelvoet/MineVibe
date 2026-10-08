# Seeded mod configs

Every `*.json` here is seeded into `<game>/config/<same name>` by `apps/server/src/launcher/seedConfigs.ts` on
each launch (PLAN §10):

- the file is written when it does not exist yet;
- otherwise only keys that are missing are added (deep merge), and every value already in the file wins;
- a file that is not a JSON object is left untouched.

| File | What MineVibe needs |
|---|---|
| `dynamic_fps.json` | Unfocused at 30 fps (monitors and agents stay watchable), no idle timeout, the first click after focus is not swallowed, no native downloads. Dynamic FPS saves only fields that differ from its defaults, so a partial file is its own format. |
| `entityculling.json` | `configVersion: 9`, so Entity Culling's upgrader does not reset lists we may add later. The game runs with cwd = game dir because Entity Culling resolves `config/` against cwd. |

options.txt is handled separately (`optionsTxt.ts`), because some of its keys are forced on every launch.
