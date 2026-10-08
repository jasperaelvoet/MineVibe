package dev.minevibe.agent.nav;

import dev.minevibe.MineVibeMod;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.pathfinder.PathType;
import net.fabricmc.fabric.api.object.builder.v1.entity.FabricDefaultAttributeRegistry;
import org.jspecify.annotations.Nullable;

/**
 * A {@link PathfinderMob} that is never added to a level. Vanilla's {@code PathFinder} and
 * {@code WalkNodeEvaluator} need a {@code Mob} for its size, position, fluid state and path-type
 * costs; this proxy is moved onto the agent right before each search and reports the agent's state.
 *
 * <p>It has player dimensions (0.6 x 1.8), refuses drops deeper than 3 blocks, never paths through
 * fire, lava or damaging blocks, and avoids water unless needed.
 */
public final class NavProxyMob extends PathfinderMob {
	public static final ResourceKey<EntityType<?>> KEY = ResourceKey.create(Registries.ENTITY_TYPE, MineVibeMod.id("nav_proxy"));
	public static EntityType<NavProxyMob> TYPE;

	private static final int MAX_DROP = 3;

	private @Nullable Player owner;

	public NavProxyMob(final EntityType<? extends NavProxyMob> type, final Level level) {
		super(type, level);
		this.setPathfindingMalus(PathType.FIRE, -1.0F);
		this.setPathfindingMalus(PathType.FIRE_IN_NEIGHBOR, 16.0F);
		this.setPathfindingMalus(PathType.DAMAGING_IN_NEIGHBOR, 16.0F);
		this.setPathfindingMalus(PathType.DAMAGE_CAUTIOUS, 4.0F);
		this.setPathfindingMalus(PathType.WATER, 4.0F);
		this.setPathfindingMalus(PathType.WATER_BORDER, 2.0F);
		this.setPathfindingMalus(PathType.POWDER_SNOW, -1.0F);
		this.setPathfindingMalus(PathType.STICKY_HONEY, 16.0F);
	}

	public static void register() {
		TYPE = Registry.register(
			BuiltInRegistries.ENTITY_TYPE,
			KEY,
			EntityType.Builder.<NavProxyMob>of(NavProxyMob::new, MobCategory.MISC).sized(0.6F, 1.8F).noSave().noSummon().clientTrackingRange(0).build(KEY)
		);
		FabricDefaultAttributeRegistry.register(TYPE, Mob.createMobAttributes());
	}

	/** Moves the proxy onto {@code player} and mirrors the state the evaluator reads. */
	public void syncFrom(final Player player) {
		this.owner = player;
		this.setPos(player.getX(), player.getY(), player.getZ());
		this.setOnGround(player.onGround());
		this.setYRot(player.getYRot());
	}

	@Override
	public int getMaxFallDistance() {
		return MAX_DROP;
	}

	@Override
	public boolean isInWater() {
		return this.owner != null && this.owner.isInWater();
	}

	@Override
	public boolean isInLava() {
		return this.owner != null && this.owner.isInLava();
	}

	@Override
	public boolean isInFloatableFluid() {
		return this.owner != null && this.owner.isInFloatableFluid();
	}

	@Override
	public boolean hurtServer(final ServerLevel level, final DamageSource source, final float damage) {
		return false;
	}
}
