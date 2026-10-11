package dev.minevibe.progression;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import java.util.Optional;
import net.minecraft.advancements.predicates.MinMaxBounds;
import net.minecraft.advancements.triggers.SimpleCriterionTrigger;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.loot.predicates.LootItemCondition;

/**
 * {@code minevibe:milestone}: a {@link Milestone} happened, with its running total (counted milestones) or current
 * value (gauges). Conditions: {@code "milestone": "codex_written"} and an optional {@code "value": {"min": 10}}.
 * Several criteria on one milestone at rising {@code min}s give an advancement a progress bar ("3/10"). Fired through
 * {@link Milestones}, never directly.
 */
public final class MilestoneTrigger extends SimpleCriterionTrigger<MilestoneTrigger.TriggerInstance> {
	@Override
	public Codec<TriggerInstance> codec() {
		return TriggerInstance.CODEC;
	}

	void trigger(final ServerPlayer player, final Milestone milestone, final int value) {
		this.trigger(player, t -> t.matches(milestone, value));
	}

	public record TriggerInstance(Optional<Holder<LootItemCondition>> player, Milestone milestone, MinMaxBounds.Ints value)
		implements SimpleCriterionTrigger.SimpleInstance {
		public static final Codec<TriggerInstance> CODEC = RecordCodecBuilder.create(
			i -> i.group(
					LootItemCondition.CODEC.optionalFieldOf("player").forGetter(TriggerInstance::player),
					Milestone.CODEC.fieldOf("milestone").forGetter(TriggerInstance::milestone),
					MinMaxBounds.Ints.CODEC.optionalFieldOf("value", MinMaxBounds.Ints.ANY).forGetter(TriggerInstance::value)
				)
				.apply(i, TriggerInstance::new)
		);

		boolean matches(final Milestone milestone, final int value) {
			return this.milestone == milestone && this.value.matches(value);
		}
	}
}
