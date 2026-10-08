package dev.minevibe.agent;

import com.google.common.collect.ImmutableMultimap;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import com.mojang.authlib.properties.PropertyMap;
import dev.minevibe.MineVibeMod;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.grave.GraveBlock;
import dev.minevibe.world.grave.GraveBlockEntity;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ServerboundPlayerLoadedPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerScoreboard;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ParticleStatus;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.players.NameAndId;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.ChatVisiblity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.EnchantmentEffectComponents;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.StandingSignBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.RotationSegment;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.scores.PlayerTeam;
import net.minecraft.world.scores.Team;
import org.jspecify.annotations.Nullable;

/**
 * Spawns, restores, removes and buries agent bodies (PLAN 7.1). One instance per running server.
 *
 * <ul>
 *   <li><b>Identity.</b> An agent id ({@code ada}) maps to a stable offline UUID,
 *       {@code UUID.nameUUIDFromBytes("mv-agent:" + id)}. The game profile carries the role in a
 *       {@value #ROLE_PROPERTY} property; the client uses it to pick the role skin.</li>
 *   <li><b>Persistence.</b> Bodies are ordinary playerdata ({@code players/data/<uuid>.dat}); the crew
 *       list is {@code minevibe/agents.json}. Living agents are restored when the world loads.</li>
 *   <li><b>Team.</b> All agents are on team {@value #TEAM} with {@code CollisionRule.NEVER}.</li>
 *   <li><b>Friendly fire.</b> Player to agent and agent to agent damage is cancelled
 *       ({@code ServerLivingEntityEvents.ALLOW_DAMAGE}); so is agent to player, as a hardcore safety net.</li>
 *   <li><b>Death.</b> Inventory goes into a {@code minevibe:grave} with a sign ("Name / Role / Day N"),
 *       vanilla prints the death message, and the next tick the body is removed and its playerdata
 *       deleted. Agents never respawn.</li>
 * </ul>
 */
public final class AgentService {
	public static final String TEAM = "mv_agents";
	public static final String ROLE_PROPERTY = "minevibe:role";
	private static final Pattern ID = Pattern.compile("[a-z][a-z0-9_]{0,15}");
	private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{1,16}");

	private static @Nullable AgentService current;

	private final MinecraftServer server;
	private final AgentRegistry registry;
	private final Map<String, AgentPlayer> agents = new LinkedHashMap<>();
	private final Map<String, BlockPos> graves = new HashMap<>();
	private final List<Pending> pending = new ArrayList<>();

	/** A task for a later server tick (death removal happens on the tick after death). */
	private record Pending(int runAtTick, Runnable task) {
	}

	private AgentService(final MinecraftServer server) {
		this.server = server;
		this.registry = AgentRegistry.load(server);
	}

	public static synchronized AgentService get(final MinecraftServer server) {
		AgentService service = current;
		if (service == null || service.server != server) {
			service = new AgentService(server);
			current = service;
		}
		return service;
	}

	static void registerEvents() {
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			AgentService service = get(server);
			// A crash between an agent's death and its removal leaves its playerdata behind; it must never load.
			service.sweepDeadPlayerFiles();
			// GameTest worlds are scratch worlds; leftovers from an earlier run must not come back.
			if (System.getProperty("fabric-api.gametest") == null) {
				service.restoreAll();
			}
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			AgentService service = current;
			if (service != null && service.server == server) {
				// A death in the last tick before the stop: remove the body now, before the server saves every
				// player (it would write the dead agent's playerdata, stats and advancements back).
				service.runAllPending();
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			synchronized (AgentService.class) {
				if (current != null && current.server == server) {
					current.sweepDeadPlayerFiles();
					current = null;
				}
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			AgentService service = current;
			if (service != null && service.server == server) {
				service.runPending();
			}
		});
		ServerLivingEntityEvents.ALLOW_DAMAGE.register(AgentService::allowDamage);
	}

	// ---------------------------------------------------------------- identity

	public static UUID uuidFor(final String agentId) {
		return UUID.nameUUIDFromBytes(("mv-agent:" + agentId).getBytes(StandardCharsets.UTF_8));
	}

