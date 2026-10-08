package dev.minevibe.world.provenance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.Tag;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FaceAttachedHorizontalDirectionalBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.state.properties.AttachFace;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * W1 provenance without a world: owners, the per-chunk store and its codec, consent tokens, zones, teaching lines. Item
 * stacks and tags need a running server; the GameTests ({@code ProtectionGameTests}) cover tool effects.
 */
class ProvenanceLogicTest {
	@BeforeAll
	static void bootstrap() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void ownersRoundTrip() {
		UUID uuid = UUID.randomUUID();
		for (Owner o : List.of(Owner.player(uuid, "Steve"), Owner.agent("Ada1f3c", "Ada"), Owner.base("Base"))) {
			assertEquals(o, Owner.decode(o.encode()));
		}
		assertEquals("ada1f3c", Owner.agent("Ada1f3c", "Ada").id());
		assertNull(Owner.decode(""));
		assertNull(Owner.decode("x|a|b"));
		assertNull(Owner.decode("p|nobar"));
		assertEquals("a_b", Owner.decode(Owner.player(uuid, "a|b").encode()).name(), "a bar in a name cannot break the format");
	}

	@Test
	void chunkMarksStoreAndForget() {
		ChunkMarks m = new ChunkMarks();
		Owner steve = Owner.player(UUID.randomUUID(), "Steve");
		Owner ada = Owner.agent("ada", "Ada");
		BlockPos a = new BlockPos(17, -60, -3);
		BlockPos b = new BlockPos(30, 319, -16);
		assertTrue(m.put(a, steve));
		assertFalse(m.put(a, steve), "same owner again changes nothing");
		assertTrue(m.put(b, ada));
		assertEquals(steve, m.get(a));
		assertEquals(ada, m.get(b));
		assertNull(m.get(a.above()));
		assertTrue(m.put(a, ada), "a new placement replaces the owner");
		assertEquals(ada, m.get(a));
		assertTrue(m.remove(a));
		assertFalse(m.remove(a));
		assertEquals(1, m.size());
		assertTrue(m.remove(b));
		assertTrue(m.isEmpty());
	}

	@Test
	void chunkMarksSurviveTheCodec() {
		ChunkMarks m = new ChunkMarks();
		Owner steve = Owner.player(UUID.randomUUID(), "Steve");
		Owner base = Owner.base("Base");
		Owner ada = Owner.agent("ada", "Ada");
		ChunkPos chunk = new ChunkPos(-2, 5);
		Map<BlockPos, Owner> expected = new HashMap<>();
		for (int i = 0; i < 40; i++) {
			BlockPos p = new BlockPos(chunk.getMinBlockX() + i % 16, -64 + i * 9, chunk.getMinBlockZ() + (i * 7) % 16);
			Owner o = i % 3 == 0 ? steve : i % 3 == 1 ? base : ada;
			m.put(p, o);
			expected.put(p, o);
		}
		// An owner nobody uses any more is dropped when saving.
		BlockPos gone = new BlockPos(chunk.getMinBlockX(), 70, chunk.getMinBlockZ());
		m.put(gone, Owner.player(UUID.randomUUID(), "Alex"));
		m.remove(gone);

		Tag tag = ChunkMarks.CODEC.encodeStart(NbtOps.INSTANCE, m).getOrThrow();
		assertFalse(tag.toString().contains("Alex"), "unused owners are not saved: " + tag);
		ChunkMarks back = ChunkMarks.CODEC.parse(NbtOps.INSTANCE, tag).getOrThrow();
		assertEquals(expected.size(), back.size());
		expected.forEach((p, o) -> assertEquals(o, back.get(p), "mark at " + p));
		Map<BlockPos, Owner> visited = new HashMap<>();
		back.forEach(chunk, (p, o) -> visited.put(p.immutable(), o));
		assertEquals(expected, visited, "forEach gives world positions back");
	}

	@Test
	void consentTokensAreSingleUseAndBound() {
		Consents.reset();
		List<BlockPos> house = List.of(new BlockPos(1, 64, 1), new BlockPos(3, 66, 2));
		String token = Consents.offer("ada", Level.OVERWORLD, house);
		assertNotNull(token);
		assertTrue(token.matches("[0-9a-f]{32}"), token);
		assertNotEquals(token, Consents.offer("ada", Level.OVERWORLD, house), "every offer has its own token");
		assertNull(Consents.redeem("bram", token), "another agent cannot use it");
		Consents.Request r = Consents.redeem("ADA", token);
		assertNotNull(r);
		assertNull(Consents.redeem("ada", token), "used up");
		assertTrue(r.covers(Level.OVERWORLD, new BlockPos(2, 65, 2)));
		assertFalse(r.covers(Level.OVERWORLD, new BlockPos(4, 65, 2)));
		assertFalse(r.covers(Level.NETHER, new BlockPos(2, 65, 2)));
		assertFalse(Consents.covers("ada", Level.OVERWORLD, new BlockPos(2, 65, 2)), "nothing is allowed before a job holds the grant");
		Consents.activate("ada", r, "job-1");
		assertTrue(Consents.covers("ada", Level.OVERWORLD, new BlockPos(2, 65, 2)));
		assertFalse(Consents.covers("bram", Level.OVERWORLD, new BlockPos(2, 65, 2)));
		Consents.deactivate("ada", "job-2");
		assertTrue(Consents.covers("ada", Level.OVERWORLD, new BlockPos(2, 65, 2)), "another job's end keeps it");
		Consents.deactivate("ada", "job-1");
		assertFalse(Consents.covers("ada", Level.OVERWORLD, new BlockPos(2, 65, 2)));
		assertNull(Consents.offer("ada", Level.OVERWORLD, List.of()));
		Consents.reset();
	}

