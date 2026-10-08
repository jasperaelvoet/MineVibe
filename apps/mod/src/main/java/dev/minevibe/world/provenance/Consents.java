package dev.minevibe.world.provenance;

import java.security.SecureRandom;
import java.util.Collection;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * Player consent for changing protected blocks, made so that a model can never authorize itself:
 *
 * <ol>
 *   <li>When a skill refuses a protected block ({@code PROTECTED}), the mod {@linkplain #offer offers} a consent request:
 *       an unguessable token bound to that agent, that dimension and the box of the protected blocks it met, valid for
 *       {@value #TTL_MS} ms. The token goes to Node in the failure ({@code result.protected.consentId}).</li>
 *   <li>Node keeps it and attaches it to a later {@code skill.run} as the top-level {@code consent{token}} field, only
 *       after the player explicitly agreed. That field is outside {@code args}, so nothing a model writes into a tool
 *       call can carry it; {@code args.allow_protected} alone does nothing.</li>
 *   <li>{@link #redeem} takes the token once (same agent, not expired); the job then runs with a {@linkplain #activate
 *       grant} that {@link Protection} honours inside that box only, until the job ends.</li>
 * </ol>
 * Server thread.
 */
public final class Consents {
	public static final long TTL_MS = 10 * 60_000L;
	private static final int MAX_REQUESTS = 64;
	private static final SecureRandom RANDOM = new SecureRandom();

	/** An offered consent: who may change what, until when. */
	public record Request(String token, String agentId, ResourceKey<Level> dim, BoundingBox box, long expiresAtMs) {
		public boolean covers(final ResourceKey<Level> d, final BlockPos pos) {
			return this.dim == d && this.box.isInside(pos);
		}
	}

	/** A redeemed consent, active while its job runs. */
	public record Grant(Request request, String jobId) {
	}

	private static final Map<String, Request> REQUESTS = new LinkedHashMap<>();
	private static final Map<String, Grant> ACTIVE = new HashMap<>();

	private Consents() {
	}

	/** A token (32 hex characters) for changing {@code positions} as {@code agentId}; null when there are none. */
	public static @Nullable String offer(final String agentId, final ServerLevel level, final Collection<BlockPos> positions) {
		return offer(agentId, level.dimension(), positions);
	}

	public static @Nullable String offer(final String agentId, final ResourceKey<Level> dim, final Collection<BlockPos> positions) {
		if (positions.isEmpty()) {
			return null;
		}
		BoundingBox box = BoundingBox.encapsulatingPositions(positions).orElseThrow();
		byte[] bytes = new byte[16];
		RANDOM.nextBytes(bytes);
		String token = HexFormat.of().formatHex(bytes);
		prune();
		REQUESTS.put(token, new Request(token, agentId.toLowerCase(Locale.ROOT), dim, box, System.currentTimeMillis() + TTL_MS));
		while (REQUESTS.size() > MAX_REQUESTS) {
			Iterator<String> it = REQUESTS.keySet().iterator();
			it.next();
			it.remove();
		}
		return token;
	}

	/** Takes the request behind {@code token} if it was offered to {@code agentId} and has not expired; else null. */
	public static @Nullable Request redeem(final String agentId, final String token) {
		prune();
		Request r = REQUESTS.get(token);
		if (r == null || !r.agentId().equals(agentId.toLowerCase(Locale.ROOT))) {
			return null;
		}
		REQUESTS.remove(token);
		return r;
	}

	/** Lets {@code agentId}'s job {@code jobId} change the protected blocks in {@code request}'s box. */
	public static void activate(final String agentId, final Request request, final String jobId) {
		ACTIVE.put(agentId.toLowerCase(Locale.ROOT), new Grant(request, jobId));
	}

	/** Ends the grant of job {@code jobId} (no-op for another job's). */
	public static void deactivate(final String agentId, final String jobId) {
		Grant g = ACTIVE.get(agentId.toLowerCase(Locale.ROOT));
		if (g != null && g.jobId().equals(jobId)) {
			ACTIVE.remove(agentId.toLowerCase(Locale.ROOT));
		}
	}

	public static @Nullable Grant active(final String agentId) {
		return ACTIVE.get(agentId.toLowerCase(Locale.ROOT));
	}

	/** True while a job of {@code agentId} holds a grant covering {@code pos}. */
	public static boolean covers(final String agentId, final ResourceKey<Level> dim, final BlockPos pos) {
		Grant g = ACTIVE.get(agentId.toLowerCase(Locale.ROOT));
		return g != null && g.request().covers(dim, pos);
	}

	public static void reset() {
		REQUESTS.clear();
		ACTIVE.clear();
	}

	private static void prune() {
		long now = System.currentTimeMillis();
		REQUESTS.values().removeIf(r -> r.expiresAtMs() < now);
	}
}