	public static String idFromName(final String name) {
		return name.toLowerCase(java.util.Locale.ROOT);
	}

	/** Role from a game profile's {@value #ROLE_PROPERTY} property, or null when it is not an agent profile. */
	public static @Nullable AgentRole roleOf(final GameProfile profile) {
		for (Property property : profile.properties().get(ROLE_PROPERTY)) {
			return AgentRole.byId(property.value());
		}
		return null;
	}

	private static ClientInformation clientInformation() {
		// View distance 2 keeps the chunks an agent "watches" (and sends nothing to) small.
		return new ClientInformation("en_us", 2, ChatVisiblity.HIDDEN, false, 0x7F, HumanoidArm.RIGHT, false, false, ParticleStatus.MINIMAL);
	}

	// ---------------------------------------------------------------- queries

	/** The living body of {@code agentId}; never a dead one that is still waiting to be removed. */
	public @Nullable AgentPlayer agent(final String agentId) {
		AgentPlayer agent = this.agents.get(agentId);
		return agent != null && !agent.isRemoved() && !agent.isAgentDead() ? agent : null;
	}

	public @Nullable AgentPlayer agentByName(final String name) {
		for (AgentPlayer agent : this.agents.values()) {
			if (agent.getGameProfile().name().equalsIgnoreCase(name)) {
				return agent;
			}
		}
		return null;
	}

	public Collection<AgentPlayer> agents() {
		return List.copyOf(this.agents.values());
	}

	public boolean isDead(final String agentId) {
		AgentRegistry.Entry entry = this.registry.get(agentId);
		return entry != null && !entry.alive();
	}

	public boolean isKnown(final String agentId) {
		return this.registry.get(agentId) != null;
	}

	/** Where the agent's grave was placed when it died in this session, or null. */
	public @Nullable BlockPos gravePos(final String agentId) {
		return this.graves.get(agentId);
	}

	// ---------------------------------------------------------------- spawn / restore

