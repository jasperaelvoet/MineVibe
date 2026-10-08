package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.onTestEnd;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.recorder;
import static dev.minevibe.gametest.agent.SkillTestSupport.service;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Seats.AgentSeat;
import dev.minevibe.bridge.msg.Seats.AgentUnseat;
import dev.minevibe.bridge.msg.Seats.SeatTarget;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficePlan;
import dev.minevibe.pc.OfficeWorkstation;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcContent;
import dev.minevibe.pc.PcDeskBlock;
import dev.minevibe.pc.PcSeatRegistry;
import dev.minevibe.pc.PcStates;
import dev.minevibe.pc.PcWorkstation;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import dev.minevibe.world.seat.SeatKind;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.GlobalPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/**
 * GameTests for the mod-side wiring between the PC blocks, the org blocks and the skill layer (integration track I2):
 * the starter office puts a desk bound to {@code linux-1} into its first slot (and rebuilds without drops); an agent
 * reaches a real desk's chair through {@code agent.seat} / {@code sit_at_pc} with {@code pc.seat} reported; meeting
 * chairs come from the meeting tables, one per walker, and never count as PC seats; a kick is reported as such and
 * blocks a re-sit for 30 s.
 *
 * <p>Each test runs in a batch of its own (an empty environment per test): the PC registry, {@code linux-1}'s single
 * desk and the seat cap are shared by the whole server.
 */
public final class SeatWiringGameTests {
	private static final String ARENA = "minevibe-gametest:arena";
	private static final String OFFICE_SITE = "minevibe-gametest:office_site";
	private static final String SEAT_OFFICE = "minevibe-gametest:seat_office";
	private static final String SEAT_DESK = "minevibe-gametest:seat_desk";
	private static final String SEAT_KICK = "minevibe-gametest:seat_kick";
	private static final String SEAT_MEETING = "minevibe-gametest:seat_meeting";
	private static final String OFFICE_DOOR = "minevibe-gametest:office_door";
	private static final AtomicLong SLOTS = new AtomicLong(7_000);

	// ------------------------------------------------------------------ the office's workstation