	@Test
	void zonesMeasureDistances() {
		Zones.Zone base = Zones.baseAround(Level.OVERWORLD, new BoundingBox(0, 63, 0, 12, 69, 9));
		assertEquals(new BoundingBox(-2, 61, -2, 14, 71, 11), base.box(), "two blocks of margin");
		assertTrue(base.contains(Level.OVERWORLD, new BlockPos(-2, 64, 11)));
		assertFalse(base.contains(Level.NETHER, new BlockPos(0, 64, 0)));
		assertEquals(0.0, base.distance(new BlockPos(5, 64, 5)));
		assertEquals(12.0, base.horizontalDistance(new BlockPos(5, 90, 23)));
		assertEquals(5.0, base.horizontalDistance(new BlockPos(17, 64, 15)));
	}

	@Test
	void plantsAndFireAreNeverMarked() {
		assertFalse(Provenance.markable(Blocks.WHEAT.defaultBlockState()));
		assertFalse(Provenance.markable(Blocks.OAK_SAPLING.defaultBlockState()));
		assertFalse(Provenance.markable(Blocks.FIRE.defaultBlockState()));
		assertTrue(Provenance.markable(Blocks.STRIPPED_SPRUCE_LOG.defaultBlockState()));
		assertTrue(Provenance.markable(Blocks.OAK_LEAVES.defaultBlockState()));
	}

	@Test
	void verdictsTeach() {
		Protection.Verdict base = new Protection.Verdict(new BlockPos(1, 2, 3), Protection.What.BASE, "Steve", "minecraft:stripped_spruce_log", "Base");
		assertEquals("That's part of Steve's base — ask Steve before changing it.", base.hint());
		Protection.Verdict built = new Protection.Verdict(new BlockPos(1, 2, 3), Protection.What.PLAYER_BUILT, "Steve", "minecraft:oak_planks", null);
		assertEquals("That's part of Steve's build — ask Steve before changing it.", built.hint());
		assertTrue(built.message().endsWith("(oak_planks at 1 2 3)"), built.message());
		assertEquals("player-built", Protection.What.PLAYER_BUILT.wire);
	}

	@Test
	void verdictsExplainWhyANaturalBlockIsProtected() {
		Protection.Verdict holds = new Protection.Verdict(new BlockPos(1, 2, 3), Protection.What.PLAYER_BUILT, "Steve", "minecraft:stone", null,
			"That holds up %s (ladder at 2 2 3)");
		assertEquals("That holds up part of Steve's build (ladder at 2 2 3) — ask Steve before changing it.", holds.hint());
		assertTrue(holds.message().endsWith("(stone at 1 2 3)"), holds.message());
		Protection.Verdict fire = new Protection.Verdict(new BlockPos(1, 2, 3), Protection.What.BASE, "Steve", "minecraft:oak_planks", "Base")
			.withLead("Fire or lava there could reach %s");
		assertEquals("Fire or lava there could reach part of Steve's base — ask Steve before changing it.", fire.hint());
	}

	/** What a block needs from the block next to it: support from below, a wall to hang on, a ceiling to hang from. */
	@Test
	void dependentsKnowWhatHoldsThemUp() {
		assertTrue(Protection.dependsOn(Blocks.TORCH.defaultBlockState(), Direction.UP), "a torch stands on the block below");
		assertFalse(Protection.dependsOn(Blocks.TORCH.defaultBlockState(), Direction.NORTH));
		assertTrue(Protection.dependsOn(Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, Direction.EAST), Direction.EAST),
			"a wall torch facing east hangs on the block to its west");
		assertFalse(Protection.dependsOn(Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, Direction.EAST), Direction.WEST));
		assertFalse(Protection.dependsOn(Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, Direction.EAST), Direction.UP),
			"a wall torch does not stand on anything");
		assertTrue(Protection.dependsOn(Blocks.LADDER.defaultBlockState().setValue(LadderBlock.FACING, Direction.SOUTH), Direction.SOUTH));
		assertTrue(Protection.dependsOn(Blocks.OAK_DOOR.defaultBlockState(), Direction.UP), "doors stand on the ground");
		assertTrue(Protection.dependsOn(Blocks.SAND.defaultBlockState(), Direction.UP), "sand falls without support");
		assertTrue(Protection.dependsOn(Blocks.RAIL.defaultBlockState(), Direction.UP));
		assertTrue(Protection.dependsOn(Blocks.MOSS_CARPET.defaultBlockState(), Direction.UP));
		assertTrue(Protection.dependsOn(Blocks.LANTERN.defaultBlockState().setValue(LanternBlock.HANGING, true), Direction.DOWN), "a hanging lantern");
		assertFalse(Protection.dependsOn(Blocks.LANTERN.defaultBlockState().setValue(LanternBlock.HANGING, true), Direction.UP));
		assertTrue(Protection.dependsOn(Blocks.LEVER.defaultBlockState().setValue(FaceAttachedHorizontalDirectionalBlock.FACE, AttachFace.CEILING), Direction.DOWN));
		assertFalse(Protection.dependsOn(Blocks.STONE.defaultBlockState(), Direction.UP), "stone needs nothing");
		assertFalse(Protection.dependsOn(Blocks.OAK_FENCE.defaultBlockState(), Direction.UP), "fences stand on their own");
		assertFalse(Protection.dependsOn(Blocks.OAK_PLANKS.defaultBlockState(), Direction.DOWN));
	}
}