	/**
	 * Spawns (or restores from playerdata) the agent {@code agentId}. When playerdata exists, the saved
	 * dimension, position, health, food and inventory win over {@code level}/{@code pos}.
	 *
	 * @throws IllegalArgumentException for an invalid id or name
	 * @throws IllegalStateException when the agent is dead or the name/UUID is taken by someone else
	 */
	@SuppressWarnings("deprecation") // ValueInput#read(MapCodec): vanilla's PrepareSpawnTask reads SavedPosition the same way
	public AgentPlayer spawn(final String agentId, final String name, final AgentRole role, final ServerLevel level, final Vec3 pos, final float yaw) {
		if (!ID.matcher(agentId).matches()) {
			throw new IllegalArgumentException("Invalid agent id: " + agentId);
		}
		if (!NAME.matcher(name).matches()) {
			throw new IllegalArgumentException("Invalid agent name: " + name);
		}
		AgentPlayer existing = this.agent(agentId);
		if (existing != null) {
			return existing;
		}
		if (this.isDead(agentId)) {
			throw new IllegalStateException(name + " is dead; agents never respawn");
		}
		UUID uuid = uuidFor(agentId);
		if (this.server.getPlayerList().getPlayer(uuid) != null) {
			throw new IllegalStateException("UUID of " + agentId + " is already online");
		}
		ServerPlayer clash = this.server.getPlayerList().getPlayerByName(name);
		if (clash != null) {
			throw new IllegalStateException("Name " + name + " is already taken by " + clash.getStringUUID());
		}

		GameProfile profile = new GameProfile(uuid, name, new PropertyMap(ImmutableMultimap.of(ROLE_PROPERTY, new Property(ROLE_PROPERTY, role.id()))));
		Optional<CompoundTag> data = this.server.getPlayerList().loadPlayerData(new NameAndId(uuid, name));

		AgentPlayer agent;
		try (ProblemReporter.ScopedCollector reporter = new ProblemReporter.ScopedCollector(MineVibeMod.LOGGER)) {
			Optional<ValueInput> input = data.map(tag -> TagValueInput.create(reporter, this.server.registryAccess(), tag));
			ServerLevel spawnLevel = level;
			Vec3 spawnPos = pos;
			float spawnYaw = yaw;
			float spawnPitch = 0.0F;
			if (input.isPresent()) {
				ServerPlayer.SavedPosition saved = input.get().read(ServerPlayer.SavedPosition.MAP_CODEC).orElse(ServerPlayer.SavedPosition.EMPTY);
				ServerLevel savedLevel = saved.dimension().map(this.server::getLevel).orElse(null);
				if (savedLevel != null) {
					spawnLevel = savedLevel;
				}
				if (saved.position().isPresent()) {
					spawnPos = saved.position().get();
				}
				if (saved.rotation().isPresent()) {
					Vec2 rot = saved.rotation().get();
					spawnYaw = rot.x;
					spawnPitch = rot.y;
				}
			}
			// Load the destination chunk now (vanilla's login waits for it too), so the body lands on terrain.
			spawnLevel.getChunk(SectionPos.blockToSectionCoord(spawnPos.x), SectionPos.blockToSectionCoord(spawnPos.z));
			agent = new AgentPlayer(this.server, spawnLevel, profile, clientInformation(), agentId, role);
			input.ifPresent(agent::load);
			agent.snapTo(spawnPos, spawnYaw, spawnPitch);
			CommonListenerCookie cookie = new CommonListenerCookie(profile, 0, agent.clientInformation(), false);
			this.server.getPlayerList().placeNewPlayer(new AgentConnection(), agent, cookie);
		}
		// No client will ever send "loaded": mark it now, or the agent is invulnerable for 60 ticks.
		agent.connection.handleAcceptPlayerLoad(new ServerboundPlayerLoadedPacket());
		agent.setGameMode(GameType.SURVIVAL);
		ServerScoreboard scoreboard = this.server.getScoreboard();
		scoreboard.addPlayerToTeam(name, this.ensureTeam());

		this.agents.put(agentId, agent);
		this.registry.put(new AgentRegistry.Entry(agentId, name, role.id(), true, 0));
		this.registry.save();
		AgentEvents.emit(agent, data.isPresent() ? "restored" : "spawned", Map.of("name", name, "role", role.id(), "pos", agent.position().toString()));
		return agent;
	}

	/** Restores every living agent in the crew list (called when the world has loaded). */
	public void restoreAll() {
		ServerLevel overworld = this.server.overworld();
		Vec3 fallback = Vec3.atBottomCenterOf(this.server.getWorldData().overworldData().getRespawnData().pos());
		for (AgentRegistry.Entry entry : List.copyOf(this.registry.all())) {
			if (!entry.alive() || this.agent(entry.id()) != null) {
				continue;
			}
			AgentRole role = AgentRole.byId(entry.role());
			try {
				this.spawn(entry.id(), entry.name(), role == null ? AgentRole.ENGINEER : role, overworld, fallback, 0.0F);
			} catch (RuntimeException e) {
				MineVibeMod.LOGGER.warn("Could not restore agent {}", entry.id(), e);
			}
		}
	}

	public PlayerTeam ensureTeam() {
		ServerScoreboard scoreboard = this.server.getScoreboard();
		PlayerTeam team = scoreboard.getPlayerTeam(TEAM);
		if (team == null) {
			team = scoreboard.addPlayerTeam(TEAM);
		}
		if (team.getCollisionRule() != Team.CollisionRule.NEVER) {
			team.setCollisionRule(Team.CollisionRule.NEVER);
		}
		if (team.isAllowFriendlyFire()) {
			team.setAllowFriendlyFire(false);
		}
		return team;
	}

	private void leaveTeam(final String name) {
		PlayerTeam team = this.server.getScoreboard().getPlayerTeam(TEAM);
		if (team != null && team.getPlayers().contains(name)) {
			this.server.getScoreboard().removePlayerFromTeam(name, team);
		}
	}

	// ---------------------------------------------------------------- removal

