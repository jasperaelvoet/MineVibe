/*
 * Adapted from fabric-carpet (https://github.com/gnembon/fabric-carpet),
 * carpet.patches.EntityPlayerMPFake. Copyright (c) gnembon and contributors. MIT License.
 * Modified for MineVibe (Minecraft 26.3): ticks the agent's controls, brain, jobs and navigator; death
 * buries the inventory in a grave and the agent never respawns.
 */
package dev.minevibe.agent;

import com.mojang.authlib.GameProfile;
import dev.minevibe.agent.brain.ReflexBrain;
import dev.minevibe.agent.job.JobRunner;
import dev.minevibe.agent.nav.AgentNavigator;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;

/**
 * An agent's body: a server-side fake {@link ServerPlayer} with real health, hunger, inventory, menus
 * and riding (PLAN 7.1). Spawn and remove agents only through {@link AgentService}.
 *
 * <p>Tick order: brain (reflexes and jobs choose intentions) -> navigator (path following) -> controls
 * (apply input) -> {@code ServerPlayer.tick()} -> {@code doTick()} (player physics, which a real client
 * would otherwise drive through movement packets).
 *
 * <p>Agents are server-authoritative ({@link #isClientAuthoritative()} is false), like vanilla's GameTest
 * mock players: the server simulates their movement and fall damage.
 */
public class AgentPlayer extends ServerPlayer {
	private final String agentId;
	private final AgentRole role;
	private final AgentControls controls;
	private final AgentNavigator navigator;
	private final JobRunner jobs;
	private final ReflexBrain brain;
	private boolean agentDead;

	// Tick cost (S1 perf numbers).
	private long tickNanosTotal;
	private long tickNanosMax;
	private int tickSamples;

	public AgentPlayer(
		final MinecraftServer server,
		final ServerLevel level,
		final GameProfile profile,
		final ClientInformation clientInformation,
		final String agentId,
		final AgentRole role
	) {
		super(server, level, profile, clientInformation);
		this.agentId = agentId;
		this.role = role;
		this.controls = new AgentControls(this);
		this.navigator = new AgentNavigator(this);
		this.jobs = new JobRunner(this);
		this.brain = new ReflexBrain(this);
	}

	public String agentId() {
		return this.agentId;
	}

	public AgentRole role() {
		return this.role;
	}

	public AgentControls controls() {
		return this.controls;
	}

	public AgentNavigator navigator() {
		return this.navigator;
	}

	public JobRunner jobs() {
		return this.jobs;
	}

	public ReflexBrain brain() {
		return this.brain;
	}

	/** True from the moment of death until the agent is removed (next tick). Agents never respawn. */
	public boolean isAgentDead() {
		return this.agentDead;
	}

	@Override
	public void tick() {
		long t0 = System.nanoTime();
		if (this.level().getServer().getTickCount() % 10 == 0) {
			this.connection.resetPosition();
			this.level().getChunkSource().move(this);
		}
		if (this.touchingUnloadedChunk()) {
			// Never simulate physics over unloaded terrain (it would fall through the world). The agent's
			// own player ticket loads the chunk shortly; until then it only does bookkeeping.
			this.controls.stopMovement();
			super.tick();
		} else {
			if (!this.agentDead && this.isAlive()) {
				this.brain.tick();
				this.navigator.tick();
			}
			this.controls.onUpdate();
			super.tick();
			this.doTick();
		}
		long dt = System.nanoTime() - t0;
		this.tickNanosTotal += dt;
		this.tickSamples++;
		if (dt > this.tickNanosMax) {
			this.tickNanosMax = dt;
		}
	}

	/** Average cost of {@link #tick()} in milliseconds since the last {@link #resetTickStats()}. */
	public double avgTickMillis() {
		return this.tickSamples == 0 ? 0.0 : this.tickNanosTotal / 1.0E6 / this.tickSamples;
	}

	public double maxTickMillis() {
		return this.tickNanosMax / 1.0E6;
	}

	public int tickSamples() {
		return this.tickSamples;
	}

	public void resetTickStats() {
		this.tickNanosTotal = 0L;
		this.tickNanosMax = 0L;
		this.tickSamples = 0;
	}

	@Override
	public boolean isClientAuthoritative() {
		return false;
	}

	@Override
	public boolean allowsListing() {
		return false;
	}

	@Override
	public String getIpAddress() {
		return "127.0.0.1";
	}

	@Override
	public void die(final DamageSource source) {
		if (this.agentDead) {
			return;
		}
		this.agentDead = true;
		this.jobs.cancel();
		this.navigator.stop();
		this.controls.releaseAll();
		if (this.isPassenger()) {
			this.stopRiding();
		}
		AgentService service = AgentService.get(this.level().getServer());
		Component deathMessage = this.getCombatTracker().getDeathMessage();
		// Inventory into a grave first, so vanilla's death drops find nothing to scatter.
		service.buryInGrave(this);
		// Vanilla death message, stats, XP drop and Fabric's AFTER_DEATH event.
		super.die(source);
		service.onAgentDied(this, source, deathMessage);
	}
}
