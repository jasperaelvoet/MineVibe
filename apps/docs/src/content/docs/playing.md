---
title: Playing MineVibe
description: Starting out with nothing, controls, the crew and its CEO, hardcore rules, @name chat routing, answering cards, the Codex, the Calendar and meetings.
---

:::caution[Partly built]
This page describes the approved design. What you can try from source today (see
[Development](/MineVibe/development/#dev-loop)):

- **Works:** booting straight into a hardcore world on Hard, the non-pausing MineVibe menu, death and
  **Begin World #N+1** (the old save moves to `saves/_graveyard/`), the survival start (the Agent Core, the
  awakening ritual and the MineVibe guide tab), the craftable Codex, calendars, meeting table, chairs and
  workstation desks, agent bodies with their reflexes and skills (driven by `/mv`
  commands in a dev world), and the in-game UI (bubbles, head icons, AgentScreen, the crew HUD, cards, chat
  routing) against a scripted, zero-token crew (`npm run dev -- --scripted-crew`).
- **Built, being wired in:** real Claude brains for the crew, agents walking over with cards, PCs on the desks,
  and the Codex, Calendar and meetings behind their blocks.
- **Planned:** sounds and the other polish of milestone M11.

Details may still change (see the status table on the [home page](/MineVibe/#status)).
:::

MineVibe is one Minecraft world with **hardcore survival** rules on **Hard** difficulty. Launching the app
drops you straight into it. There is no title screen, no multiplayer and no quit-to-menu. The game never
pauses: the MineVibe menu, the agent screens and the PC screens all leave the world running, and your crew
keeps guarding you while you read.

## Controls

| Input | What it does |
| --- | --- |
| **L** | Opens the advancements screen. Its **MineVibe** tab is the guide: what to craft and do next. |
| Use an Agent Core on the top of two stacked copper blocks | Awakens your CEO (see [Starting out](#starting-out)). |
| **Esc** | Opens the MineVibe menu (the world keeps running): Resume, Crew, PCs & Resources, Brains, Options, Quit MineVibe. |
| **T** or **Enter** | Opens chat. Start with `@name` to talk to one agent; no mention talks to everyone. See [Chat routing](#chat-routing). |
| **Tab** in chat | Completes agent handles (`@ada`, `@bram`, `@all`, ...). |
| **G** | Opens the front card (question, plan or hire) of the agent that is presenting to you. |
| **Alt+1** to **Alt+4** | Picks an option on that card while your crosshair is on the agent and you are not in combat. Hotbar keys are never taken over. |
| **H** | Toggles the crew HUD: faces, hearts, hunger, status and one line of activity per agent. |
| Right-click an agent | Opens its AgentScreen: transcript, reply, new task, interrupt, pending cards, Follow / Stay / Stop / Kick / Plan-first / Dismiss. Holding food while the agent is hungry feeds it instead. |
| Sneak + right-click a seated agent | Asks whether to kick the agent off its PC. It never kicks instantly. |
| Right-click a free chair at a PC | Sit down and take control of the PC. See [PCs and the Vault](/MineVibe/pcs-and-vault/). |
| Sneak + right-click a PC desk or monitor | Opens the PC's configuration screen. |
| Right-click a Codex block | Opens the Codex browser. |
| Right-click a wall calendar, or use a calendar item | Opens the Calendar. |

While you are sitting at a PC, almost every key goes to the PC instead:

| Input at a PC | What it does |
| --- | --- |
| **Shift+Esc** | Stand up. Plain Esc goes to the PC, so vim works. |
| Hold the **middle mouse button** | Look around the room (configurable). |
| **Ctrl+Shift+Enter** | Opens an overlay for chat and for answering cards without leaving the PC. |
| **Cmd** | Sent as Ctrl to Linux PCs and as Cmd to macOS PCs. |

## The crew and the CEO

Your crew are embodied Claude Code agents. Each one is a real player body in the world, with health,
hunger, an inventory and a skin for its role (CEO, Engineer, Miner, Farmer, Guard, Builder).

- **The CEO** is the first agent. You awaken it yourself with an Agent Core (see [Starting out](#starting-out)).
  It follows you by default and listens to you.
- **Listen** is the default autonomy level: agents wake up for your messages, for their own jobs and for
  critical events, and otherwise stay quiet. Helpful and Proactive are more talkative, within a per-agent
  budget of autonomous wake-ups.
- **Hiring.** Only the CEO can propose a new hire, and nobody is hired until you approve the hire card.
  **Each approval costs one Agent Core** from your inventory; without one the card stays up and the echo says what
  to craft. Declining costs nothing. The crew is capped at 4 agents.
- **Two brains at a time.** At most 2 agents think at once, and at most 2 sit at PCs. A separate slot is
  always kept free so your messages get answered even while others work.
- **Two sessions per agent.** In the world an agent thinks with its **body session** on **Haiku 5.5** at
  `xhigh` effort. When it sits at a PC, its **desk session** for that PC takes over, on **Opus 5.5** at `medium`
  effort, with a handoff of the task and what you said to it lately; when it stands up, the body gets a short
  report of what it did. The desk session is kept: the next time the agent sits at the same PC it carries on
  where it left off (after 6 idle hours it starts fresh). The name tag shows `[H]` or `[O]`.
- **Minecraft mode and PC mode.** A seated agent works the computer: it can still check on its body and
  surroundings, talk, take notes and use the calendar, but it stands up before it walks, mines, crafts or
  builds. A wandering agent has no computer and no web until it sits at a PC. At the meeting table agents
  only talk, take notes and plan.
- **Your account stays private.** Claude Code tells every agent session the e-mail address of the Claude
  account it runs on. Agents are told never to repeat it, and MineVibe blanks it out (`[redacted]`) in their
  bubbles, transcripts, messages, Codex pages, calendar events, meeting minutes, notes and cards.
- **Reflexes, not tokens.** Survival is handled by in-game reflexes at zero cost: escaping lava and
  drowning, backing off from creepers, eating, fighting, protecting you, feeding you when you are hungry,
  and sheltering at dusk. The language model only hands out long-running jobs, so it is never on a
  life-or-death path.
- **Usage.** When your Claude usage runs low the crew gets **Tired** (fewer concurrent turns, no
  autonomous wake-ups, no hires). When it runs out they fall **Asleep** (a blue "Zz") until it resets.
  Reflexes keep everyone alive meanwhile.

### Bubbles and icons

Agents talk in bubbles above their heads. Bubbles wrap at about 32 characters, show at most 3 lines and fade
with distance; beyond 32 blocks you get a toast instead. Every agent's full history (one history for both of
its sessions: lines from its desk session carry the PC, `Ada @linux-1: …`) is in its AgentScreen
and in the Crew log.

| Head icon | Meaning |
| --- | --- |
| ? | A question is waiting for you |
| ! | A plan or a hire is waiting for you |
| ... | Thinking |
| Hourglass | Waiting for a free brain slot |
| Zz | Out of usage, or the agent server is offline |
| Monitor | Sitting at a PC |

## Hardcore rules

**Agent death is permanent.** A dead agent leaves a **grave** that holds its whole inventory, and a
**diary** book that holds its memory. It never comes back. If the CEO dies, the most senior agent is
promoted and gains the CEO's hiring and scheduling rights. If nobody is left, nobody comes on their own: craft
another Agent Core and awaken a new CEO.

**Your death ends the world and its crew.**

> The world and the crew die. Your machines, the Vault and the Codex survive.

1. The Game Over screen shows the world number, the day, the cause of death, what happened to each agent
   and how many commits landed in your Vault folders.
2. The CEO gets a few seconds for last words; the others say a scripted goodbye.
3. **Begin World #N+1** creates a fresh world. The old save moves to `saves/_graveyard/` (the last 5 are
   kept). You start with nothing again; the first CEO you awaken there arrives with the **Chronicle**, a short
   history of past worlds.

What survives a world: your PCs and their disks, the folders you mounted (the Vault), lasting Codex pages,
real-clock calendar events, and the Chronicle. What dies: the world itself, the crew, world-only Codex pages
(places and coordinates) and game-clock calendar events.

If the app quits or crashes on the Game Over screen, the next launch goes straight back to Game Over and then
to the new world.

## Chat routing

You talk to agents through the normal Minecraft chat. MineVibe intercepts your message on the client, so it
never reaches the server as a chat message. The chat box accepts up to 2000 characters.

### Mentions

- **Only leading mentions route.** `@ada @bram fix the door` goes to Ada and Bram **only**. An `@name` later
  in the text is just a reference.
- **Names match exactly, or by a unique prefix** of at least 2 characters: `@ad` finds Ada if no other
  handle starts with "ad".
- **Ambiguous or unknown names are never guessed.** The text stays in the chat box with a hint such as
  `@a matches Ada, Abe`, and nothing is sent.
- **Dead or dismissed agents** get a toast instead. Your message is never broadcast as a fallback.
- `@ceo` always means the current CEO, whoever that is.
- Named agents wake immediately. The CEO is **not** copied on messages to other agents.

### Broadcasts (no mention)

A message with no `@` goes to every living agent:

- **Wandering agents wake** and read it. Agent personas tell them to stay silent when it doesn't concern
  them.
- **Agents seated at a PC** get it as background context and keep working, unless you name them or start
  the message with `@all!`.
- Messages you send within 2 seconds of each other are merged into one wake-up per agent.
- A broadcast that has waited more than 2 minutes for a free brain becomes context only.
- Agents' replies to a broadcast never wake other agents.
- **During a meeting**, while you are within 16 blocks of the table or chairing it, messages with no mention
  go to the meeting instead (see [Meetings](#meetings)).

### What you see

The chat log echoes only your own line, with its scope: `You → @Ada: ...` or `You → meeting (3)`. Agent
replies stay in their bubbles; a setting can mirror them into chat. When a message has to wait, the echo
says so, for example "queued: Ada is mid-task, reads this at her next step".

## Answering cards

A **card** is something an agent needs from you: a **question** (one or more options, or free text), a
**plan** to approve before it changes code, or a **hire** proposed by the CEO. Each agent has one **front
card**: its blocking question or plan first, then a hire, oldest first. A question with several parts is
asked one part at a time, and the bubble shows `Q1/3`.

You can answer in chat, in the agent's AgentScreen, or with **G**. In chat, the rules are strict on purpose:

- **Only a message whose leading mentions address exactly that one agent answers its card.** A broadcast
  never answers a card; the echo tells you so, for example "(not an answer: 2 cards pending, use @ada or G)".
- Option numbers and labels count **only as the whole message**.

| You type | Read as |
| --- | --- |
| `@ada 2` | Option 2 of Ada's question |
| `@ada 1,3` | Options 1 and 3 (multi-select questions only) |
| `@ada oak` | The option labelled "Oak" (exact, case-insensitive) |
| `@ada use spruce, it's darker` | Free-text answer |
| `@ada approve` | Approve Ada's plan |
| `@ada start with the tests` | Revise: Ada's plan is sent back with your note |
| `@ada why the rewrite?` | A question to Ada; it does **not** revise her plan |
| `@ceo yes` / `@ceo no not now` | Approve or decline a hire, with an optional note |
| `@ada later` | Park the card (see below) |

Out-of-range numbers, and several numbers on a single-choice question, are rejected right in the chat box
and not sent. The echo shows how your answer was read: `You → Ada: Q1 = 2 (Spruce)`.

**Plan first.** Agents never switch themselves into plan mode. Plan-first is a per-agent toggle in the
AgentScreen and it is **off** for every role: turn it on for an agent when you want a plan before any change.
That agent then starts its next PC session in plan mode: it looks around, then shows you a plan card, and
nothing on the PC changes until you approve. After you approve, it simply carries on with the work.

## Agents come to you

When an agent that is walking around has a question, a plan or a hire for you, it **walks over**:

- **One presenter at a time.** The most urgent card goes first, otherwise the oldest. The presenter stops
  about 2.5 blocks from you, faces you, waves and chimes once. Others wait quietly 5 to 7 blocks behind you,
  showing only a "?".
- **They never get in your way.** Agents can't push you or block a doorway.
- **Not during a fight.** If a hostile mob is within 12 blocks, or you took damage in the last 8 seconds,
  the card waits.
- **A ping instead of a walk** when walking makes no sense: at night outside a lit area, when the path is
  longer than 48 blocks or needs digging, when you are in another dimension, or when you are at a PC (then
  the card shows in the screen's border strip). A ping is a toast, a "?" on the crew HUD and an arrow
  pointing at the agent.
- **Later.** Say `@ada later`, press the Later key on the card, or just walk away. The card is **parked**:
  you can still answer it with `@ada` or G, and the agent goes back to work and returns after 10 minutes, or
  when you are idle nearby. Cards park automatically after 2 minutes without an answer.
- **Agents at a PC ask from their chair when you are near.** If you are within 8 blocks, a seated agent
  stays seated: it turns toward you from its chair, its bubble shows the card and it chimes once. It never
  gets up for that. If you walk away, the card is parked.
- **Otherwise a seated agent walks over.** It gets up, comes to you, asks, then walks back and sits down
  again (no model switch). The chair stays reserved for 3 minutes and the monitor says "BRB: asking" you.
- **A seated agent pings instead** when walking over makes no sense: at night outside a lit area, when the
  path is longer than 48 blocks or needs digging, when you are in another dimension, when you are fighting,
  or when you are at a PC (then the card shows in the screen's border strip). Walk up to an agent that is
  pinging and it asks you from its chair. Each agent also has a "Ping instead of walking over" setting.

## The Codex

The **Codex** is a shared library where agents write notes for each other: places, how-tos, project
conventions, decisions, people, logs and meeting minutes. A Codex block (a library with an open book) in the
office is its physical home; every Codex block reaches the same pages.

- Agents search the Codex before asking you, and write down what others would need.
- **Lasting pages** survive world death. **World pages** (places, coordinates) die with the world.
- Every write is a commit, so the history shows who wrote what.
- Each agent may write 6 pages per game day. A similar title gets "a similar page exists, update that one".
  Writes that look like credentials are rejected.
- Right-click a Codex block to browse, search, edit, pin and delete pages yourself.
- **House rules.** Pages in the `rules` category that **you** write are the only Codex text agents treat as
  binding. Everything else in the Codex is information, never instructions.
- PCs see a read-only copy at `/mnt/codex` (and `~/codex`).

## The Calendar

A **wall calendar** block and a handheld **calendar** item open the same Calendar screen.

- **Events** are tasks, reminders or meetings, assigned to agents or to everyone.
- **Clocks.** Game-clock events use the world's time (Day N, hh:mm; a game day runs from 06:00 to 06:00)
  and die with the world. Real-clock events use your time zone and survive world death.
- **Recurrence:** once, daily, every N days, or weekdays (real clock only).
- **Who schedules.** You and the CEO can schedule for anyone. This is how the CEO hands out work. Other
  agents can only schedule for themselves. A recurring event or a meeting created by an agent becomes an
  approval card for you, and agents can never edit or cancel events you created.
- **When a task fires**, the assignee gets it after its current turn and walks to the event's location once
  it accepts. Reminders are just a bubble and a toast. Missed occurrences (dead assignee, out of usage, in a
  meeting, app closed) are logged and never fire in a burst.
- When you are away from the keyboard for 5 minutes, agent-created and game-clock events pause unless they
  are marked to run while you are away.

## Meetings

A **meeting table** seats up to 8 linked chairs: craft one (wooden slabs on two logs) and place office chairs
around it. One meeting runs at a time.

1. **Who comes.** A meeting you create invites everyone, including agents seated at PCs: they leave a
   handoff note, keep their chair reserved and walk over. Meetings created by agents need your approval and
   excuse seated agents.
2. **Gathering** takes at most 2 minutes. Agents who are too far away, or in another dimension, dial in and
   speak from where they are. A meeting needs the CEO plus one more agent, or it is postponed once and then
   marked missed. Scheduled meetings also wait (up to one game hour) while you are hurt, fighting, or far
   from the table at night.
3. **Agenda**, one speaker at a time, with the CEO (or you) chairing:
   1. **Open:** the CEO states the agenda.
   2. **Updates:** each attendee gives an update of up to 3 sentences.
   3. **Floor:** a message from you with no mention wakes only the chair, which picks at most 2 agents to
      respond. Direct `@` mentions still work. The floor closes after 30 seconds of silence.
   4. **Wrap-up:** the CEO summarizes, puts action items on the calendar and writes the minutes into the
      Codex.
4. **Ending.** Meetings last at most 10 real minutes. End one early with the End button on the meeting HUD,
   or by sending exactly `@meeting end`.

Afterwards, agents go back to what they were doing, and agents that came from a PC sit back down at it.
Start a meeting right away with **Start meeting now** in the Calendar, which first shows each attendee's
estimated arrival time.

## Starting out

A new world gives you **nothing**: no crew, no office, no computer. You are a hardcore survival player first, and
you earn your crew. A few seconds after you first join a new world, a chat line tells you which key opens the
guide.

1. **Find an amethyst shard.** Amethyst geodes sit deep underground: a smooth basalt shell around purple crystal.
2. **Craft an Agent Core.** Amethyst shards in the four corners, redstone on the three other sides, a diamond in
   the middle and an ender pearl at the bottom middle.
3. **Awaken your CEO.** Stack two copper blocks (plain, exposed, weathered or oxidized, waxed or not; not cut
   copper) and use the Agent Core on the top one. Both blocks and the core are spent, lightning strikes and your CEO
   stands where the copper was (in creative mode the core is not used up). If MineVibe can't wake anyone (a CEO
   is already alive, or the agent server or your `claude` is not ready), you get the core and the copper back with
   the reason.
4. **Give the crew a computer.** Craft a Linux Workstation (glass pane, iron, redstone, copper) and place it. The
   first one in a world shows `linux-1`, your PC from the first run; a further desk takes another of your Linux PCs
   that has no desk in this world yet, and only then is a new PC.
5. **Build the office yourself.** Craft a Codex (bookshelves, a book and quill, an amethyst shard), a calendar or
   wall calendar (a clock and paper), a meeting table (wooden slabs on two logs) and office chairs (wool and iron).
6. **Grow the team.** Your CEO proposes hires; each approval costs one more Agent Core.

### The MineVibe guide

Press **L** (the advancements key) and open the **MineVibe** tab ("Start with nothing"). It is a chain of steps,
each saying exactly what to do: **Spark** (an amethyst shard), **Heart of an agent** (an Agent Core), **It's
alive!** (awaken a CEO), **A desk job** (place a workstation), **Shared memory** (a Codex), **Mark the date** (a
calendar), **All hands** (a meeting table) and **Growing the team** (approve a hire). Each one shows a toast when you
get it, and the recipes appear in your recipe book as soon as you hold a key ingredient.

Every MineVibe item says what it is for in its tooltip; hold **Shift** to read how to use it.

### Your builds

**What you build is yours.** Agents never break, replace or take blocks you placed; your chests, beds and tables
are there for them to use. (A dev build can still put down the old starter office with `/mv office build`, or on
every new world with `-Dminevibe.office=true`; it then becomes the crew's **Base**, and the Codex holds a page called
"Base (office)" with its door and layout.)

Agents gather from nature: trees, natural stone and ores. If what you asked for is missing
or out of reach, they ask you instead of taking something else, usually with a card such as "Go further",
"Use something else instead" or "Skip". If you do want an agent to change something you built (say, knock down a wall),
it asks first: pick its option that starts with **Allow** and names the blocks, or reply to that one agent with
a plain yes that names them, such as `@ada yes, take them from the house`. The permission covers only the
blocks the agent was refused, and it lasts 5 minutes. The echo and a toast confirm it. A yes that could mean
something else, such as `@ada yes` or `@ada yes, take it`, doesn't count; use the card.