	@GameTest(structure = OFFICE_SITE, environment = SEAT_OFFICE, maxTicks = 60)
	public void officePlacesABoundLinux1Workstation(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		helper.assertTrue(OfficeBuilder.workstationPlacer() instanceof OfficeWorkstation, "PcModInit installed the office workstation placer");
		// One PC has one desk: a linux-1 desk an earlier office left in this world would keep the slot empty.
		GlobalPos leftover = dev.minevibe.pc.PcRegistry.deskOf(OfficeWorkstation.FIRST_PC_ID);
		if (leftover != null && level.getServer().getLevel(leftover.dimension()) instanceof ServerLevel there) {
			PcWorkstation.removeQuietly(there, leftover.pos());
		}
		BlockPos origin = helper.absolutePos(new BlockPos(1, 1, 1));
		OfficeLayout layout = OfficeBuilder.build(level, origin);
		OfficeLayout.Slot slot = layout.firstSlot(OfficeLayout.WORKSTATION);
		onTestEnd(helper, () -> PcWorkstation.removeQuietly(level, slot.pos()));

		same(helper, slot.pcId(), OfficeWorkstation.FIRST_PC_ID, "slot 1 names linux-1");
		same(helper, layout.slotsOf(OfficeLayout.WORKSTATION).get(1).pcId(), null, "slot 2 stays free");
		BlockPos monitor = PcDeskBlock.monitorPos(slot.pos());
		helper.assertTrue(level.getBlockEntity(monitor) instanceof PcBlockEntity be && OfficeWorkstation.FIRST_PC_ID.equals(be.pcId())
			&& "linux".equals(be.type()), "the desk shows linux-1");
		Direction facing = OfficeBuilder.direction(OfficePlan.piecesOf(OfficePlan.Kind.WORKSTATION).getFirst().facing());
		BlockPos chair = PcDeskBlock.chairPos(slot.pos(), facing);
		BlockState chairState = level.getBlockState(chair);
		helper.assertTrue(chairState.is(MvWorldContent.OFFICE_CHAIR) && chairState.getValue(OfficeChairBlock.KIND) == SeatKind.PC, "a PC chair in front");
		same(helper, dev.minevibe.pc.PcRegistry.deskOf(OfficeWorkstation.FIRST_PC_ID), GlobalPos.of(level.dimension(), monitor), "registered desk");
		same(helper, Seats.pcs().chair(level.getServer(), OfficeWorkstation.FIRST_PC_ID), new PcRegistry.Chair(level.dimension(), chair),
			"the skill layer finds linux-1's chair through the desk");

		// world.state.office: workstation slots with the bound PC, valid against the protocol.
		JsonObject office = layout.toWorldState();
		JsonObject first = null;
		for (JsonElement e : office.getAsJsonArray("slots")) {
			if ("workstation".equals(e.getAsJsonObject().get("kind").getAsString())) {
				first = e.getAsJsonObject();
				break;
			}
		}
		helper.assertTrue(first != null && "linux-1".equals(first.get("pcId").getAsString()), "world.state.office slot kind workstation with pcId: " + first);
		JsonObject state = new JsonObject();
		state.addProperty("t", "world.state");
		state.addProperty("v", 1);
		state.addProperty("worldId", "w-test");
		state.addProperty("phase", "ready");
		state.add("office", office);
		same(helper, Messages.WORLD_STATE.schema().validate(state), List.of(), "world.state.office matches the protocol");

		// Rebuilding over the office clears the desk quietly (no workstation item drops) and binds linux-1 again.
		OfficeLayout again = OfficeBuilder.build(level, origin);
		same(helper, again, layout, "the same layout");
		helper.assertTrue(level.getBlockEntity(monitor) instanceof PcBlockEntity be && OfficeWorkstation.FIRST_PC_ID.equals(be.pcId()), "still linux-1");
		AABB area = new AABB(origin).inflate(20);
		helper.runAfterDelay(2, () -> {
			List<ItemEntity> drops = level.getEntitiesOfClass(ItemEntity.class, area,
				i -> i.getItem().is(PcContent.LINUX_WORKSTATION) || i.getItem().is(PcContent.MAC_WORKSTATION));
			helper.assertTrue(drops.isEmpty(), "no workstation item dropped: " + drops);
			helper.succeed();
		});
	}

	// ------------------------------------------------------------------ the office door, table and Codex

	@GameTest(structure = OFFICE_SITE, environment = OFFICE_DOOR, maxTicks = 400)
	public void anAgentWithoutAtSpawnsAtTheOfficeDoorAndFindsTheTableAndCodex(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		net.minecraft.server.MinecraftServer server = level.getServer();
		BlockPos origin = helper.absolutePos(new BlockPos(1, 1, 1));
		OfficeLayout layout = OfficeBuilder.build(level, origin, null);
		// This world's office for the length of the test (its own batch: nothing else runs meanwhile).
		dev.minevibe.org.office.OfficeService.overrideLayout(server, layout);
		onTestEnd(helper, () -> dev.minevibe.org.office.OfficeService.overrideLayout(server, null));
		BlockPos door = layout.firstSlot(OfficeLayout.DOOR).pos();
		SkillService service = service(helper);
		String id = AgentTestSupport.uniqueName("door").toLowerCase(java.util.Locale.ROOT);
		Map<String, Object> out = service.spawn(new Bodies.AgentSpawn(id, id, "Door", "engineer", false, null, null, false, "stay", null));
		AgentPlayer agent = dev.minevibe.agent.AgentService.get(server).agent(id);
		helper.assertTrue(agent != null, "spawned");
		onTestEnd(helper, () -> dev.minevibe.agent.AgentService.get(server).dismiss(agent));
		same(helper, agent.blockPosition(), door, "agent.spawn without at appears at the office door (" + out + ")");
		same(helper, agent.brain().home(), door, "the door is its home");

		// A meeting seat is a free chair of the office's table.
		PcRegistry.Chair chair = Seats.meetings().chairFor(server, "m-office", id);
		helper.assertTrue(chair != null && MeetingTables.chairsOf(level, layout.firstSlot(OfficeLayout.MEETING_TABLE).pos()).contains(chair.pos()),
			"a chair of the office's meeting table: " + chair);

		// The "file it" walk: goto{codex} goes to the spot in front of the office's Codex.
		Direction codexFacing = OfficeBuilder.direction(OfficePlan.piecesOf(OfficePlan.Kind.CODEX).getFirst().facing());
		BlockPos spot = layout.firstSlot(OfficeLayout.CODEX).pos().relative(codexFacing);
		helper.assertTrue(dev.minevibe.agent.skill.Places.isPlace("codex"), "codex is a place");
		same(helper, dev.minevibe.agent.skill.Places.resolve(agent, "codex"), spot, "the codex place");
		String job = jobId("file");
		var reply = SkillTestSupport.run(helper, agent, job, "goto", "{\"entity\":\"codex\"}", 0);
		helper.succeedWhen(() -> {
			var r = recorder(helper).results(job);
			helper.assertTrue(!r.isEmpty() && "done".equals(r.getFirst().status()), "walked to the Codex: " + r + " " + reply);
			helper.assertTrue(agent.blockPosition().distManhattan(spot) <= 2, "at the Codex: " + agent.blockPosition());
		});
	}

