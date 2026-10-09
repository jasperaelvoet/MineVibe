package dev.minevibe.client.pc.screen;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.pc.PcBridge;
import dev.minevibe.pc.PcStates;
import dev.minevibe.pc.WorkstationItem;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractSliderButton;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Prediction;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * PcConfigScreen (PLAN 7.8, 8.2, 8.3): one PC's resources, Vault folders and lifecycle.
 *
 * <ul>
 *   <li>vCPU and RAM sliders clamped to what the host budget has free ({@link PcBudgetMath}); above the comfortable
 *       CPU count the slider warns about overcommit. {@code linux} / {@code linux-slim} is a type switch. Apply sends
 *       {@code pc.config}; a resize or type change recreates the PC (the screen says so).</li>
 *   <li>Linux PCs: <b>KVM</b> (nested virtualization; changing it recreates the PC) and <b>Android</b> (a phone next to the
 *       PC; applying starts or removes it, off deletes its apps), each greyed out with the reason when this Mac cannot
 *       have it, plus the phone's status line (PLAN §8.7).</li>
 *   <li>Host budget bars (vCPU, RAM pool, free disk) and macOS slots {@code n/2}.</li>
 *   <li>The Vault: each folder read-write or read-only, removable; <b>Browse…</b> asks the app for a native folder
 *       picker ({@code host.pick_folder}); new folders start read-only, and the screen says plainly what read-write
 *       means.</li>
 *   <li>Start, Stop, Restart, Reimage, Watch, Decommission (confirmed), Kick (an agent at the PC), Re-issue item (an
 *       unplugged PC).</li>
 *   <li>A pending download consent ({@code pc.state.consent}) shows as a modal: Download / Not now
 *       ({@code pc.consent}).</li>
 * </ul>
 * Non-pausing. Replies arrive on bridge threads and are applied on the client thread.
 */
public final class PcConfigScreen extends Screen {
	private static final int ROW = 22;
	/** Vault rows shown with their buttons: up to 4 on tall screens, 1 on the smallest (the rest is "+n more"). */
	private int mountsShown() {
		return Math.min(this.draftMounts.size(), this.height >= 330 ? 4 : this.height >= 280 ? 2 : 1);
	}

	private final String pcId;
	private int draftCpus;
	private int draftMemoryMiB;
	private String draftType = "linux";
	private boolean draftVirtualization;
	private boolean draftAndroid;
	/** Widget rows of the left column above the budget bars (set by {@link #init}). */
	private int leftRows = 4;
	private List<Pc.VaultMount> draftMounts = new ArrayList<>();
	private boolean draftLoaded;
	private long seenVersion = -1;
	private @Nullable String consentShown;
	private Component status = Component.empty();
	private int statusColor = 0xFF9CA3AF;
	private boolean busy;

	private @Nullable Button applyButton;
	private final List<Button> lifecycle = new ArrayList<>();

	public PcConfigScreen(final String pcId) {
		super(Component.translatable("screen.minevibe.pc.config"));
		this.pcId = pcId;
	}

	public String pcId() {
		return this.pcId;
	}

