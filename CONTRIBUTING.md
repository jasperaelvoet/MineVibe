# Contributing to MineVibe

Thanks for your interest. MineVibe is **pre-alpha**: the design is settled
([docs/design/PLAN.md](docs/design/PLAN.md)), and the code is being built milestone by milestone, starting
with a set of spikes. Expect things to move. Issues and small, focused pull requests are welcome; for anything
larger, please open an issue first so we can agree on the approach.

## Development setup

You need:

- An Apple Silicon Mac on macOS 26 or later for the full app. The server, the mod and the docs also build on
  Linux, which is what CI uses.
- **Node 24** (`.nvmrc`; `nvm use` picks it up).
- **A JDK to start Gradle.** The mod targets Java 25, and Gradle can provision a JDK 25 for its daemon
  automatically. If that fails, install Temurin 25.
- **The `claude` CLI 2.1.293 or newer**, logged in, only if you run real agents. Most tests don't need it.

```sh
npm install                          # at the repository root (npm workspaces)
npm run dev                          # Node orchestrator on port 47800, token in .dev-token
cd apps/mod && ./gradlew runClient   # second terminal: Minecraft with the MineVibe mod
```

Set `MINEVIBE_PC_RUNTIME=docker` to run Linux PCs on Docker or OrbStack instead of Apple `container`, and
`MINEVIBE_CLAUDE=bundled` to use the Agent SDK's own `claude` binary during development.

The docs site lives in `apps/docs`: `npm run dev -w apps/docs` for a live preview, `npm run build -w apps/docs`
for a production build with link validation.

## Tests

Run these before you open a pull request; CI runs the same:

```sh
npm run lint        # Biome
npm run typecheck   # tsc --noEmit in every workspace
npm test            # vitest: unit, contract and brainless integration tests (zero tokens)
cd apps/mod && ./gradlew build
```

Some tests never run in CI because they need a Mac, real VMs or a Claude subscription:

- `npm run test:pcs` exercises the real PC drivers (Apple `container`, Lume).
- `npm run test:live` is a small live smoke test of the Claude Agent SDK. **It uses some of your
  subscription quota**, so it only runs when you start it yourself.
- The end-to-end scenario (`MINEVIBE_E2E=1`) is recorded on a real Mac.

If your change touches one of those areas, say in the pull request which of them you ran.

### GameTests and the Minecraft EULA

The mod's server GameTests start a Minecraft server, which requires accepting the
[Minecraft EULA](https://aka.ms/MinecraftEULA). The build never accepts it for you, so `./gradlew build`
skips GameTests by default. If you have read the EULA and accept it, opt in:

```sh
./gradlew build -Pminevibe.acceptMinecraftEula=true
```

Never commit an `eula.txt` or a change that sets the flag by default.

## Spikes

Risky assumptions are tested with throwaway spikes in `spikes/s0` to `spikes/s9` before the code that depends
on them is written. A spike:

- lives entirely in its own folder and is never imported by `apps/` or `packages/`;
- ends with a `result.md` recording what was tried, what was measured and what the design should change;
- may be rough, but must not commit secrets, tokens, worlds or downloaded binaries.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <summary in the imperative, lower case, no trailing period>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `spike`.
- **Scopes** (optional): `server`, `mod`, `protocol`, `pcs`, `agents`, `launcher`, `app`, `docs`, `ci`,
  `deps`.
- Breaking changes get a `!` after the type or scope and a `BREAKING CHANGE:` footer. Protocol changes that
  bump the envelope version `v` are always breaking.

Examples:

```text
feat(server): route leading @mentions in ChatRouter
fix(mod): release held keys when the PC screen closes
docs: explain the Vault security model
spike(s5): measure BGRA frame rate under Apple container
```

## Pull requests

- Keep each pull request to one concern, and add or update tests with behaviour changes.
- Protocol changes update `packages/protocol` (the markdown, the zod schemas **and** the fixtures) so both
  the vitest and JUnit contract tests cover them.
- Update the docs in `apps/docs` when you change something users or contributors see. Mark unbuilt features
  as planned.
- **Never commit** tokens, `.dev-token`, `.env` files, Minecraft worlds or game files, vendor binaries, or
  mod jars. Mods are always downloaded from Modrinth, never rehosted.
- New dependencies need a license compatible with MIT distribution, and an entry in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) if they ship in the app or are downloaded at runtime.

## Security

Please don't report vulnerabilities in public issues; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
