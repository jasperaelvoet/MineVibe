package dev.minevibe.client.ui;

import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.msg.Ui;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * One crew member as the client UI knows it: identity from {@code crew.state}, brain indicator and toggles from
 * {@code agent.brain}, and cards from {@code agent.pending}. Client thread only (owned by {@link UiState}).
 */
public final class AgentView {
	private final String agentId;
	private final UUID uuid;
	private String handle;
	private String name;
	private String role = "engineer";
	private boolean ceo;
	private String status = "alive";
	private String model = "haiku";
	private String brain = "idle";
	private @Nullable String activity;
	private String autonomy = "listen";
	private boolean planFirst;
	private boolean pingInstead;
	private List<Ui.PendingCard> cards = List.of();

	AgentView(String agentId, String handle, String name) {
		this.agentId = agentId;
		this.uuid = AgentService.uuidFor(agentId);
		this.handle = handle;
		this.name = name;
	}

	void identity(String handle, String name, String role, boolean ceo, String status) {
		this.handle = handle;
		this.name = name;
		this.role = role;
		this.ceo = ceo;
		this.status = status;
	}

	void brain(Ui.AgentBrain b) {
		this.model = b.model();
		this.brain = b.status();
		this.activity = b.activity();
		this.autonomy = b.autonomy();
		this.planFirst = b.planFirst();
		this.pingInstead = b.pingInstead();
	}

	void cards(List<Ui.PendingCard> cards) {
		this.cards = List.copyOf(cards);
	}

	public String agentId() {
		return agentId;
	}

	/** The body's player UUID ({@link AgentService#uuidFor}). */
	public UUID uuid() {
		return uuid;
	}

	public String handle() {
		return handle;
	}

	public String name() {
		return name;
	}

	public String role() {
		return role;
	}

	public boolean ceo() {
		return ceo;
	}

	/** {@code alive}, {@code dead} or {@code dismissed}. */
	public String status() {
		return status;
	}

	public boolean alive() {
		return "alive".equals(status);
	}

	/** {@code haiku} or {@code opus}. */
	public String model() {
		return model;
	}

	/** {@code idle}, {@code thinking}, {@code queued}, {@code waiting_player}, {@code asleep} or {@code offline}. */
	public String brain() {
		return brain;
	}

	public @Nullable String activity() {
		return activity;
	}

	public String autonomy() {
		return autonomy;
	}

	public boolean planFirst() {
		return planFirst;
	}

	public boolean pingInstead() {
		return pingInstead;
	}

	public List<Ui.PendingCard> cards() {
		return cards;
	}

	/** The card a reply to this agent answers (PLAN §6.4 "Front card"), or null. */
	public Ui.@Nullable PendingCard frontCard() {
		return FrontCards.front(cards);
	}

	/** This agent is the ApproachQueue presenter: one of its cards is being presented to the player. */
	public boolean presenting() {
		for (Ui.PendingCard card : cards) {
			if (card.presenting() && !card.parked()) return true;
		}
		return false;
	}

	/** The name-tag suffix: {@code [H]} on Haiku, {@code [O]} on Opus. */
	public String modelSuffix() {
		return "opus".equals(model) ? "[O]" : "[H]";
	}

	/** "Ada (CEO)", "Bram (engineer)". */
	public String title() {
		return name + " (" + (ceo ? "CEO" : role) + ")";
	}
}
