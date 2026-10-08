package dev.minevibe.client.org;

import dev.minevibe.bridge.protocol.Messages;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Who is in the crew, for the calendar's assignee checklist, chip colours and the meeting HUD's names. Two sources,
 * merged: Node's crew list (names, handles, the CEO, status), read from the UI's {@code UiState} (which owns the
 * {@code crew.state} push: one bridge handler per type), and the agent bodies the integrated server has right now (dev
 * bodies Node does not know). Client thread only.
 */
public final class CrewDirectory {
	public record Member(String agentId, String name, @Nullable String handle, @Nullable String role, boolean ceo, String status) {
		public boolean alive() {
			return "alive".equals(this.status);
		}
	}

	private static final Comparator<Member> ORDER = Comparator.comparing((Member m) -> !m.ceo())
		.thenComparing(m -> m.name().toLowerCase(Locale.ROOT))
		.thenComparing(Member::agentId);

	private final Map<String, Member> fromNode = new LinkedHashMap<>();
	private final Map<String, Member> fromBodies = new LinkedHashMap<>();

	public void setNodeCrew(final List<Messages.CrewMember> crew) {
		this.setNodeMembers(crew.stream().map(m -> new Member(m.agentId(), m.name(), m.handle(), m.role(), m.ceo(), m.status())).toList());
	}

	/** Node's crew list, as the UI state holds it ({@code crew.state}). */
	public void setNodeMembers(final List<Member> crew) {
		this.fromNode.clear();
		for (Member m : crew) {
			this.fromNode.put(m.agentId(), m);
		}
	}

	public void setBodies(final List<Member> bodies) {
		this.fromBodies.clear();
		for (Member m : bodies) {
			this.fromBodies.put(m.agentId(), m);
		}
	}

	/** Everyone known, the CEO first, then by name. Node's entry wins when both sources know an agent. */
	public List<Member> members() {
		Map<String, Member> merged = new LinkedHashMap<>(this.fromBodies);
		merged.putAll(this.fromNode);
		List<Member> list = new ArrayList<>(merged.values());
		list.sort(ORDER);
		return list;
	}

	public List<Member> alive() {
		return this.members().stream().filter(Member::alive).toList();
	}

	/** Agent ids in display order (chip colours follow it). */
	public List<String> order() {
		return this.members().stream().map(Member::agentId).toList();
	}

	/** The agent's name, or its id when nobody told us. */
	public String name(final String agentId) {
		Member m = this.fromNode.get(agentId);
		if (m == null) {
			m = this.fromBodies.get(agentId);
		}
		return m == null ? agentId : m.name();
	}
}
