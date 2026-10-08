package dev.minevibe.client.ui;

import com.mojang.authlib.GameProfile;
import dev.minevibe.agent.AgentService;
import dev.minevibe.world.seat.SeatEntity;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * Finds agent bodies on the client. A body is a player whose UUID is {@link AgentService#uuidFor} of a crew member's
 * id; a body spawned without Node (the {@code /mv agent spawn} dev command) is still recognised by the role property
 * on its game profile, its agent id being its lowercased name.
 */
public final class AgentEntities {
	private AgentEntities() {}

	/** The living body of a crew member in the client level, or null when it is not loaded. */
	public static @Nullable Player body(ClientLevel level, AgentView agent) {
		Player p = level.getPlayerByUUID(agent.uuid());
		return p != null && !p.isRemoved() ? p : null;
	}

	/** The agent id of an entity, or null when it is not an agent body. */
	public static @Nullable String agentIdOf(Entity entity) {
		if (!(entity instanceof Player player)) return null;
		AgentView view = UiState.get().byUuid(player.getUUID());
		if (view != null) return view.agentId();
		GameProfile profile = player.getGameProfile();
		if (AgentService.roleOf(profile) != null) return AgentService.idFromName(profile.name());
		return null;
	}

	/** The crew member of an entity, or null (also null for a dev-spawned body Node does not know). */
	public static @Nullable AgentView viewOf(Entity entity) {
		return entity instanceof Player player ? UiState.get().byUuid(player.getUUID()) : null;
	}

	/** The body sits on a MineVibe seat (a PC chair or a meeting chair). */
	public static boolean onSeat(Entity body) {
		return body.getVehicle() instanceof SeatEntity;
	}

	/** Seated at a PC: on a seat and on Opus (meeting seats keep Haiku; the seat kind is not synced to clients). */
	public static boolean atPc(Entity body, AgentView agent) {
		return onSeat(body) && "opus".equals(agent.model());
	}

	private static long lastHurtAtMs;

	/** Called every client tick: remembers when the local player last took damage. */
	public static void tick(Minecraft mc) {
		if (mc.player != null && mc.player.hurtTime > 0) lastHurtAtMs = System.currentTimeMillis();
	}

	/** The player is in combat (PLAN §6.4): a hostile within 12 blocks, or damage in the last 8 s. */
	public static boolean playerInCombat(Minecraft mc) {
		Player player = mc.player;
		ClientLevel level = mc.level;
		if (player == null || level == null) return false;
		if (System.currentTimeMillis() - lastHurtAtMs < 8000) return true;
		AABB box = player.getBoundingBox().inflate(12);
		return !level.getEntitiesOfClass(Entity.class, box, e -> e instanceof Enemy && e.isAlive()).isEmpty();
	}
}