	private Pc.@Nullable PcInfo info() {
		return PcStates.get(this.pcId);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	private void loadDraft(final Pc.PcInfo info) {
		this.draftCpus = info.cpus();
		this.draftMemoryMiB = info.memoryMiB();
		this.draftType = info.type();
		this.draftVirtualization = virtualizationOn(info);
		this.draftAndroid = androidOn(info);
		this.draftMounts = new ArrayList<>(info.mounts());
		this.draftLoaded = true;
	}

	private static boolean virtualizationOn(final Pc.PcInfo info) {
		return PcCapabilityText.virtualizationOn(info);
	}

	private static boolean androidOn(final Pc.PcInfo info) {
		return PcCapabilityText.androidOn(info);
	}

	/** Changes that recreate the PC (the screen warns about them). */
	private boolean resourcesChanged(final Pc.PcInfo info) {
		return this.draftCpus != info.cpus()
				|| this.draftMemoryMiB != info.memoryMiB()
				|| !this.draftType.equals(info.type())
				|| this.draftVirtualization != virtualizationOn(info);
	}

	/** The Android phone was switched (no recreate: the phone starts or goes next to the PC). */
	private boolean androidChanged(final Pc.PcInfo info) {
		return this.draftAndroid != androidOn(info);
	}

	private boolean mountsChanged(final Pc.PcInfo info) {
		return !this.draftMounts.equals(info.mounts());
	}

	// -----------------------------------------------------------------------------------------
	// Widgets
	// -----------------------------------------------------------------------------------------

	@Override
	protected void init() {
		this.lifecycle.clear();
		Pc.PcInfo info = this.info();
		this.seenVersion = PcStates.version();
		int colW = Math.min(200, (this.width - 30) / 2);
		int left = this.width / 2 - colW - 5;
		int right = this.width / 2 + 5;
		int top = 34;
		if (info == null) {
			this.addRenderableWidget(Button.builder(Component.translatable("gui.done"), b -> this.onClose()).bounds(this.width / 2 - 50, this.height - 28, 100, 20).build());
			return;
		}
		if (!this.draftLoaded) {
			this.loadDraft(info);
		}
		Pc.Budget budget = PcStates.budget();

		// Resources (left column).
		int maxCpus = PcBudgetMath.maxCpus(info, budget);
		int comfortable = PcBudgetMath.comfortableCpus(info, budget);
		this.addRenderableWidget(new AbstractSliderButton(left, top, colW, 20, Component.empty(), PcBudgetMath.position(this.draftCpus, PcBudgetMath.MIN_CPUS, maxCpus)) {
			{
				this.updateMessage();
			}

			@Override
			protected void updateMessage() {
				int cpus = PcBudgetMath.cpusAt(this.value, maxCpus);
				boolean over = cpus > comfortable;
				this.setMessage(Component.translatable(over ? "screen.minevibe.pc.cpus.over" : "screen.minevibe.pc.cpus", cpus, maxCpus));
			}

			@Override
			protected void applyValue() {
				PcConfigScreen.this.draftCpus = PcBudgetMath.cpusAt(this.value, maxCpus);
				PcConfigScreen.this.refreshButtons();
			}
		});
		int maxMemory = PcBudgetMath.maxMemoryMiB(info, budget);
		this.addRenderableWidget(new AbstractSliderButton(left, top + ROW, colW, 20, Component.empty(), PcBudgetMath.position(this.draftMemoryMiB, PcBudgetMath.MIN_MEMORY_MIB, maxMemory)) {
			{
				this.updateMessage();
			}

			@Override
			protected void updateMessage() {
				int mib = PcBudgetMath.memoryAt(this.value, maxMemory);
				this.setMessage(Component.translatable("screen.minevibe.pc.memory", gib(mib), gib(maxMemory)));
			}

			@Override
			protected void applyValue() {
				PcConfigScreen.this.draftMemoryMiB = PcBudgetMath.memoryAt(this.value, maxMemory);
				PcConfigScreen.this.refreshButtons();
			}
		});
		int row = top + 2 * ROW;
		if (!"macos".equals(info.type())) {
			this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.type", this.draftType), b -> {
				this.draftType = "linux".equals(this.draftType) ? "linux-slim" : "linux";
				b.setMessage(Component.translatable("screen.minevibe.pc.type", this.draftType));
				this.refreshButtons();
			}).bounds(left, row, colW, 20).tooltip(Tooltip.create(Component.translatable("screen.minevibe.pc.type.tooltip"))).build());
			row += ROW;
		}
		Pc.Capabilities caps = info.capabilities();
		if (caps != null) {
			// Two toggles on one row: nested virtualization and the Android phone (PLAN §8.7).
			int half = (colW - 4) / 2;
			String virtWhy = caps.virtualization().unavailable();
			Button virt = this.addRenderableWidget(Button.builder(toggleLabel("screen.minevibe.pc.virt", this.draftVirtualization), b -> {
				this.draftVirtualization = !this.draftVirtualization;
				b.setMessage(toggleLabel("screen.minevibe.pc.virt", this.draftVirtualization));
				this.refreshButtons();
			}).bounds(left, row, half, 20).tooltip(Tooltip.create(virtWhy != null
					? Component.translatable("screen.minevibe.pc.virt.unavailable", virtWhy)
					: Component.translatable("screen.minevibe.pc.virt.tooltip"))).build());
			// A Mac that cannot have it may still turn it off.
			virt.active = virtWhy == null || this.draftVirtualization;
			String androidWhy = caps.android().unavailable();
			Button phone = this.addRenderableWidget(Button.builder(toggleLabel("screen.minevibe.pc.android", this.draftAndroid), b -> {
				this.draftAndroid = !this.draftAndroid;
				b.setMessage(toggleLabel("screen.minevibe.pc.android", this.draftAndroid));
				this.refreshButtons();
			}).bounds(left + half + 4, row, colW - half - 4, 20).tooltip(Tooltip.create(androidWhy != null
					? Component.translatable("screen.minevibe.pc.android.unavailable", androidWhy)
					: Component.translatable("screen.minevibe.pc.android.tooltip"))).build());
			phone.active = androidWhy == null || this.draftAndroid;
			row += ROW;
		}
		this.leftRows = (row - top) / ROW + 1;
		this.applyButton = this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.apply"), b -> this.apply())
			.bounds(left, row, colW, 20)
			.tooltip(Tooltip.create(Component.translatable("screen.minevibe.pc.apply.tooltip")))
			.build());

		// Vault (right column).
		int vaultTop = top;
		int shown = this.mountsShown();
		for (int i = 0; i < shown; i++) {
			final int index = i;
			Pc.VaultMount mount = this.draftMounts.get(i);
			int y = vaultTop + 12 + i * ROW;
			this.addRenderableWidget(Button.builder(Component.literal(mount.mode()), b -> {
				Pc.VaultMount m = this.draftMounts.get(index);
				this.draftMounts.set(index, new Pc.VaultMount(m.hostPath(), "rw".equals(m.mode()) ? "ro" : "rw"));
				this.rebuildWidgets();
			}).bounds(right + colW - 46, y, 24, 20).tooltip(Tooltip.create(Component.translatable("screen.minevibe.pc.vault.mode"))).build());
			this.addRenderableWidget(Button.builder(Component.literal("×"), b -> {
				this.draftMounts.remove(index);
				this.rebuildWidgets();
			}).bounds(right + colW - 20, y, 20, 20).build());
		}
		int browseY = vaultTop + 12 + shown * ROW;
		this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.vault.browse"), b -> this.browse())
			.bounds(right, browseY, colW, 20)
			.build()).active = this.draftMounts.size() < 16;

		// Lifecycle (right column, below the Vault).
		// Room under Browse for the two-line read-write warning.
		// Two buttons a row; the order of `lifecycle` is what refreshButtons() relies on.
		int ly = browseY + ROW + 22;
		int bw = (colW - 4) / 2;
		int col2 = right + bw + 4;
		this.lifecycle.add(this.action(right, ly, bw, "start", "screen.minevibe.pc.start"));
		this.lifecycle.add(this.action(col2, ly, bw, "stop", "screen.minevibe.pc.stop"));
		this.lifecycle.add(this.action(right, ly + ROW, bw, "restart", "screen.minevibe.pc.restart"));
		this.lifecycle.add(this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.reimage"), b -> this.confirm("reimage"))
			.bounds(right, ly + 2 * ROW, bw, 20).build()));
		this.lifecycle.add(this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.watch"), b -> this.minecraft.gui.setScreen(new PcWatchScreen(this.pcId)))
			.bounds(col2, ly + ROW, bw, 20).build()));
		this.lifecycle.add(this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.decommission"), b -> this.confirm("decommission"))
			.bounds(col2, ly + 2 * ROW, bw, 20).build()));
		this.lifecycle.add(this.action(right, ly + 3 * ROW, bw, "kick", "screen.minevibe.pc.kick"));
		this.lifecycle.add(this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.reissue"), b -> this.reissue())
			.bounds(col2, ly + 3 * ROW, bw, 20).build()));

		this.addRenderableWidget(Button.builder(Component.translatable("gui.done"), b -> this.onClose()).bounds(this.width / 2 - 50, this.height - 26, 100, 20).build());
		this.refreshButtons();
	}

	private Button action(final int x, final int y, final int w, final String action, final String key) {
		return this.addRenderableWidget(Button.builder(Component.translatable(key), b -> this.run(action)).bounds(x, y, w, 20).build());
	}

	/** Enables what makes sense for the PC's status (re-run on every {@code pc.state}). */
	private void refreshButtons() {
		Pc.PcInfo info = this.info();
		if (info == null) {
			return;
		}
		if (this.applyButton != null) {
			this.applyButton.active = !this.busy && (this.resourcesChanged(info) || this.mountsChanged(info) || this.androidChanged(info));
		}
		String s = info.status();
		boolean on = PcBudgetMath.isActive(s);
		boolean agentSeated = info.occupant() != null && !info.occupant().isPlayer();
		for (Button b : this.lifecycle) {
			b.active = !this.busy;
		}
		if (this.lifecycle.size() == 8) {
			this.lifecycle.get(0).active &= !on && info.plugged();
			this.lifecycle.get(1).active &= on;
			this.lifecycle.get(2).active &= "running".equals(s);
			this.lifecycle.get(3).active &= !"reimaging".equals(s);
			this.lifecycle.get(4).active &= "running".equals(s);
			this.lifecycle.get(6).active &= agentSeated;
			this.lifecycle.get(7).active &= !info.plugged();
		}
	}

	@Override
	public void tick() {
		Pc.PcInfo info = this.info();
		if (info != null && info.consent() != null && !info.consent().consentId().equals(this.consentShown)) {
			this.consentShown = info.consent().consentId();
			this.minecraft.gui.setScreen(new PcConsentScreen(this, this.pcId, info.consent()));
			return;
		}
		if (PcStates.version() != this.seenVersion) {
			this.seenVersion = PcStates.version();
			if (info != null && !this.draftLoaded) {
				this.rebuildWidgets();
			}
			this.refreshButtons();
		}
	}

	// -----------------------------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------------------------

	private void apply() {
		Pc.PcInfo info = this.info();
		if (info == null) {
			return;
		}
		Integer cpus = this.draftCpus != info.cpus() ? this.draftCpus : null;
		Integer memory = this.draftMemoryMiB != info.memoryMiB() ? this.draftMemoryMiB : null;
		String type = !this.draftType.equals(info.type()) ? this.draftType : null;
		List<Pc.VaultMount> mounts = this.mountsChanged(info) ? List.copyOf(this.draftMounts) : null;
		Boolean virtualization = this.draftVirtualization != virtualizationOn(info) ? this.draftVirtualization : null;
		Boolean android = this.androidChanged(info) ? this.draftAndroid : null;
		Pc.PcConfig config = new Pc.PcConfig(this.pcId, null, type, cpus, memory, mounts, null, null, virtualization, android);
		this.track(PcBridge.request(Pc.PC_CONFIG, config, PcBridge.ACTION_TIMEOUT), ok -> {
			boolean recreate = ok.has("recreate") && ok.get("recreate").getAsBoolean();
			this.say(Component.translatable(recreate ? "screen.minevibe.pc.saved.recreate" : "screen.minevibe.pc.saved"), 0xFF4ADE80);
			this.draftLoaded = false;
		});
	}

	private void run(final String action) {
		this.track(PcBridge.action(action, this.pcId, null, null), ok -> this.say(Component.translatable("screen.minevibe.pc.done." + action), 0xFF4ADE80));
	}

	private void confirm(final String action) {
		Component title = Component.translatable("screen.minevibe.pc.confirm." + action + ".title", this.pcId);
		Component message = Component.translatable("screen.minevibe.pc.confirm." + action);
		this.minecraft.gui.setScreen(new ConfirmScreen(yes -> {
			this.minecraft.gui.setScreen(this);
			if (yes) {
				this.run(action);
			}
		}, title, message));
	}

	private void browse() {
		Pc.HostPickFolder pick = new Pc.HostPickFolder("vault", this.pcId, "Choose a folder for " + this.pcId);
		this.track(PcBridge.request(Pc.HOST_PICK_FOLDER, pick, PcBridge.PICK_FOLDER_TIMEOUT), ok -> {
			if (!ok.has("path") || ok.get("path").isJsonNull()) {
				this.say(Component.translatable("screen.minevibe.pc.vault.cancelled"), 0xFF9CA3AF);
				return;
			}
			String path = ok.get("path").getAsString();
			if (this.draftMounts.stream().noneMatch(m -> m.hostPath().equals(path))) {
				this.draftMounts.add(new Pc.VaultMount(path, "ro"));
			}
			this.say(Component.translatable("screen.minevibe.pc.vault.added"), 0xFFFBBF24);
			this.rebuildWidgets();
		});
	}

	/** {@code pc.action reissue}, then a fresh workstation item bound to the PC in the player's inventory. */
	private void reissue() {
		Pc.PcInfo info = this.info();
		String type = info != null ? info.type() : "linux";
		this.track(PcBridge.action("reissue", this.pcId, null, null), ok -> {
			IntegratedServer server = this.minecraft.getSingleplayerServer();
			if (server == null || this.minecraft.player == null) {
				return;
			}
			UUID id = this.minecraft.player.getUUID();
			String pcId = this.pcId;
			server.execute(() -> {
				ServerPlayer player = server.getPlayerList().getPlayer(id);
				if (player != null) {
					ItemStack stack = WorkstationItem.stackFor(type, pcId);
					if (!player.getInventory().add(stack)) {
						player.drop(stack, false, Prediction.SERVER_ONLY);
					}
				}
			});
			this.say(Component.translatable("screen.minevibe.pc.done.reissue"), 0xFF4ADE80);
		});
	}

	private interface OkHandler {
		void accept(JsonObject ok);
	}

	private void track(final CompletableFuture<JsonObject> request, final OkHandler onOk) {
		this.busy = true;
		this.refreshButtons();
		request.whenComplete((ok, err) -> this.minecraft.execute(() -> {
			this.busy = false;
			if (err != null) {
				this.say(Component.translatable("screen.minevibe.pc.error", PcBridge.codeOf(err)), 0xFFF87171);
			} else {
				onOk.accept(ok);
			}
			if (this.minecraft.gui.screen() == this) {
				this.refreshButtons();
			}
		}));
	}

	private void say(final Component message, final int color) {
		this.status = message;
		this.statusColor = color;
	}

	// -----------------------------------------------------------------------------------------
	// Drawing
	// -----------------------------------------------------------------------------------------

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		Pc.PcInfo info = this.info();
		int colW = Math.min(200, (this.width - 30) / 2);
		int left = this.width / 2 - colW - 5;
		int right = this.width / 2 + 5;
		if (info == null) {
			g.centeredText(this.font, Component.translatable("screen.minevibe.pc.unknown", this.pcId), this.width / 2, this.height / 2 - 10, 0xFFFFFFFF);
			super.extractRenderState(g, mouseX, mouseY, a);
			return;
		}
		g.centeredText(this.font, Component.translatable("screen.minevibe.pc.config.title", info.name(), info.pcId(), info.type()), this.width / 2, 6, 0xFFFFFFFF);
		String detail = info.detail() != null ? " · " + info.detail() : "";
		MutableComponent line = Component.literal(statusLabel(info) + detail);
		if (info.occupant() != null) {
			String who = info.occupant().isPlayer() ? "you" : Objects.requireNonNullElse(info.occupant().agentId(), "an agent");
			line.append(" · ").append(Component.translatable("screen.minevibe.pc.occupant", who));
		}
		g.centeredText(this.font, line, this.width / 2, 18, statusColor(info.status()));

		// Budget bars under the resources.
		Pc.Budget budget = PcStates.budget();
		int by = 34 + this.leftRows * ROW + 2;
		if (budget != null) {
			by = bar(g, left, by, colW, Component.translatable("screen.minevibe.pc.budget.cpu", budget.cpu().used(), budget.cpu().total()), budget.cpu().used(), budget.cpu().total());
			by = bar(g, left, by, colW, Component.translatable("screen.minevibe.pc.budget.memory", gib(budget.memoryMiB().used()), gib(budget.memoryMiB().pool())), budget.memoryMiB().used(), budget.memoryMiB().pool());
			g.text(this.font, Component.translatable("screen.minevibe.pc.budget.disk", budget.diskFreeGiB()), left, by, 0xFFD1D5DB, false);
			g.text(this.font, Component.translatable("screen.minevibe.pc.budget.macos", budget.macos().running(), budget.macos().max()), left, by + 11, 0xFFD1D5DB, false);
			by += 24;
		} else {
			g.text(this.font, Component.translatable("screen.minevibe.pc.budget.unknown"), left, by, 0xFF9CA3AF, false);
			by += 12;
		}
		if (this.resourcesChanged(info)) {
			g.textWithWordWrap(this.font, Component.translatable("screen.minevibe.pc.recreate.warning"), left, by, colW, 0xFFFBBF24, false);
			by += 2 + this.font.wordWrapHeight(Component.translatable("screen.minevibe.pc.recreate.warning"), colW);
		}
		Component phoneLine = this.phoneLine(info);
		if (phoneLine != null) {
			int color = this.androidChanged(info) ? 0xFFFBBF24 : phoneColor(info);
			g.textWithWordWrap(this.font, phoneLine, left, by, colW, color, false);
		}

		// Vault rows.
		g.text(this.font, Component.translatable("screen.minevibe.pc.vault"), right, 34, 0xFFFFFFFF, false);
		int shown = this.mountsShown();
		for (int i = 0; i < shown; i++) {
			Pc.VaultMount m = this.draftMounts.get(i);
			int y = 34 + 12 + i * ROW + 6;
			String path = this.font.plainSubstrByWidth(m.hostPath(), colW - 52);
			g.text(this.font, Component.literal(path), right, y, "rw".equals(m.mode()) ? 0xFFFBBF24 : 0xFFD1D5DB, false);
		}
		if (this.draftMounts.size() > shown) {
			g.text(this.font, Component.translatable("screen.minevibe.pc.vault.more", this.draftMounts.size() - shown), right + colW - 60, 34, 0xFF9CA3AF, false);
		}
		if (this.draftMounts.isEmpty()) {
			g.text(this.font, Component.translatable("screen.minevibe.pc.vault.empty"), right + 40, 34, 0xFF9CA3AF, false);
		}
		boolean anyRw = this.draftMounts.stream().anyMatch(m -> "rw".equals(m.mode()));
		int warnY = 34 + 12 + shown * ROW + ROW + 2;
		if (anyRw) {
			g.textWithWordWrap(this.font, Component.translatable("screen.minevibe.pc.vault.rw_warning"), right, warnY, colW, 0xFFFBBF24, false);
		}
		g.centeredText(this.font, this.status, this.width / 2, this.height - 38, this.statusColor);
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	private int bar(final GuiGraphicsExtractor g, final int x, final int y, final int w, final Component label, final long used, final long total) {
		g.text(this.font, label, x, y, 0xFFD1D5DB, false);
		int by = y + 10;
		g.fill(x, by, x + w, by + 4, 0xFF334155);
		double f = total <= 0 ? 0 : Math.max(0, Math.min(1, used / (double) total));
		g.fill(x, by, x + (int) (w * f), by + 4, f > 0.9 ? 0xFFF87171 : 0xFF4ADE80);
		return by + 8;
	}

	/** {@code KVM: On} / {@code Android: Off}. */
	private static Component toggleLabel(final String key, final boolean on) {
		return Component.translatable(key, Component.translatable(on ? "screen.minevibe.pc.toggle.on" : "screen.minevibe.pc.toggle.off"));
	}

	/** What applying the Android switch does, or how the phone is doing; null for a PC without one. */
	private @Nullable Component phoneLine(final Pc.PcInfo info) {
		if (this.androidChanged(info)) {
			return Component.translatable(this.draftAndroid ? "screen.minevibe.pc.android.will_start" : "screen.minevibe.pc.android.will_delete");
		}
		if (!androidOn(info) || info.capabilities() == null) {
			return null;
		}
		return Component.translatable("screen.minevibe.pc.android.status", PcCapabilityText.phoneStatus(info.capabilities().android()));
	}

	private static int phoneColor(final Pc.PcInfo info) {
		String status = info.capabilities() != null ? info.capabilities().android().status() : "off";
		return switch (status) {
			case "running" -> 0xFF4ADE80;
			case "error" -> 0xFFF87171;
			default -> 0xFF9CA3AF;
		};
	}

	static String gib(final long mib) {
		return String.format("%.1f", mib / 1024.0);
	}

	private static String statusLabel(final Pc.PcInfo info) {
		String s = info.status().replace('_', ' ');
		if (info.progress() != null) {
			s += " " + Math.round(info.progress() * 100) + "%";
		}
		return s.substring(0, 1).toUpperCase() + s.substring(1);
	}

	private static int statusColor(final String status) {
		return switch (dev.minevibe.pc.PcLed.of(status)) {
			case GREEN -> 0xFF4ADE80;
			case AMBER -> 0xFFFBBF24;
			case RED -> 0xFFF87171;
			default -> 0xFF9CA3AF;
		};
	}
}
