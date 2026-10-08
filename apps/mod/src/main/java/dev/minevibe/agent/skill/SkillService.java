package dev.minevibe.agent.skill;

import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.brain.IdleMode;
import dev.minevibe.agent.brain.ReflexBrain;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.SeatJob;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Seats.SeatTarget;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficeService;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.clock.WorldClocks;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The integrated server's side of the skill API (PLAN 7.4, protocol §7.3-7.5): {@code skill.run} / {@code skill.cancel}
 * / {@code obs.query}, {@code agent.spawn} / {@code despawn} / {@code mode}, {@code agent.seat} / {@code unseat},
 * {@code agent.approach}, and the jobs' life cycle on the bridge.
 *
 * <ul>
 *   <li><b>skill.run</b> starts a job and waits up to {@code waitMs} (capped at 120 s) for it: a job that ends in time is
 *       answered with its outcome; otherwise the reply says {@code running} and the outcome follows as
 *       {@code skill.result}. Progress goes out as {@code skill.progress}, at most once a second per job.</li>
 *   <li><b>agent.seat</b> answers {@code running} at once (after the typed pre-checks), and reports the walk's end as
 *       {@code skill.result}; a seated agent's chair is tracked here so every way of leaving it (stand_up, a reflex, a
 *       kick, death) is reported as {@code pc.unseat} with its reason.</li>
 * </ul>
 * Everything runs on the server thread. One instance per running server ({@link #get}).
 */
public final class SkillService {
	/** {@code wait_s} is at most 120 s (PLAN 6.5 "Long jobs"). */
	public static final int MAX_WAIT_MS = 120_000;
	private static final long PROGRESS_INTERVAL_NANOS = 1_000_000_000L;
	private static final int FINISHED_KEPT = 64;
	private static final Pattern AGENT_ID = Pattern.compile("[a-z][a-z0-9_]{0,15}");

	private static volatile @Nullable SkillService current;

	private final MinecraftServer server;
	private volatile SkillOutbox outbox = SkillOutbox.BRIDGE;
	private final Map<String, Handle> running = new LinkedHashMap<>();
	private final Deque<Handle> finished = new ArrayDeque<>();
	private final Map<String, Seated> seated = new HashMap<>();
	/** Jobs that ended while Node was not connected: their {@code skill.result} goes out on the next handshake. */
	private final Deque<Handle> unreported = new ArrayDeque<>();
	private final BodyEmitter emitter;

	/** A job started through the bridge, with its reply and reporting state. */
	public static final class Handle {
		private final String jobId;
		private final String agentId;
		private final SkillJob job;
		private final long startNanos = System.nanoTime();
		private final long deadlineNanos;
		private @Nullable CompletableFuture<Map<String, Object>> reply;
		private int progressVersion;
		private long progressSentNanos;
		private SkillJob.@Nullable Outcome outcome;
		private long endNanos;

		Handle(final String jobId, final String agentId, final SkillJob job, final long waitMs) {
			this.jobId = jobId;
			this.agentId = agentId;
			this.job = job;
			this.deadlineNanos = this.startNanos + waitMs * 1_000_000L;
		}

		public String jobId() {
			return this.jobId;
		}

		public String agentId() {
			return this.agentId;
		}

		public SkillJob job() {
			return this.job;
		}

		public SkillJob.@Nullable Outcome outcome() {
			return this.outcome;
		}

		public long elapsedMs() {
			return ((this.outcome != null ? this.endNanos : System.nanoTime()) - this.startNanos) / 1_000_000L;
		}
	}

	/** Where an agent sits (after a successful {@code agent.seat}). */
	public record Seated(SeatTarget target, long epoch, ResourceKey<Level> dim, BlockPos chair) {
	}

	private SkillService(final MinecraftServer server) {
		this.server = server;
		this.emitter = new BodyEmitter(this);
	}

	public static synchronized SkillService get(final MinecraftServer server) {
		SkillService s = current;
		if (s == null || s.server != server) {
			s = new SkillService(server);
			current = s;
		}
		return s;
	}

	public static @Nullable SkillService current() {
		return current;
	}

	static synchronized void stopped(final MinecraftServer server) {
		if (current != null && current.server == server) {
			current = null;
		}
	}

	public MinecraftServer server() {
		return this.server;
	}

	public SkillOutbox outbox() {
		return this.outbox;
	}

	/** GameTests record the bridge traffic instead of sending it. */
	public void setOutbox(final SkillOutbox outbox) {
		this.outbox = outbox;
	}

	BodyEmitter emitter() {
		return this.emitter;
	}

	// ---------------------------------------------------------------- lookups

	public AgentPlayer agent(final String agentId) {
		AgentPlayer agent = AgentService.get(this.server).agent(agentId.toLowerCase(Locale.ROOT));
		if (agent == null) {
			throw new BridgeException(Codes.UNKNOWN_AGENT, "no living agent " + agentId);
		}
		return agent;
	}

	public @Nullable Handle handle(final String jobId) {
		Handle h = this.running.get(jobId);
		if (h != null) {
			return h;
		}
		for (Handle f : this.finished) {
			if (f.jobId.equals(jobId)) {
				return f;
			}
		}
		return null;
	}

	/** The running skill job of an agent, if any. */
	public @Nullable Handle currentHandle(final String agentId) {
		for (Handle h : this.running.values()) {
			if (h.agentId.equals(agentId)) {
				return h;
			}
		}
		return null;
	}

	public @Nullable Seated seated(final String agentId) {
		return this.seated.get(agentId);
	}

	// ---------------------------------------------------------------- skill.run / skill.cancel

	/** {@code skill.run}: completes with a {@code SkillRunResult}, or fails with a {@link BridgeException}. */
	public CompletableFuture<Map<String, Object>> run(final Skills.SkillRun req) {
		AgentPlayer agent = this.agent(req.agentId());
		Handle existing = this.handle(req.jobId());
		if (existing != null) {
			// A repeated request for the same job: answer with what is known.
			return CompletableFuture.completedFuture(existing.outcome == null ? runningReply(existing) : finalReply(existing, existing.outcome));
		}
		SkillJob job = SkillFactory.create(req.skill(), req.args() == null ? new JsonObject() : req.args());
		if (agent.jobs().hasJob() && !req.replace()) {
			Job busy = agent.jobs().current();
			throw new BridgeException(Codes.BUSY, agent.getGameProfile().name() + " is busy with " + (busy == null ? "a job" : busy.name()) + " (send replace to cancel it)");
		}
		return this.start(agent, req.jobId(), job, Math.max(0, Math.min(MAX_WAIT_MS, req.waitMs())));
	}

	private CompletableFuture<Map<String, Object>> start(final AgentPlayer agent, final String jobId, final SkillJob job, final long waitMs) {
		job.bind(jobId);
		Handle h = new Handle(jobId, agent.agentId(), job, waitMs);
		CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
		h.reply = reply;
		this.running.put(jobId, h);
		// A new task overrides walking to a scheduled place.
		agent.brain().setAttend(null);
		job.outcome().thenAccept(o -> this.ended(h, o));
		agent.jobs().start(job);
		if (waitMs == 0 && !reply.isDone()) {
			reply.complete(runningReply(h));
		}
		return reply;
	}

	private static Map<String, Object> runningReply(final Handle h) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("jobId", h.jobId);
		m.put("status", Skills.RUNNING);
		return m;
	}

	private Map<String, Object> finalReply(final Handle h, final SkillJob.Outcome o) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("jobId", h.jobId);
		m.put("status", o.status());
		m.put("result", this.withFooter(h.agentId, o.result()));
		if (o.code() != null) {
			m.put("error", failure(o));
		}
		return m;
	}

	private static Types.Failure failure(final SkillJob.Outcome o) {
		String code = o.code() != null && o.code().matches(Types.ERROR_CODE_REGEX) ? o.code() : "FAILED";
		return new Types.Failure(code, ProtocolCodec.clip(o.message() == null ? "" : o.message(), 2000));
	}

	private JsonObject withFooter(final String agentId, final JsonObject result) {
		JsonObject r = result.deepCopy();
		AgentPlayer agent = AgentService.get(this.server).agent(agentId);
		if (agent != null) {
			r.addProperty("footer", StatusFooter.line(agent));
		}
		return r;
	}

	/** A job left its runner: answer the waiting {@code skill.run}, or report it as {@code skill.result}. */
	private void ended(final Handle h, final SkillJob.Outcome o) {
		h.outcome = o;
		h.endNanos = System.nanoTime();
		this.running.remove(h.jobId);
		this.finished.addLast(h);
		while (this.finished.size() > FINISHED_KEPT) {
			this.finished.removeFirst();
		}
		if (h.job instanceof SeatJob seat) {
			this.seatEnded(h, seat, o);
		}
		boolean connected = this.outbox.connected();
		CompletableFuture<Map<String, Object>> reply = h.reply;
		if (reply != null && !reply.isDone()) {
			if (connected) {
				reply.complete(this.finalReply(h, o));
				return;
			}
			// The request's connection is gone, and so would this answer be: report it as skill.result instead.
			reply.complete(runningReply(h));
		}
		if (connected) {
			this.sendResult(h);
		} else {
			this.unreported.addLast(h);
			while (this.unreported.size() > FINISHED_KEPT) {
				this.unreported.removeFirst();
			}
		}
	}

	private void sendResult(final Handle h) {
		SkillJob.Outcome o = h.outcome;
		if (o == null) {
			return;
		}
		JsonObject result = this.withFooter(h.agentId, o.result());
		this.outbox.send(Skills.SKILL_RESULT, new Skills.SkillResult(
			h.jobId, h.agentId, o.status(), result, o.code() == null ? null : failure(o), Math.max(0L, h.elapsedMs())));
	}

	/**
	 * Server thread, after the bridge lost its connection: a {@code skill.run} still waiting for its job can no longer be
	 * answered (a reply only goes to the connection its request came on), so its outcome will follow as
	 * {@code skill.result} on the next connection instead of being dropped.
	 */
	public void connectionLost() {
		for (Handle h : List.copyOf(this.running.values())) {
			CompletableFuture<Map<String, Object>> reply = h.reply;
			if (reply != null && !reply.isDone()) {
				reply.complete(runningReply(h));
			}
		}
	}

	/** Server thread, after a handshake: the outcomes of jobs that ended while Node was away. */
	public void connectionRestored() {
		while (!this.unreported.isEmpty() && this.outbox.connected()) {
			this.sendResult(this.unreported.removeFirst());
		}
	}

	/** {@code skill.cancel}: cancels one job of the agent, or all of them. */
	public Map<String, Object> cancel(final Skills.SkillCancel req) {
		AgentPlayer agent = this.agent(req.agentId());
		List<String> cancelled = new ArrayList<>();
		Job current = agent.jobs().current();
		if (current != null) {
			String currentId = current instanceof SkillJob sj ? sj.jobId() : null;
			if (req.jobId() == null || req.jobId().equals(currentId)) {
				if (currentId != null) {
					cancelled.add(currentId);
				}
				agent.jobs().cancel("cancelled: " + req.reason());
			}
		}
		return Map.of("cancelled", cancelled);
	}

	// ---------------------------------------------------------------- obs.query

	public Map<String, Object> obs(final Skills.ObsQuery req) {
		AgentPlayer agent = this.agent(req.agentId());
		JsonObject result = Observations.query(this, agent, req.query(), req.args() == null ? new JsonObject() : req.args());
		return Map.of("result", result);
	}

	// ---------------------------------------------------------------- bodies

	/** {@code agent.spawn}: spawn (or restore) a body; idempotent for a body that is already there. */
	public Map<String, Object> spawn(final Bodies.AgentSpawn req) {
		AgentService service = AgentService.get(this.server);
		String id = req.agentId().toLowerCase(Locale.ROOT);
		if (!AGENT_ID.matcher(id).matches()) {
			throw Refs.badArgs("agent ids in the mod are 1-16 of [a-z0-9_], starting with a letter: " + req.agentId());
		}
		AgentRole role = AgentRole.byId(req.role());
		if (role == null) {
			throw Refs.badArgs("unknown role " + req.role());
		}
		AgentPlayer agent = service.agent(id);
		boolean restored = false;
		BlockPos door = null;
		if (agent == null) {
			if (service.isDead(id)) {
				throw new BridgeException("AGENT_DEAD", id + " is dead; agents never come back");
			}
			restored = java.nio.file.Files.isRegularFile(AgentService.playerDataFile(this.server, AgentService.uuidFor(id)));
			ServerLevel level = this.server.overworld();
			Vec3 pos;
			if (req.at() != null) {
				Identifier dim = Identifier.tryParse(req.at().dim());
				ServerLevel l = dim == null ? null : this.server.getLevel(ResourceKey.create(Registries.DIMENSION, dim));
				if (l == null) {
					throw Refs.badArgs("unknown dimension " + req.at().dim());
				}
				level = l;
				pos = Vec3.atBottomCenterOf(Refs.pos(req.at().pos()));
			} else {
				door = officeDoor(this.server);
				pos = door != null ? this.spawnNear(level, door) : this.defaultSpawn(level);
			}
			try {
				agent = service.spawn(id, mcName(req.name(), req.handle()), role, level, pos, 0.0F);
			} catch (IllegalArgumentException e) {
				throw Refs.badArgs(e.getMessage());
			} catch (IllegalStateException e) {
				throw new BridgeException("SPAWN_FAILED", e.getMessage());
			}
		}
		this.adopt(agent);
		if (agent.brain().home() == null) {
			// Where it was told to appear (or the office door it appeared at) is home: Shelter at dusk goes there.
			if (req.at() != null) {
				agent.brain().setHome(Refs.pos(req.at().pos()));
			} else if (door != null) {
				agent.brain().setHome(door);
			}
		}
		IdleMode mode = IdleMode.byId(req.mode());
		agent.brain().setMode(mode == null ? IdleMode.FOLLOW : mode, null);
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("pos", new Types.Vec3(agent.getX(), agent.getY(), agent.getZ()));
		out.put("dim", agent.level().dimension().identifier().toString());
		out.put("restored", restored);
		return out;
	}

	/** A Minecraft profile name ({@code [A-Za-z0-9_]{1,16}}) from the display name, else the handle. */
	static String mcName(final String display, final String handle) {
		String n = display.replaceAll("[^A-Za-z0-9_]", "");
		if (n.isEmpty()) {
			n = handle.replaceAll("[^A-Za-z0-9_]", "");
		}
		return n.length() > 16 ? n.substring(0, 16) : n.isEmpty() ? "Agent" : n;
	}

	/**
	 * The starter office's door (its {@code door} slot: the porch cell in front of it), where agents spawned without
	 * {@code at} appear (protocol §7.3); null when the world has no office.
	 */
	static @Nullable BlockPos officeDoor(final MinecraftServer server) {
		OfficeLayout office = OfficeService.layout(server);
		OfficeLayout.Slot door = office == null ? null : office.firstSlot(OfficeLayout.DOOR);
		return door == null ? null : door.pos();
	}

	/** On {@code base} when one can stand there (or its chunk is not loaded yet), else the nearest spot around it. */
	private Vec3 spawnNear(final ServerLevel level, final BlockPos base) {
		if (!level.isLoaded(base) || AgentNavigator.isStandable(level, base)) {
			return Vec3.atBottomCenterOf(base);
		}
		return this.standableAround(level, base, 1);
	}

	/** Near the player when one is in the overworld, else world spawn (worlds without an office). */
	private Vec3 defaultSpawn(final ServerLevel level) {
		BlockPos base = null;
		for (ServerPlayer p : this.server.getPlayerList().getPlayers()) {
			if (!(p instanceof AgentPlayer) && p.level() == level) {
				base = p.blockPosition();
				break;
			}
		}
		if (base == null) {
			base = this.server.getWorldData().overworldData().getRespawnData().pos();
		}
		return this.standableAround(level, base, 2);
	}

	/** The first standable spot {@code minRadius} to 6 blocks out from {@code base} (straight lines), else {@code base}. */
	private Vec3 standableAround(final ServerLevel level, final BlockPos base, final int minRadius) {
		for (int r = minRadius; r <= 6; r++) {
			for (int dy = 2; dy >= -3; dy--) {
				for (int[] d : new int[][] {{r, 0}, {-r, 0}, {0, r}, {0, -r}}) {
					BlockPos p = base.offset(d[0], dy, d[1]);
					if (level.isLoaded(p) && AgentNavigator.isStandable(level, p)) {
						return Vec3.atBottomCenterOf(p);
					}
				}
			}
		}
		return Vec3.atBottomCenterOf(base);
	}

	/** Bodies Node drives follow the local player by default. */
	void adopt(final AgentPlayer agent) {
		if (agent.brain().followTargetId() == null) {
			com.mojang.authlib.GameProfile owner = this.server.getSingleplayerProfile();
			if (owner != null) {
				agent.brain().setFollowTarget(owner.id());
			}
		}
	}

	/** {@code agent.despawn}: dismissed bodies leave for good; at a world end or shutdown they are saved. */
	public Map<String, Object> despawn(final Bodies.AgentDespawn req) {
		AgentService service = AgentService.get(this.server);
		AgentPlayer agent = service.agent(req.agentId().toLowerCase(Locale.ROOT));
		if (agent == null) {
			return Map.of();
		}
		String reason = "dismissed".equals(req.reason()) ? "dismiss" : "world_end";
		this.leaveSeat(agent, reason, false);
		agent.jobs().cancel(req.reason());
		if ("dismissed".equals(req.reason())) {
			service.dismiss(agent);
		} else {
			service.despawn(agent, true);
		}
		return Map.of();
	}

	/** {@code agent.mode}: the idle mode (follow, stay, guard, wander) and its anchor. */
	public Map<String, Object> mode(final Bodies.AgentMode req) {
		AgentPlayer agent = this.agent(req.agentId());
		IdleMode mode = IdleMode.byId(req.mode());
		if (mode == null) {
			throw Refs.badArgs("unknown mode " + req.mode());
		}
		agent.brain().setMode(mode, req.anchor() == null ? null : Refs.pos(req.anchor()));
		if (mode == IdleMode.FOLLOW) {
			this.adopt(agent);
		}
		return Map.of();
	}

	/** {@code agent.approach} (observed; UI code may observe it too). */
	public void approach(final Ui.AgentApproach a) {
		AgentPlayer agent = AgentService.get(this.server).agent(a.agentId().toLowerCase(Locale.ROOT));
		if (agent == null) {
			return;
		}
		ReflexBrain.ApproachRole role = switch (a.role()) {
			case "present" -> ReflexBrain.ApproachRole.PRESENT;
			case "queue" -> ReflexBrain.ApproachRole.QUEUE;
			case "ping" -> ReflexBrain.ApproachRole.PING;
			default -> ReflexBrain.ApproachRole.RELEASE;
		};
		agent.brain().setApproach(role, a.pendingId());
	}

	/** {@code calendar.fired} (observed): assignees whose brain accepted the task walk to its place (reflex 38). */
	public void calendarFired(final Org.CalendarFired fired) {
		if (fired.target() == null) {
			return;
		}
		Identifier dim = Identifier.tryParse(fired.target().dim());
		if (dim == null) {
			return;
		}
		ResourceKey<Level> key = ResourceKey.create(Registries.DIMENSION, dim);
		for (String id : fired.walk()) {
			AgentPlayer agent = AgentService.get(this.server).agent(id.toLowerCase(Locale.ROOT));
			if (agent != null) {
				this.attend(agent, key, Refs.pos(fired.target().pos()), fired.kind(), fired.title());
			}
		}
	}

	/** Sends the agent to a place (a scheduled task's location, the meeting table) at reflex priority 38. */
	public void attend(final AgentPlayer agent, final ResourceKey<Level> dim, final BlockPos pos, final String kind, final String label) {
		agent.brain().setAttend(new ReflexBrain.AttendTarget(dim, pos.immutable(), kind, label, agent.tickCount));
	}

	// ---------------------------------------------------------------- seats

	/** {@code agent.seat}: typed pre-checks, reservation, then the walk-and-sit job (answered {@code running}). */
	public Map<String, Object> seat(final dev.minevibe.bridge.msg.Seats.AgentSeat req) {
		AgentPlayer agent = this.agent(req.agentId());
		SeatTarget target = req.target();
		PcRegistry.Chair chair;
		if (SeatTarget.PC.equals(target.kind())) {
			PcRegistry pcs = Seats.pcs();
			String pcId = target.pcId();
			chair = pcs.chair(this.server, pcId);
			if (chair == null) {
				throw new BridgeException(Codes.PC_UNKNOWN, "no workstation for " + pcId + " in this world");
			}
			String status = pcs.status(pcId);
			if (status != null && !"running".equals(status)) {
				throw new BridgeException(Codes.PC_DOWN, pcId + " is " + status);
			}
			if (this.othersAtPcs(pcs, agent.agentId()) >= Seats.MAX_SEATED) {
				throw new BridgeException(Codes.SEAT_CAP, Seats.MAX_SEATED + " agents already sit at (or hold) PCs");
			}
			Types.Occupant occupant = pcs.occupant(this.server, pcId);
			if (occupant != null && occupant.isPlayer()) {
				throw new BridgeException(Codes.OCCUPIED_BY_PLAYER, "the player sits at " + pcId);
			}
			if (occupant != null && !agent.agentId().equals(occupant.agentId())) {
				throw new BridgeException(Codes.RESERVED, occupant.agentId() + " sits at " + pcId);
			}
			PcRegistry.Reservation r = pcs.reservation(pcId);
			if (r != null && !agent.agentId().equals(r.agentId())) {
				throw new BridgeException(Codes.RESERVED, pcId + " is reserved for " + r.agentId());
			}
			int cooldown = pcs.resitCooldownSeconds(agent.agentId(), pcId);
			if (cooldown > 0) {
				throw new BridgeException(Codes.RESERVED, agent.agentId() + " was kicked off " + pcId + "; it can sit there again in " + cooldown + " s");
			}
			// End the current job (an earlier seat job for this chair, say) before reserving: its end releases its own
			// "coming" reservation, which would otherwise be the one made here.
			agent.jobs().cancel("replaced by sit_at_pc");
			pcs.reserve(pcId, agent.agentId(), PcRegistry.Reservation.COMING);
		} else {
			var meetings = Seats.meetings();
			chair = meetings == null ? null : meetings.chairFor(this.server, target.meetingId(), agent.agentId());
			if (chair == null) {
				throw new BridgeException(Codes.NO_SEAT, "no free chair for meeting " + target.meetingId());
			}
		}
		if (agent.isPassenger() && !(this.seated.containsKey(agent.agentId()))) {
			agent.stopRiding();
		}
		SeatJob job = new SeatJob(target, chair, req.seatEpoch(), req.purpose());
		this.start(agent, req.jobId(), job, 0);
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("jobId", req.jobId());
		out.put("status", Skills.RUNNING);
		return out;
	}

	/**
	 * Agents other than {@code agentId} that sit at a PC or hold one ({@code coming}: walking there; {@code away}: asking
	 * the player, chair kept): Node counts all of them as seated, so {@code maxSeated} counts them too.
	 */
	private int othersAtPcs(final PcRegistry pcs, final String agentId) {
		java.util.Set<String> holders = new java.util.HashSet<>();
		for (Map.Entry<String, Seated> e : this.seated.entrySet()) {
			if (SeatTarget.PC.equals(e.getValue().target().kind())) {
				holders.add(e.getKey());
			}
		}
		for (String pcId : pcs.pcIds(this.server)) {
			PcRegistry.Reservation r = pcs.reservation(pcId);
			if (r != null) {
				holders.add(r.agentId());
			}
		}
		holders.remove(agentId);
		return holders.size();
	}

	/** Once a second: reservations of agents that died or left (an {@code away} chair would otherwise stay held forever). */
	private void sweepReservations() {
		PcRegistry pcs = Seats.pcs();
		AgentService bodies = AgentService.get(this.server);
		for (String pcId : pcs.pcIds(this.server)) {
			PcRegistry.Reservation r = pcs.reservation(pcId);
			if (r != null && bodies.agent(r.agentId()) == null) {
				pcs.release(pcId, r.agentId());
			}
		}
	}

	private void seatEnded(final Handle h, final SeatJob job, final SkillJob.Outcome o) {
		AgentPlayer agent = AgentService.get(this.server).agent(h.agentId);
		String pcId = job.target().pcId();
		if (o.done() && agent != null) {
			Seated previous = this.seated.get(agent.agentId());
			if (previous != null && previous.target().pcId() != null && !previous.target().pcId().equals(pcId)) {
				Seats.pcs().onUnseated(previous.target().pcId(), Types.Occupant.agent(agent.agentId()), "stand", false);
			}
			this.seated.put(agent.agentId(), new Seated(job.target(), job.epoch(), job.chair().dim(), job.chair().pos()));
			if (pcId != null) {
				Seats.pcs().onSeated(pcId, Types.Occupant.agent(agent.agentId()), job.epoch());
			}
		} else if (pcId != null) {
			PcRegistry.Reservation r = Seats.pcs().reservation(pcId);
			if (r != null && r.agentId().equals(h.agentId) && PcRegistry.Reservation.COMING.equals(r.kind())) {
				Seats.pcs().release(pcId, h.agentId);
			}
		}
	}

	/** {@code agent.unseat}: stand up (stale epochs are ignored), optionally keeping the chair reserved ({@code away}). */
	public Map<String, Object> unseat(final dev.minevibe.bridge.msg.Seats.AgentUnseat req) {
		AgentPlayer agent = this.agent(req.agentId());
		Seated s = this.seated.get(agent.agentId());
		if (s != null && req.seatEpoch() < s.epoch()) {
			return Map.of("ignored", true);
		}
		if (agent.jobs().current() instanceof SeatJob walking && req.seatEpoch() < walking.epoch()) {
			// A late unseat from before the walk to a (newer) seat began.
			return Map.of("ignored", true);
		}
		if (agent.jobs().current() instanceof SeatJob) {
			agent.jobs().cancel("unseat: " + req.reason());
		}
		if (s == null) {
			// Not sitting: only drop a kept reservation if asked to.
			if (!req.keepReservation()) {
				for (String pcId : Seats.pcs().pcIds(this.server)) {
					Seats.pcs().release(pcId, agent.agentId());
				}
			}
			if (agent.getVehicle() instanceof dev.minevibe.world.seat.SeatEntity) {
				agent.stopRiding();
			}
			return Map.of();
		}
		this.leaveSeat(agent, req.reason(), req.keepReservation());
		return Map.of();
	}

	/** Stands the agent up from its tracked seat and reports it ({@code pc.unseat}). */
	void leaveSeat(final AgentPlayer agent, final String reason, final boolean keepReservation) {
		Seated s = this.seated.remove(agent.agentId());
		if (agent.getVehicle() instanceof dev.minevibe.world.seat.SeatEntity) {
			agent.brain().noteStand(reason);
			agent.stopRiding();
			if ("kick".equals(reason) && s != null && agent.level().dimension() == s.dim()) {
				// Node's kick (the Kick buttons): off the chair the player is about to take, like the mod's own kick.
				Seats.stepAside(agent.level(), s.chair(), agent);
			}
		}
		if (s == null || s.target().pcId() == null) {
			return;
		}
		String pcId = s.target().pcId();
		PcRegistry pcs = Seats.pcs();
		if (keepReservation) {
			pcs.reserve(pcId, agent.agentId(), PcRegistry.Reservation.AWAY);
		} else {
			pcs.release(pcId, agent.agentId());
		}
		pcs.onUnseated(pcId, Types.Occupant.agent(agent.agentId()), reason, keepReservation);
	}

	/** Every tick: notices agents that left their chair without {@code agent.unseat} (reflex, kick, death). */
	private void checkSeats() {
		if (this.seated.isEmpty()) {
			return;
		}
		AgentService bodies = AgentService.get(this.server);
		for (Map.Entry<String, Seated> e : List.copyOf(this.seated.entrySet())) {
			AgentPlayer agent = bodies.agent(e.getKey());
			Seated s = e.getValue();
			boolean onChair = agent != null && agent.getVehicle() instanceof dev.minevibe.world.seat.SeatEntity seat
				&& s.chair().equals(seat.chairPos()) && agent.level().dimension() == s.dim();
			if (onChair) {
				continue;
			}
			this.seated.remove(e.getKey());
			String reason = agent == null ? "death" : java.util.Objects.requireNonNullElse(agent.brain().lastStandReason(40), "stand");
			if (s.target().pcId() != null) {
				Seats.pcs().release(s.target().pcId(), e.getKey());
				Seats.pcs().onUnseated(s.target().pcId(), Types.Occupant.agent(e.getKey()), reason, false);
			}
			if (agent != null) {
				int urgency = "survival".equals(reason) || "damage".equals(reason) || "kick".equals(reason) ? BodyEvents.CRITICAL : BodyEvents.NOTABLE;
				String kind = "kick".equals(reason) ? "kicked" : "unseated";
				Map<String, Object> data = new LinkedHashMap<>();
				data.put("reason", reason);
				data.put("seat", s.target().pcId() != null ? s.target().pcId() : s.target().meetingId());
				BodyEvents.emit(agent, kind, urgency, "left the chair (" + reason + ")", data, 0);
			}
		}
	}

	// ---------------------------------------------------------------- debug (E2E)

	public Map<String, Object> debugKillAgent(final dev.minevibe.bridge.msg.Debug.DebugKillAgent req) {
		AgentPlayer agent = this.agent(req.agentId());
		agent.kill(agent.level());
		return Map.of();
	}

	public Map<String, Object> debugSetClock(final dev.minevibe.bridge.msg.Debug.DebugSetClock req) {
		this.server.clockManager().setTotalTicks(this.server.registryAccess().lookupOrThrow(Registries.WORLD_CLOCK).getOrThrow(WorldClocks.OVERWORLD), req.clockTime());
		WorldClock.publish(this.server);
		return Map.of();
	}

	// ---------------------------------------------------------------- tick

	/** Server thread, end of every tick. */
	void tick() {
		long now = System.nanoTime();
		for (Handle h : List.copyOf(this.running.values())) {
			CompletableFuture<Map<String, Object>> reply = h.reply;
			if (reply != null && !reply.isDone() && now >= h.deadlineNanos) {
				reply.complete(runningReply(h));
			}
			if (h.job.progressVersion() != h.progressVersion && now - h.progressSentNanos >= PROGRESS_INTERVAL_NANOS && !h.job.progressText().isEmpty()) {
				h.progressVersion = h.job.progressVersion();
				h.progressSentNanos = now;
				this.outbox.send(Skills.SKILL_PROGRESS, new Skills.SkillProgress(h.jobId, h.agentId, h.job.progress(), ProtocolCodec.clip(h.job.progressText(), 256)));
			}
		}
		this.checkSeats();
		this.emitter.tick();
		if (this.server.getTickCount() % 20 == 0) {
			WorldClock.publish(this.server);
			this.sweepReservations();
		}
	}

	static Messages.BlockPos wire(final BlockPos p) {
		return Refs.wire(p);
	}
}