	/**
	 * Removes the body from the world. With {@code keepAlive} the agent stays in the crew list and its
	 * playerdata is kept, so it comes back on the next world load.
	 */
	public void despawn(final AgentPlayer agent, final boolean keepAlive) {
		this.removeBody(agent);
		if (!keepAlive) {
			this.leaveTeam(agent.getGameProfile().name());
			this.deletePlayerFiles(agent.getUUID());
			this.registry.remove(agent.agentId());
			this.registry.save();
		}
	}

	/** Removes the agent for good: body, playerdata and crew entry (used by tests and "dismiss"). */
	public void dismiss(final AgentPlayer agent) {
		this.despawn(agent, false);
	}

	private void removeBody(final AgentPlayer agent) {
		if (this.agents.get(agent.agentId()) == agent) {
			this.agents.remove(agent.agentId());
		}
		if (agent.hasDisconnected()) {
			return;
		}
		agent.jobs().cancel();
		agent.navigator().stop();
		agent.controls().releaseAll();
		// Quiet version of ServerGamePacketListenerImpl.removePlayerFromWorld (no "left the game" line).
		agent.disconnect();
		this.server.getPlayerList().remove(agent);
		agent.getTextFilter().leave();
		this.server.invalidateStatus();
	}

	private void deletePlayerFiles(final UUID uuid) {
		String id = uuid.toString();
		List<Path> files = List.of(
			this.server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(id + ".dat"),
			this.server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(id + ".dat_old"),
			this.server.getWorldPath(LevelResource.PLAYER_STATS_DIR).resolve(id + ".json"),
			this.server.getWorldPath(LevelResource.PLAYER_ADVANCEMENTS_DIR).resolve(id + ".json")
		);
		for (Path file : files) {
			try {
				Files.deleteIfExists(file);
			} catch (IOException e) {
				MineVibeMod.LOGGER.warn("Could not delete {}", file, e);
			}
		}
	}

	public static Path playerDataFile(final MinecraftServer server, final UUID uuid) {
		return server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(uuid + ".dat");
	}

	/** Runs every pending task now, due or not (the server is stopping: there is no next tick). */
	public void runAllPending() {
		List<Pending> all = List.copyOf(this.pending);
		this.pending.clear();
		for (Pending p : all) {
			p.task().run();
		}
	}

	/** Deletes the playerdata, stats and advancements of every agent the crew list marks dead. Idempotent. */
	public void sweepDeadPlayerFiles() {
		for (AgentRegistry.Entry entry : this.registry.all()) {
			if (!entry.alive()) {
				this.deletePlayerFiles(uuidFor(entry.id()));
			}
		}
	}

	private void runPending() {
		if (this.pending.isEmpty()) {
			return;
		}
		int now = this.server.getTickCount();
		List<Pending> due = new ArrayList<>();
		this.pending.removeIf(p -> {
			if (p.runAtTick() <= now) {
				due.add(p);
				return true;
			}
			return false;
		});
		for (Pending p : due) {
			p.task().run();
		}
	}

	// ---------------------------------------------------------------- death

	/** Moves the agent's inventory into a grave at (or near) its feet. Called from {@link AgentPlayer#die}. */
	void buryInGrave(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos pos = findGravePos(level, agent.blockPosition());
		if (pos == null) {
			MineVibeMod.LOGGER.info("No room for {}'s grave at {}; items drop instead", agent.agentId(), agent.blockPosition());
			return;
		}
		Inventory inventory = agent.getInventory();
		List<ItemStack> stacks = new ArrayList<>();
		for (int i = 0; i < inventory.getContainerSize(); i++) {
			ItemStack stack = inventory.getItem(i);
			if (!stack.isEmpty() && !EnchantmentHelper.has(stack, EnchantmentEffectComponents.PREVENT_EQUIPMENT_DROP)) {
				stacks.add(stack);
				inventory.setItem(i, ItemStack.EMPTY);
			}
		}
		Direction facing = agent.getDirection().getOpposite();
		level.setBlock(pos, MvWorldContent.GRAVE.defaultBlockState().setValue(GraveBlock.FACING, facing), 3);
		int day = (int)(level.getOverworldClockTime() / 24000L) + 1;
		String name = agent.getGameProfile().name();
		String role = agent.role().displayName();
		if (level.getBlockEntity(pos) instanceof GraveBlockEntity grave) {
			grave.fill(agent.agentId(), name, role, day, stacks);
		}
		BlockPos signPos = pos.above();
		if (level.getBlockState(signPos).isAir()) {
			BlockState sign = Blocks.OAK_SIGN.defaultBlockState().setValue(StandingSignBlock.ROTATION, RotationSegment.convertToSegment(facing.toYRot()));
			level.setBlock(signPos, sign, 3);
			if (level.getBlockEntity(signPos) instanceof SignBlockEntity signEntity) {
				List<Component> lines = List.of(Component.literal(name), Component.literal(role), Component.literal("Day " + day), Component.empty());
				signEntity.setText(new SignText(lines, lines, net.minecraft.world.item.DyeColor.BLACK, false), SignTextSlot.FRONT);
				signEntity.setWaxed(true);
			}
		}
		this.graves.put(agent.agentId(), pos.immutable());
	}

