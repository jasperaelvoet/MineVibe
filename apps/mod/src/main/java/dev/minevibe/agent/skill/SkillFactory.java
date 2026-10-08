package dev.minevibe.agent.skill;

import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import dev.minevibe.agent.job.BuildJob;
import dev.minevibe.agent.job.CraftJobs;
import dev.minevibe.agent.job.FarmJob;
import dev.minevibe.agent.job.GatherJobs;
import dev.minevibe.agent.job.GotoSkillJob;
import dev.minevibe.agent.job.MenuJobs;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.job.WorldJobs;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Skills.Args;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.util.List;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.Item;
import org.jspecify.annotations.Nullable;

/**
 * Turns {@code skill.run{skill, args}} into a job (PLAN 7.4). Node validates {@code args} against
 * {@code SkillArgs[skill]} before sending; the mod checks them again (a request can come from anywhere) and answers
 * {@code UNKNOWN_SKILL} / {@code BAD_ARGS}.
 */
public final class SkillFactory {
	private static final int MAX_COUNT = 2304;

	private SkillFactory() {
	}

	public static SkillJob create(final String skill, final JsonObject args) {
		if (!Skills.SKILL_NAMES.contains(skill)) {
			throw new BridgeException(Codes.UNKNOWN_SKILL, "unknown skill " + skill);
		}
		try {
			return switch (skill) {
				case "goto" -> {
					Args.Goto a = read(args, Args.Goto.class);
					if ((a.pos() == null) == (a.entity() == null)) {
						throw Refs.badArgs("goto needs exactly one of pos, entity");
					}
					yield new GotoSkillJob(pos(a.pos()), a.entity(), range(a.range(), 1.5, 64.0));
				}
				case "mine" -> {
					Args.Mine a = read(args, Args.Mine.class);
					yield new GatherJobs.Mine(Refs.block(required(a.block(), "block")), count(a.count()), pos(a.near()), radius(a.radius(), 24, 64));
				}
				case "collect" -> {
					Args.Collect a = read(args, Args.Collect.class);
					yield new GatherJobs.Collect(Refs.item(required(a.item(), "item")), count(a.count()), radius(a.radius(), 24, 64), Boolean.TRUE.equals(a.replant()));
				}
				case "hunt" -> {
					Args.Hunt a = read(args, Args.Hunt.class);
					String ref = required(a.entity(), "entity");
					EntityType<?> type = Refs.entityType(ref);
					if (type == null || type == net.minecraft.world.entity.EntityTypes.PLAYER) {
						throw Refs.badArgs("hunt needs a mob type such as minecraft:cow, not " + ref);
					}
					yield new GatherJobs.Hunt(type, ref, Math.max(1, Math.min(64, a.count())), radius(a.radius(), 32, 64));
				}
				case "dig" -> {
					Args.Dig a = read(args, Args.Dig.class);
					BlockPos from = pos(required(a.from(), "from"));
					BlockPos to = pos(required(a.to(), "to"));
					if (GatherJobs.Dig.volume(from, to) > GatherJobs.Dig.MAX_BLOCKS) {
						throw Refs.badArgs("dig is limited to " + GatherJobs.Dig.MAX_BLOCKS + " blocks at a time");
					}
					yield new GatherJobs.Dig(from, to);
				}
				case "place" -> {
					Args.Place a = read(args, Args.Place.class);
					yield new WorldJobs.Place(Refs.item(required(a.block(), "block")), pos(required(a.pos(), "pos")));
				}
				case "use_block" -> new WorldJobs.UseBlock(pos(required(read(args, Args.UseBlock.class).pos(), "pos")));
				case "use_item" -> {
					Args.UseItem a = read(args, Args.UseItem.class);
					if (a.pos() != null && a.entity() != null) {
						throw Refs.badArgs("use_item takes pos or entity, not both");
					}
					yield new WorldJobs.UseItem(a.item() == null ? null : Refs.item(a.item()), pos(a.pos()), a.entity());
				}
				case "attack" -> new WorldJobs.Attack(required(read(args, Args.Attack.class).entity(), "entity"));
				case "equip" -> {
					Args.Equip a = read(args, Args.Equip.class);
					if (a.slot() != null && !List.of("mainhand", "offhand", "head", "chest", "legs", "feet").contains(a.slot())) {
						throw Refs.badArgs("unknown slot " + a.slot());
					}
					yield new WorldJobs.Equip(Refs.item(required(a.item(), "item")), a.slot());
				}
				case "eat" -> {
					Args.Eat a = read(args, Args.Eat.class);
					yield new WorldJobs.Eat(a.item() == null ? null : Refs.item(a.item()));
				}
				case "sleep" -> new WorldJobs.Sleep(pos(read(args, Args.Sleep.class).pos()));
				case "pickup" -> {
					Args.Pickup a = read(args, Args.Pickup.class);
					yield new GatherJobs.Pickup(a.item() == null ? null : Refs.item(a.item()), radius(a.radius(), 8, 32));
				}
				case "drop" -> {
					Args.Drop a = read(args, Args.Drop.class);
					yield new WorldJobs.Drop(Refs.item(required(a.item(), "item")), a.count() == null ? 0 : count(a.count()));
				}
				case "give" -> {
					Args.Give a = read(args, Args.Give.class);
					yield new WorldJobs.Give(Refs.item(required(a.item(), "item")), count(a.count()), required(a.to(), "to"));
				}
				case "craft" -> {
					Args.Craft a = read(args, Args.Craft.class);
					Refs.ItemMatcher m = Refs.item(required(a.item(), "item"));
					Item item = m.item();
					if (item == null) {
						throw Refs.badArgs("craft needs one item, not a tag: " + a.item());
					}
					yield new CraftJobs.Craft(item, count(a.count()), pos(a.table()));
				}
				case "smelt" -> {
					Args.Smelt a = read(args, Args.Smelt.class);
					yield new CraftJobs.Smelt(Refs.item(required(a.item(), "item")), count(a.count()), a.fuel() == null ? null : Refs.item(a.fuel()), pos(a.furnace()));
				}
				case "container" -> {
					Args.Container a = read(args, Args.Container.class);
					String action = required(a.action(), "action");
					if (!List.of("list", "put", "take").contains(action)) {
						throw Refs.badArgs("container action is list, put or take");
					}
					if (!"list".equals(action) && a.item() == null) {
						throw Refs.badArgs("put and take need item");
					}
					yield new MenuJobs.Container(pos(required(a.pos(), "pos")), action, a.item() == null ? null : Refs.item(a.item()), a.count() == null ? 0 : count(a.count()));
				}
				case "open_menu" -> {
					Args.OpenMenu a = read(args, Args.OpenMenu.class);
					if ((a.pos() == null) == (a.entity() == null)) {
						throw Refs.badArgs("open_menu needs exactly one of pos, entity");
					}
					yield new MenuJobs.OpenMenu(pos(a.pos()), a.entity());
				}
				case "menu_click" -> {
					Args.MenuClick a = read(args, Args.MenuClick.class);
					ContainerInput input = switch (required(a.type(), "type")) {
						case "pickup" -> ContainerInput.PICKUP;
						case "quick_move" -> ContainerInput.QUICK_MOVE;
						case "swap" -> ContainerInput.SWAP;
						case "clone" -> ContainerInput.CLONE;
						case "throw" -> ContainerInput.THROW;
						case "quick_craft" -> ContainerInput.QUICK_CRAFT;
						case "pickup_all" -> ContainerInput.PICKUP_ALL;
						default -> throw Refs.badArgs("unknown click type " + a.type());
					};
					if (a.slot() < -999 || a.slot() > 255 || a.button() < 0 || a.button() > 40) {
						throw Refs.badArgs("slot or button out of range");
					}
					yield new MenuJobs.MenuClick(a.slot(), a.button(), input);
				}
				case "menu_close" -> new MenuJobs.MenuClose();
				case "build" -> {
					Args.Build a = read(args, Args.Build.class);
					String bp = required(a.blueprint(), "blueprint").toLowerCase(Locale.ROOT);
					if (!BuildJob.BLUEPRINTS.contains(bp)) {
						throw new BridgeException("UNKNOWN_BLUEPRINT", "unknown blueprint " + a.blueprint() + "; built-in: " + String.join(", ", BuildJob.BLUEPRINTS));
					}
					int rot = a.rotation() == null ? 0 : a.rotation();
					if (rot % 90 != 0) {
						throw Refs.badArgs("rotation is 0, 90, 180 or 270");
					}
					yield new BuildJob(bp, pos(required(a.origin(), "origin")), rot);
				}
				case "farm" -> {
					Args.Farm a = read(args, Args.Farm.class);
					BlockPos from = pos(required(a.from(), "from"));
					BlockPos to = pos(required(a.to(), "to"));
					// Longs: int coordinates far apart would overflow the difference and pass the check.
					if (Math.abs((long)from.getX() - to.getX()) >= FarmJob.MAX_SIDE || Math.abs((long)from.getZ() - to.getZ()) >= FarmJob.MAX_SIDE
						|| Math.abs((long)from.getY() - to.getY()) > 4) {
						throw Refs.badArgs("a farm is at most " + FarmJob.MAX_SIDE + "x" + FarmJob.MAX_SIDE + " and 4 blocks high");
					}
					Refs.ItemMatcher crop = a.crop() == null ? null : Refs.item(a.crop());
					if (crop != null && crop.item() != null && !FarmJob.isSeed(crop.item())) {
						// Anything else would be "planted" as a block on the farmland (dirt, torches...).
						throw Refs.badArgs("crop is a seed item (wheat_seeds, carrot, potato, beetroot_seeds), not " + a.crop());
					}
					yield new FarmJob(from, to, crop);
				}
				case "ride" -> new WorldJobs.Ride(required(read(args, Args.Ride.class).entity(), "entity"));
				case "dismount" -> new WorldJobs.Dismount();
				case "emote" -> {
					String kind = required(read(args, Args.Emote.class).kind(), "kind");
					if (!List.of("wave", "nod", "shake_head", "point", "cheer", "facepalm").contains(kind)) {
						throw Refs.badArgs("unknown emote " + kind);
					}
					yield new WorldJobs.Emote(kind);
				}
				default -> throw new BridgeException(Codes.UNKNOWN_SKILL, "unknown skill " + skill);
			};
		} catch (JsonParseException | IllegalStateException | ClassCastException | UnsupportedOperationException e) {
			throw Refs.badArgs(skill + ": " + e.getMessage());
		}
	}

	private static <T> T read(final JsonObject args, final Class<T> type) {
		T value = ProtocolCodec.GSON.fromJson(args, type);
		if (value == null) {
			throw Refs.badArgs("args missing");
		}
		return value;
	}

	private static <T> T required(final @Nullable T value, final String name) {
		if (value == null) {
			throw Refs.badArgs(name + " is required");
		}
		return value;
	}

	private static @Nullable BlockPos pos(final Messages.@Nullable BlockPos p) {
		return p == null ? null : Refs.pos(p);
	}

	private static int count(final int count) {
		if (count < 1 || count > MAX_COUNT) {
			throw Refs.badArgs("count must be 1-" + MAX_COUNT);
		}
		return count;
	}

	private static int radius(final @Nullable Integer radius, final int dflt, final int max) {
		if (radius == null) {
			return dflt;
		}
		if (radius < 1 || radius > max) {
			throw Refs.badArgs("radius must be 1-" + max);
		}
		return radius;
	}

	private static double range(final @Nullable Double range, final double dflt, final double max) {
		if (range == null) {
			return dflt;
		}
		if (range < 0 || range > max) {
			throw Refs.badArgs("range must be 0-" + max);
		}
		return range;
	}
}
