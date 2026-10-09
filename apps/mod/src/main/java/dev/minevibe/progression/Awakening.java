package dev.minevibe.progression;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.protocol.Messages;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Prediction;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The awakening ritual (PLAN 7.5 "Agent Core"): the player uses an Agent Core on the top of two stacked copper blocks
 * (any {@code #minecraft:copper} block: plain, exposed, weathered, oxidized, waxed or not; never cut copper), and a CEO
 * wakes up where they stood. Server thread.
 *
 * <ol>
 *   <li><b>Aside.</b> Both blocks and the core (not in creative mode) are taken at once, so the CEO's body has room
 *       where the stack stood, and the ritual cannot be repeated with the same core while Node decides.</li>
 *   <li><b>Ask.</b> {@code agent.awaken{pos, dim, by}} goes to Node ({@code pos}: the lower block). Node hires the CEO
 *       there ({@code agent.spawn{at}}) and answers {@code ok}, or refuses: a living CEO already hires the crew, no
 *       usable brains, no world.</li>
 *   <li><b>Done.</b> On {@code ok}: a visual-only lightning bolt, sparks and a chime, the "It's alive!" advancement, and
 *       the core stays spent. On any refusal, a timeout ({@value #TIMEOUT_SECONDS} s) or no bridge at all: the blocks
 *       go back (or drop, if something took their place) and so does the core, with Node's reason.</li>
 * </ol>
 * One ritual per player at a time. A ritual still waiting when the server stops is settled as refused right then
 * (blocks and core back before the world and the players are saved): a reply that comes later finds nothing to do, and
 * nothing is lost with the world.
 */
public final class Awakening {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Awakening");

	/**
	 * How long the mod waits for Node: longer than Node's own worst case ({@code agent.spawn} times out after 10 s, then
	 * the CEO's record and session start), so a late {@code ok} never meets copper and a core already given back.
	 */
	public static final int TIMEOUT_SECONDS = 30;

	/** Sends {@code agent.awaken}; GameTests install their own ({@link #setRequester}). */
	public interface Requester {
		CompletableFuture<JsonObject> awaken(Bodies.AgentAwaken request);
	}

	/** Local code: the game runs without a bridge (GameTests, a bare client). */
	public static final String OFFLINE = "OFFLINE";

	private static final Requester BRIDGE = request -> {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			return CompletableFuture.failedFuture(new BridgeException(OFFLINE, "MineVibe is not connected"));
		}
		return bridge.request(Bodies.AGENT_AWAKEN, request, Duration.ofSeconds(TIMEOUT_SECONDS));
	};

	private static volatile Requester requester = BRIDGE;
	/** Rituals waiting for Node, by player (one at a time each). Server thread. */
	private static final Map<UUID, Ritual> PENDING = new HashMap<>();

	/** What a waiting ritual took aside, to give back or keep. */
	private record Ritual(ResourceKey<Level> dim, BlockPos base, BlockState lower, BlockState upper, UUID player, ItemStack core) {}

	private Awakening() {
	}

	/** GameTests: who answers {@code agent.awaken} (null: the bridge again). */
	public static void setRequester(final @Nullable Requester r) {
		requester = r != null ? r : BRIDGE;
	}

	/** Whether {@code top} and the block under it are both copper blocks (the altar). */
	public static boolean isAltar(final BlockGetter level, final BlockPos top) {
		return level.getBlockState(top).is(BlockTags.COPPER) && level.getBlockState(top.below()).is(BlockTags.COPPER);
	}

	/** Whether {@code player}'s ritual is waiting for Node. */
	public static boolean pending(final UUID player) {
		return PENDING.containsKey(player);
	}

	/** Settles every waiting ritual as refused when the server stops (see the class comment). */
	public static void registerEvents() {
		ServerLifecycleEvents.SERVER_STOPPING.register(Awakening::settleAll);
	}

	/** Gives back what every waiting ritual took (the server is stopping; Node's answers would come too late). */
	static void settleAll(final MinecraftServer server) {
		for (UUID player : new ArrayList<>(PENDING.keySet())) {
			settle(server, player);
		}
	}

	/** Settles {@code player}'s waiting ritual as refused (as the server stop does); a later answer finds nothing. GameTests. */
	public static void settle(final MinecraftServer server, final UUID player) {
		Ritual r = PENDING.remove(player);
		if (r != null) {
			LOG.info("The awakening at {} was still waiting when the server stopped: giving everything back", r.base().toShortString());
			refund(server, r);
		}
	}

	/**
	 * Starts the ritual on the copper stack whose lower block is {@code base}; {@code held} is the core in the player's
	 * hand. False when it cannot start (one is already waiting).
	 */
	public static boolean begin(final ServerLevel level, final BlockPos base, final ServerPlayer player, final ItemStack held) {
		UUID uuid = player.getUUID();
		if (PENDING.containsKey(uuid)) {
			player.sendOverlayMessage(Component.translatable("message.minevibe.awaken.busy"));
			return false;
		}
		BlockState lower = level.getBlockState(base);
		BlockState upper = level.getBlockState(base.above());
		ItemStack core = player.hasInfiniteMaterials() ? ItemStack.EMPTY : held.split(1);
		level.setBlock(base.above(), Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
		level.setBlock(base, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
		Vec3 center = Vec3.atBottomCenterOf(base);
		level.sendParticles(ParticleTypes.ELECTRIC_SPARK, center.x, center.y + 1.0, center.z, 30, 0.35, 0.7, 0.35, 0.05);
		level.playSound(null, base, SoundEvents.AMETHYST_BLOCK_RESONATE, SoundSource.BLOCKS, 1.0F, 0.8F);
		player.sendOverlayMessage(Component.translatable("message.minevibe.awaken.waking"));
		MinecraftServer server = level.getServer();
		ResourceKey<Level> dim = level.dimension();
		Ritual ritual = new Ritual(dim, base.immutable(), lower, upper, uuid, core);
		PENDING.put(uuid, ritual);

		Bodies.AgentAwaken request = new Bodies.AgentAwaken(
			new Messages.BlockPos(base.getX(), base.getY(), base.getZ()), dim.identifier().toString(), player.getGameProfile().name());
		CompletableFuture<JsonObject> reply;
		try {
			reply = requester.awaken(request);
		} catch (RuntimeException e) {
			reply = CompletableFuture.failedFuture(e);
		}
		reply.whenComplete((ok, err) -> server.execute(() -> finish(server, ritual, ok, err)));
		return true;
	}

	/** Node answered (or the request failed): keep what the ritual took, or give it back. Once per ritual. */
	static void finish(final MinecraftServer server, final Ritual ritual, final @Nullable JsonObject ok, final @Nullable Throwable err) {
		if (!PENDING.remove(ritual.player(), ritual)) {
			// Settled already (the server stopped meanwhile).
			return;
		}
		BlockPos base = ritual.base();
		if (err == null) {
			// The CEO is awake: the core and the copper stay spent (even if the dimension is gone, Node hired them).
			ServerLevel level = server.getLevel(ritual.dim());
			ServerPlayer player = server.getPlayerList().getPlayer(ritual.player());
			String name = ok != null && ok.has("name") ? ok.get("name").getAsString() : "Your CEO";
			LOG.info("{} awakened at {}", name, base.toShortString());
			if (level != null) {
				strike(level, base);
			}
			if (player != null) {
				ProgressionContent.AWAKENED_AGENT.trigger(player);
				player.sendSystemMessage(Component.translatable("message.minevibe.awaken.done", name).withStyle(ChatFormatting.AQUA));
			}
			return;
		}
		BridgeException refusal = BridgeClient.unwrap(err);
		String code = refusal != null ? refusal.code() : "INTERNAL";
		LOG.info("The awakening at {} was refused: {}", base.toShortString(), code);
		refund(server, ritual);
		ServerPlayer player = server.getPlayerList().getPlayer(ritual.player());
		if (player != null) {
			player.sendSystemMessage(refusalMessage(code, refusal != null ? refusal.getMessage() : null).withStyle(ChatFormatting.YELLOW));
		}
	}

	/** Puts the copper back and gives the core back (into the player's inventory, or dropped at the altar). */
	private static void refund(final MinecraftServer server, final Ritual ritual) {
		BlockPos base = ritual.base();
		ServerLevel level = server.getLevel(ritual.dim());
		if (level != null) {
			putBack(level, base, ritual.lower());
			putBack(level, base.above(), ritual.upper());
			Vec3 center = Vec3.atBottomCenterOf(base);
			level.sendParticles(ParticleTypes.SMOKE, center.x, center.y + 1.0, center.z, 20, 0.3, 0.6, 0.3, 0.02);
			level.playSound(null, base, SoundEvents.FIRE_EXTINGUISH, SoundSource.BLOCKS, 0.6F, 1.2F);
		}
		giveBack(server.getPlayerList().getPlayer(ritual.player()), level, base, ritual.core());
	}

	/** What the player reads when the core comes back: Node's own reason, or what to check when Node did not answer. */
	static MutableComponent refusalMessage(final String code, final @Nullable String nodeMessage) {
		return switch (code) {
			case OFFLINE, "TIMEOUT", "DISCONNECTED", "NOT_HANDLED", "NO_SERVER" ->
				Component.translatable("message.minevibe.awaken.offline");
			default -> nodeMessage != null && !nodeMessage.isBlank()
				? Component.translatable("message.minevibe.awaken.refused", nodeMessage)
				: Component.translatable("message.minevibe.awaken.offline");
		};
	}

	/** A visual-only lightning bolt on the spot, with sparks and a chime (it sets nothing on fire and hurts nobody). */
	private static void strike(final ServerLevel level, final BlockPos base) {
		LightningBolt bolt = EntityTypes.LIGHTNING_BOLT.create(level, EntitySpawnReason.TRIGGERED);
		if (bolt != null) {
			bolt.snapTo(Vec3.atBottomCenterOf(base));
			bolt.setVisualOnly(true);
			level.addFreshEntity(bolt);
		}
		Vec3 center = Vec3.atBottomCenterOf(base);
		level.sendParticles(ParticleTypes.END_ROD, center.x, center.y + 1.0, center.z, 40, 0.4, 0.9, 0.4, 0.08);
		level.playSound(null, base, SoundEvents.BEACON_ACTIVATE, SoundSource.BLOCKS, 1.0F, 1.2F);
	}

	/** Puts a copper block back where it stood, or drops it there when something else took the spot meanwhile. */
	private static void putBack(final ServerLevel level, final BlockPos pos, final BlockState state) {
		if (level.getBlockState(pos).isAir()) {
			level.setBlock(pos, state, Block.UPDATE_ALL);
		} else {
			Block.popResource(level, pos, new ItemStack(state.getBlock()));
		}
	}

	private static void giveBack(final @Nullable ServerPlayer player, final @Nullable ServerLevel level, final BlockPos base, final ItemStack core) {
		if (core.isEmpty()) {
			return;
		}
		if (player != null && player.getInventory().add(core)) {
			return;
		}
		if (player != null) {
			player.drop(core, false, Prediction.SERVER_ONLY);
		} else if (level != null) {
			Block.popResource(level, base, core);
		}
	}
}
