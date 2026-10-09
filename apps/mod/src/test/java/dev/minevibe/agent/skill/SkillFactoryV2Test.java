package dev.minevibe.agent.skill;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.agent.job.CraftJobs;
import dev.minevibe.agent.job.CraftTreeJob;
import dev.minevibe.agent.job.GatherJobs;
import dev.minevibe.agent.job.MenuJobs;
import dev.minevibe.agent.job.SequenceJob;
import dev.minevibe.agent.job.WorldJobs;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Skills;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The v2 skill arguments (docs/design/tools-v2-mc.md M1, M2, M4, M6, M8) as SkillFactory reads them. */
class SkillFactoryV2Test {
	@BeforeAll
	static void bootstrap() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static JsonObject json(final String text) {
		return JsonParser.parseString(text).getAsJsonObject();
	}

	private static String error(final Runnable r) {
		BridgeException e = assertThrows(BridgeException.class, r::run);
		return e.code() + ": " + e.getMessage();
	}

	@Test
	void sequenceBuildsEveryStepUpFront() {
		SequenceJob seq = assertInstanceOf(SequenceJob.class, SkillFactory.create("sequence", json("""
			{"steps":[{"skill":"collect","args":{"item":"oak_log","count":10}},
			          {"skill":"craft","args":{"item":"crafting_table","count":1,"tree":true}}],
			 "stop_on_fail":false}""")));
		assertEquals(2, seq.steps().size());
		assertInstanceOf(GatherJobs.Collect.class, seq.steps().get(0).job());
		assertInstanceOf(CraftTreeJob.class, seq.steps().get(1).job());
		assertTrue(Skills.SKILL_NAMES.contains("sequence"));
	}

	@Test
	void sequenceRejectsBadStepsByNumber() {
		assertTrue(error(() -> SkillFactory.create("sequence", json("{\"steps\":[{\"skill\":\"eat\",\"args\":{}}]}")))
			.startsWith("BAD_ARGS: a sequence has 2-8 steps"));
		assertTrue(error(() -> SkillFactory.create("sequence", json(
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"sequence\",\"args\":{}}]}"))).contains("step 2: sequence cannot be a step"));
		assertTrue(error(() -> SkillFactory.create("sequence", json(
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"emote\",\"args\":{\"kind\":\"wave\"}}]}"))).contains("step 2: emote"));
		assertTrue(error(() -> SkillFactory.create("sequence", json(
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"craft\",\"args\":{\"count\":1}}]}"))).contains("step 2: craft: item is required"));
		assertTrue(error(() -> SkillFactory.create("sequence", json(
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"fly\",\"args\":{}}]}"))).startsWith("UNKNOWN_SKILL: step 2"));
	}

	@Test
	void theV2ArgumentsAreRead() {
		assertInstanceOf(GatherJobs.Collect.class, SkillFactory.create("collect", json(
			"{\"item\":\"oak_log\",\"count\":10,\"radius\":48,\"near\":{\"x\":6,\"y\":66,\"z\":24},\"make_tools\":true}")));
		assertInstanceOf(CraftTreeJob.class, SkillFactory.create("craft", json("{\"item\":\"iron_pickaxe\",\"count\":1,\"tree\":true,\"gather_missing\":true}")));
		// Without tree, craft is v1's single-level craft.
		assertInstanceOf(CraftJobs.Craft.class, SkillFactory.create("craft", json("{\"item\":\"stick\",\"count\":4}")));
		// container without pos (the nearest chest), give without count (everything).
		assertInstanceOf(MenuJobs.Container.class, SkillFactory.create("container", json("{\"action\":\"list\"}")));
		assertInstanceOf(WorldJobs.Give.class, SkillFactory.create("give", json("{\"item\":\"bread\",\"to\":\"player\"}")));
		assertTrue(error(() -> SkillFactory.create("craft", json("{\"item\":\"#planks\",\"count\":1,\"tree\":true}"))).startsWith("BAD_ARGS"));
	}

	@Test
	void capsAreLowercaseDottedWords() {
		for (String cap : SkillCaps.ALL) {
			assertTrue(cap.matches("[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*"), cap);
		}
		assertEquals(SkillCaps.ALL.size(), new java.util.HashSet<>(SkillCaps.ALL).size());
	}
}