	/** First replaceable block at the feet or up to 4 above, then within 3 blocks around. */
	public static @Nullable BlockPos findGravePos(final ServerLevel level, final BlockPos feet) {
		if (feet.getY() < level.getMinY()) {
			return null;
		}
		BlockPos start = new BlockPos(feet.getX(), Math.min(feet.getY(), level.getMaxY() - 2), feet.getZ());
		for (int dy = 0; dy <= 4; dy++) {
			BlockPos p = start.above(dy);
			if (canHoldGrave(level, p)) {
				return p;
			}
		}
		for (int r = 1; r <= 3; r++) {
			for (BlockPos p : BlockPos.betweenClosed(start.offset(-r, -1, -r), start.offset(r, 1, r))) {
				if (canHoldGrave(level, p)) {
					return p.immutable();
				}
			}
		}
		return null;
	}

	/**
	 * Air, a replaceable block (grass, snow, fire, a fluid) or a pure fluid block. Not "any block holding a fluid":
	 * waterlogged stairs, slabs or fences are real blocks, and {@code setBlock} would delete them without drops.
	 */
	static boolean canHoldGrave(final ServerLevel level, final BlockPos p) {
		if (p.getY() <= level.getMinY() || p.getY() >= level.getMaxY()) {
			return false;
		}
		BlockState state = level.getBlockState(p);
		if (state.hasBlockEntity()) {
			return false;
		}
		return state.isAir() || state.canBeReplaced() || state.getBlock() instanceof LiquidBlock || state.is(BlockTags.FIRE);
	}

	/** Called at the end of {@link AgentPlayer#die}. The body leaves the world on the next tick. */
	void onAgentDied(final AgentPlayer agent, final DamageSource source, final Component deathMessage) {
		String name = agent.getGameProfile().name();
		int day = (int)(agent.level().getOverworldClockTime() / 24000L) + 1;
		this.registry.put(new AgentRegistry.Entry(agent.agentId(), name, agent.role().id(), false, day));
		this.registry.save();
		this.leaveTeam(name);
		BlockPos grave = this.graves.get(agent.agentId());
		AgentEvents.emit(
			agent,
			"died",
			Map.of(
				"cause", deathMessage.getString(),
				"grave", grave == null ? "" : grave.toShortString(),
				"day", Integer.toString(day)
			)
		);
		// Disconnect on the next tick, not in the middle of the damage/tick that killed it.
		this.pending.add(new Pending(this.server.getTickCount() + 1, () -> {
			this.removeBody(agent);
			this.deletePlayerFiles(agent.getUUID());
		}));
	}

	// ---------------------------------------------------------------- friendly fire

	static boolean allowDamage(final LivingEntity victim, final DamageSource source, final float amount) {
		Entity attacker = source.getEntity();
		if (!(attacker instanceof Player)) {
			return true;
		}
		if (victim instanceof AgentPlayer) {
			// Player -> agent and agent -> agent.
			return false;
		}
		// Agent -> player: never in hardcore (sweeps, stray arrows).
		return !(attacker instanceof AgentPlayer && victim instanceof Player);
	}
}