	// ------------------------------------------------------------------ an agent at a real desk

	@GameTest(structure = ARENA, environment = SEAT_DESK, maxTicks = 400)
	public void agentSitsAtARealDeskThroughSitAtPc(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		String pcId = desk(helper, new BlockPos(9, 1, 9), Direction.NORTH);
		BlockPos chair = PcDeskBlock.chairPos(helper.absolutePos(new BlockPos(9, 1, 9)), Direction.NORTH);
		// pc.state reaches the seat registry through PcStates (one handler per type: PcBridge owns pc.state).
		PcStates.put(info(pcId, "booting"));
		same(helper, Seats.pcs().status(pcId), "booting", "status from pc.state");
		AgentPlayer agent = spawnAgent(helper, "Coder", AgentRole.ENGINEER, 3, 1, 3);
		SkillService service = service(helper);
		expectError(helper, "PC_DOWN", () -> service.seat(new AgentSeat(agent.agentId(), jobId("x"), 1, SeatTarget.pc(pcId), null)));
		PcStates.put(info(pcId, "running"));
		same(helper, Seats.pcs().status(pcId), "running", "status follows pc.state");
		String job = jobId("sit");
		Map<String, Object> reply = service.seat(new AgentSeat(agent.agentId(), job, 5, SeatTarget.pc(pcId), "fix the tests"));
		same(helper, reply.get("status"), "running", "agent.seat answers running");
		PcRegistry.Reservation coming = Seats.pcs().reservation(pcId);
		helper.assertTrue(coming != null && PcRegistry.Reservation.COMING.equals(coming.kind()), "reserved: coming (" + coming + ")");
		helper.startSequence()
			.thenWaitUntil(() -> {
				List<Skills.SkillResult> r = recorder(helper).results(job);
				helper.assertTrue(!r.isEmpty(), "skill.result for sit_at_pc");
				same(helper, r.getFirst().status(), "done", "seated: " + r.getFirst().error());
			})
			.thenExecute(() -> {
				helper.assertTrue(agent.getVehicle() instanceof SeatEntity seat && seat.isPcSeat() && chair.equals(seat.chairPos()), "rides the desk's chair");
				var seats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_SEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(seats.size() == 1 && agent.agentId().equals(seats.getFirst().occupant().agentId())
					&& Long.valueOf(5).equals(seats.getFirst().seatEpoch()), "pc.seat for the agent with its epoch: " + seats);
				same(helper, Seats.pcs().occupant(level.getServer(), pcId), dev.minevibe.bridge.msg.Types.Occupant.agent(agent.agentId()), "occupant");
				helper.assertTrue(Seats.pcs().reservation(pcId) == null, "the reservation became the occupant");
				same(helper, dev.minevibe.pc.PcRegistry.pcSeatedAt(agent), pcId, "the PC registry sees the agent's seat");
				helper.assertTrue(dev.minevibe.pc.PcRegistry.seatedPc(agent.getUUID()) == null, "agents are not reported as the player");
				JsonObject pcs = (JsonObject)service.obs(new Skills.ObsQuery(agent.agentId(), "list_pcs", new JsonObject())).get("result");
				helper.assertTrue(listed(pcs, pcId, agent.agentId()), "list_pcs shows the desk with its occupant: " + pcs);
				service.unseat(new AgentUnseat(agent.agentId(), 5, "stand", false));
				var unseats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(unseats.size() == 1 && "stand".equals(unseats.getFirst().reason()), "pc.unseat stand: " + unseats);
				helper.assertFalse(agent.isPassenger(), "stood up");
				helper.assertTrue(recorder(helper).invalid(agent.agentId()).isEmpty(), "every message matched the protocol");
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ kick

	@GameTest(structure = ARENA, environment = SEAT_KICK, maxTicks = 600)
	public void kickIsReportedAndBlocksAReSit(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		String pcId = desk(helper, new BlockPos(9, 1, 9), Direction.NORTH);
		BlockPos chair = PcDeskBlock.chairPos(helper.absolutePos(new BlockPos(9, 1, 9)), Direction.NORTH);
		PcStates.put(info(pcId, "running"));
		AgentPlayer agent = spawnAgent(helper, "Kicked", AgentRole.ENGINEER, 3, 1, 3);
		SkillService service = service(helper);
		AtomicLong now = new AtomicLong(System.nanoTime());
		PcSeatRegistry.INSTANCE.setClock(now::get);
		onTestEnd(helper, () -> PcSeatRegistry.INSTANCE.setClock(null));
		AtomicReference<ServerPlayer> player = new AtomicReference<>();
		String job = jobId("sit");
		service.seat(new AgentSeat(agent.agentId(), job, 3, SeatTarget.pc(pcId), null));
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(service.seated(agent.agentId()) != null, "seated"))
			.thenExecute(() -> {
				same(helper, PcSeatRegistry.INSTANCE.kick(level.getServer(), pcId), agent.agentId(), "the kick hit the agent");
				helper.assertFalse(agent.isPassenger(), "dismounted");
				same(helper, agent.brain().lastStandReason(40), "kick", "the reason was noted before the dismount");
				helper.assertTrue(agent.blockPosition().distManhattan(chair) <= 3 && !agent.blockPosition().equals(chair), "stepped aside");
			})
			.thenWaitUntil(() -> {
				var unseats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(!unseats.isEmpty(), "pc.unseat sent");
				same(helper, unseats.getFirst().reason(), "kick", "pc.unseat reason");
				helper.assertFalse(unseats.getFirst().reserved(), "no chair kept after a kick");
			})
			.thenExecute(() -> {
				List<Bodies.AgentEvent> kicked = recorder(helper).events(agent.agentId(), "kicked");
				helper.assertTrue(kicked.size() == 1 && kicked.getFirst().urgency() == 2, "one critical kicked event: " + kicked);
				helper.assertTrue(service.seated(agent.agentId()) == null, "no longer tracked as seated");
				helper.assertTrue(Seats.pcs().reservation(pcId) == null, "no reservation left");
				// The 30 s re-sit cooldown.
				helper.assertTrue(PcSeatRegistry.INSTANCE.resitCooldownSeconds(agent.agentId(), pcId) > 0, "cooldown running");
				expectError(helper, "RESERVED", () -> service.seat(new AgentSeat(agent.agentId(), jobId("x"), 4, SeatTarget.pc(pcId), null)));
				now.addAndGet((PcSeatRegistry.RESIT_COOLDOWN_SECONDS + 1) * 1_000_000_000L);
				same(helper, PcSeatRegistry.INSTANCE.resitCooldownSeconds(agent.agentId(), pcId), 0, "cooldown over");
				service.seat(new AgentSeat(agent.agentId(), jobId("sit"), 4, SeatTarget.pc(pcId), null));
			})
			.thenWaitUntil(() -> helper.assertTrue(service.seated(agent.agentId()) != null, "seated again after the cooldown"))
			.thenExecute(() -> {
				// "Kick Bram and sit?": the player takes the chair in one go.
				player.set(spawnHumanStandIn(helper, 8, 1, 6));
				helper.assertTrue(PcSeatRegistry.INSTANCE.kickAndSit(player.get(), chair), "the player sits");
				helper.assertTrue(player.get().getVehicle() instanceof SeatEntity, "the player rides the chair");
				helper.assertFalse(agent.isPassenger(), "the agent is off");
			})
			.thenWaitUntil(() -> same(helper, recorder(helper).events(agent.agentId(), "kicked").size(), 2, "a second kicked event"))
			.thenWaitUntil(() -> same(helper, dev.minevibe.pc.PcRegistry.seatedPc(player.get().getUUID()), pcId, "the player is at the PC"))
			.thenExecute(() -> {
				dev.minevibe.pc.PcRegistry.standUp(player.get(), "stand");
				// A chair kept for an agent away asking the player: the player may take it, which ends the reservation.
				Seats.pcs().reserve(pcId, agent.agentId(), PcRegistry.Reservation.AWAY);
			})
			.thenWaitUntil(() -> helper.assertTrue(dev.minevibe.pc.PcRegistry.seatedPc(player.get().getUUID()) == null, "the player stood up"))
			.thenExecute(() -> helper.assertTrue(OfficeChairBlock.trySit(level, chair, player.get()), "the player takes the reserved chair"))
			.thenWaitUntil(() -> helper.assertTrue(Seats.pcs().reservation(pcId) == null, "the reservation ended: " + Seats.pcs().reservation(pcId)))
			.thenExecute(() -> helper.assertTrue(recorder(helper).invalid(agent.agentId()).isEmpty(), "every message matched the protocol"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ meeting chairs

	@GameTest(structure = ARENA, environment = SEAT_MEETING, maxTicks = 600)
	public void meetingSeatsComeFromTheTableOnePerWalker(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos table = helper.absolutePos(new BlockPos(7, 1, 10));
		level.setBlockAndUpdate(table, OrgContent.MEETING_TABLE.defaultBlockState());
		List<BlockPos> chairs = List.of(table.north(), table.south());
		level.setBlockAndUpdate(chairs.get(0), MvWorldContent.OFFICE_CHAIR.defaultBlockState().setValue(OfficeChairBlock.FACING, Direction.SOUTH));
		level.setBlockAndUpdate(chairs.get(1), MvWorldContent.OFFICE_CHAIR.defaultBlockState().setValue(OfficeChairBlock.FACING, Direction.NORTH));
		same(helper, MeetingTables.relink(level, table).size(), 2, "two meeting chairs");
		AgentPlayer ada = spawnAgent(helper, "Ada", AgentRole.ENGINEER, 3, 1, 3);
		AgentPlayer bram = spawnAgent(helper, "Bram", AgentRole.MINER, 11, 1, 3);
		AgentPlayer cleo = spawnAgent(helper, "Cleo", AgentRole.FARMER, 5, 1, 2);
		SkillService service = service(helper);
		String jobA = jobId("meet");
		String jobB = jobId("meet");
		service.seat(new AgentSeat(ada.agentId(), jobA, 1, SeatTarget.meeting("m-standup"), null));
		service.seat(new AgentSeat(bram.agentId(), jobB, 1, SeatTarget.meeting("m-standup"), null));
		BlockPos chairA = ((dev.minevibe.agent.skill.seat.SeatJob)ada.jobs().current()).chair().pos();
		BlockPos chairB = ((dev.minevibe.agent.skill.seat.SeatJob)bram.jobs().current()).chair().pos();
		helper.assertTrue(chairs.contains(chairA) && chairs.contains(chairB) && !chairA.equals(chairB), "two walkers get two chairs: " + chairA + " " + chairB);
		// The table is full of walkers: a third attendee gets no chair here (NO_SEAT, or a free chair of another table).
		try {
			service.seat(new AgentSeat(cleo.agentId(), jobId("meet"), 1, SeatTarget.meeting("m-standup"), null));
			BlockPos chairC = ((dev.minevibe.agent.skill.seat.SeatJob)cleo.jobs().current()).chair().pos();
			helper.assertFalse(chairs.contains(chairC), "no chair is handed out twice: " + chairC);
			cleo.jobs().cancel("test");
		} catch (BridgeException e) {
			same(helper, e.code(), "NO_SEAT", "error code");
		}
		helper.startSequence()
			.thenWaitUntil(() -> {
				helper.assertTrue(service.seated(ada.agentId()) != null && service.seated(bram.agentId()) != null, "both seated");
			})
			.thenExecute(() -> {
				for (AgentPlayer a : List.of(ada, bram)) {
					helper.assertTrue(a.getVehicle() instanceof SeatEntity seat && seat.kind() == SeatKind.MEETING, a.agentId() + " rides a meeting seat");
					helper.assertTrue(dev.minevibe.pc.PcRegistry.pcSeatedAt(a) == null, "a meeting seat is no PC seat");
					same(helper, service.seated(a.agentId()).target().kind(), SeatTarget.MEETING, "seat kind meeting");
					helper.assertTrue(recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_SEAT, s -> a.agentId().equals(s.occupant().agentId())).isEmpty(),
						"no pc.seat for a meeting chair");
				}
				// Meeting seats never count toward maxSeated (2): a third agent may still sit at a PC.
				String pcId = desk(helper, new BlockPos(2, 1, 12), Direction.EAST);
				PcStates.put(info(pcId, "running"));
				Map<String, Object> reply = service.seat(new AgentSeat(cleo.agentId(), jobId("pc"), 2, SeatTarget.pc(pcId), null));
				same(helper, reply.get("status"), "running", "a PC seat beside two meeting seats is not over the cap");
				cleo.jobs().cancel("test");
				// A repeated request for a seated attendee keeps its chair (its claim holds while it sits).
				BlockPos before = ((SeatEntity)bram.getVehicle()).chairPos();
				service.seat(new AgentSeat(bram.agentId(), jobId("meet"), 1, SeatTarget.meeting("m-standup"), null));
				same(helper, ((dev.minevibe.agent.skill.seat.SeatJob)bram.jobs().current()).chair().pos(), before, "the same chair again");
				service.unseat(new AgentUnseat(ada.agentId(), 1, "stand", false));
				helper.assertTrue(recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> ada.agentId().equals(s.occupant().agentId())).isEmpty(),
					"standing up from a meeting chair sends no pc.unseat");
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ helpers

	/** A desk with its chair at {@code rel} (main lower block), bound to a fresh PC id; removed quietly at the end. */
	private static String desk(final GameTestHelper helper, final BlockPos rel, final Direction facing) {
		ServerLevel level = helper.getLevel();
		String pcId = "gt-" + Long.toString(ThreadLocalRandom.current().nextLong(36L * 36 * 36 * 36 * 36), 36);
		BlockPos origin = helper.absolutePos(rel);
		helper.assertTrue(PcWorkstation.canPlace(level, origin, facing), "room for a desk at " + rel.toShortString());
		helper.assertTrue(PcWorkstation.place(level, origin, facing, "linux", pcId) != null, "desk placed");
		onTestEnd(helper, () -> {
			PcWorkstation.removeQuietly(level, origin);
			PcSeatRegistry.INSTANCE.clearStatus(pcId);
		});
		return pcId;
	}

	private static Pc.PcInfo info(final String pcId, final String status) {
		return new Pc.PcInfo(pcId, "linux", pcId, status, null, null, SLOTS.incrementAndGet(), 2, 4096, 64, true, false, false, List.of(), null, null, null,
			null, null);
	}

	private static boolean listed(final JsonObject pcs, final String pcId, final String occupant) {
		JsonArray arr = pcs.getAsJsonArray("pcs");
		for (JsonElement e : arr) {
			JsonObject o = e.getAsJsonObject();
			if (pcId.equals(o.get("pcId").getAsString())) {
				return occupant.equals(o.get("occupant").getAsString()) && "running".equals(o.get("status").getAsString()) && o.has("chair");
			}
		}
		return false;
	}

	/** Like {@code assertValueEqual}, but a null value fails the test instead of crashing the test server. */
	private static void same(final GameTestHelper helper, final Object actual, final Object expected, final String what) {
		helper.assertTrue(java.util.Objects.equals(actual, expected), what + ": expected " + expected + ", got " + actual);
	}

	private static void expectError(final GameTestHelper helper, final String code, final Runnable call) {
		try {
			call.run();
		} catch (BridgeException e) {
			same(helper, e.code(), code, "error code (" + e.getMessage() + ")");
			return;
		}
		helper.fail("expected " + code);
	}
}
