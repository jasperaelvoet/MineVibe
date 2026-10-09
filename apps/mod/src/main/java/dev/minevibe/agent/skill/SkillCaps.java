package dev.minevibe.agent.skill;

import java.util.List;

/**
 * The optional skill features this mod build has, sent as {@code hello.caps} (protocol §6.1, docs/design/tools-v2-mc.md
 * M8). Node uses an additive argument only when its cap is listed: Gson ignores fields a mod does not know, so an
 * older mod would silently drop them. Keep in sync with {@code MOD_CAPS} in packages/protocol (world.ts).
 */
public final class SkillCaps {
	/** {@code skill.run{skill:"sequence"}}: several skills as one job ({@link dev.minevibe.agent.job.SequenceJob}). */
	public static final String SEQUENCE = "skill.sequence";
	/** {@code collect{near?, make_tools?}}, animals for drops, sources in the result. */
	public static final String COLLECT_GATHER = "collect.gather";
	/** {@code craft{tree?, gather_missing?}} ({@link dev.minevibe.agent.job.CraftTreeJob}). */
	public static final String CRAFT_TREE = "craft.tree";
	/** {@code obs.query recipe{item, count?, tree:true}}: the plan without acting. */
	public static final String RECIPE_TREE = "obs.recipe.tree";
	/** {@code container} without {@code pos}: the nearest chest or barrel within 24 blocks. */
	public static final String CONTAINER_NEAREST = "container.nearest";
	/** {@code give} without {@code count}: everything of the item. */
	public static final String GIVE_ALL = "give.all";
	/** {@code SkillRunResult.replaced}: the job a {@code replace: true} run cancelled. */
	public static final String RUN_REPLACED = "run.replaced";
	/** {@code look_around{radius}} up to 48. */
	public static final String LOOK_AROUND_48 = "obs.look_around.48";

	public static final List<String> ALL = List.of(
		SEQUENCE, COLLECT_GATHER, CRAFT_TREE, RECIPE_TREE, CONTAINER_NEAREST, GIVE_ALL, RUN_REPLACED, LOOK_AROUND_48);

	private SkillCaps() {
	}
}
