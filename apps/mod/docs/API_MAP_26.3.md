# MineVibe API map: Minecraft 26.3 + Fabric API 0.162.0+26.3

Verified on 2026-10-08 (spike S0) against decompiled sources. Every entry below was read in the
sources listed here. Anything not found is marked **NOT FOUND**. Line numbers are from these exact
decompiled jars; they move between decompiler runs, so search by signature.

## Sources used

| Tag | Jar | How to get it |
|---|---|---|
| `[common]` | `apps/mod/.gradle/loom-cache/minecraftMaven/net/minecraft/minecraft-common-7e9a32a5b8/26.3/minecraft-common-7e9a32a5b8-26.3-sources.jar` | `./gradlew genSources` (Vineflower, Loom 1.18.3) |
| `[client]` | `apps/mod/.gradle/loom-cache/minecraftMaven/net/minecraft/minecraft-clientOnly-7e9a32a5b8/26.3/minecraft-clientOnly-7e9a32a5b8-26.3-sources.jar` | same |
| `[fapi:<module>]` | `https://maven.fabricmc.net/net/fabricmc/fabric-api/<module>/<ver>/<module>-<ver>-sources.jar` (versions pinned by `fabric-api-0.162.0+26.3.pom`) | downloaded by hand; IDE sync also fetches them |

Fabric API module versions used: `fabric-rendering-v1` 27.0.14+901a437c5d, `fabric-message-api-v1`
7.0.10+3434d6d95d, `fabric-events-interaction-v0` 5.3.7+b9b88df45d, `fabric-entity-events-v1`
6.0.4+3434d6d95d, `fabric-screen-api-v1` 5.2.4+48607d035d, `fabric-gametest-api-v1` 4.0.33+3434d6d95d,
`fabric-client-gametest-api-v1` 6.0.8+4be74c3f5d, `fabric-renderer-api-v1` 17.0.15+79385d0b5d.

The decompiled MC sources already contain Fabric interface injection (for example
`BlockEntityRenderState implements FabricRenderState`) and transitive access widening (for example
`BlockEntityRenderers.register` is `public`). That is what mod code compiles against.

## Corrections to PLAN / full design (read these first)

1. **There is no `Minecraft#setScreen`.** The screen lives in `net.minecraft.client.gui.Gui`.
   Use `Minecraft.getInstance().gui.setScreen(screen)` and read it with `gui.screen()`.
   `Minecraft#setScreenAndShow(Screen)` = `gui.setScreen(screen)` + one forced `renderFrame(false)`.
   The single choke point for `GuiSetScreenMixin` is `Gui#setScreen(@Nullable Screen)`.
2. **There is no `getRenderBoundingBox`** in vanilla 26.3 or in Fabric API 0.162 (grep of all
   sources). Block entity culling is: section visibility, `BlockEntityRenderer#shouldRender`
   (distance vs `getViewDistance()`, default 64), and `shouldRenderOffScreen()` (moves the BE into
   `ClientLevel#getGloballyRenderedBlockEntities()`, which skips section culling). A 2-wide monitor
   that can straddle a section border should use `shouldRenderOffScreen() == true` or stay inside
   its own block's section. Entity Culling / Sodium compatibility of the monitor needs S4.
3. **Text input is owned by `TextInputManager`.** `Minecraft#onTextInputFocusChange(GuiEventListener, boolean)`
   still exists and forwards to `TextInputManager#onTextInputFocusChange(Object, boolean)`
   (SDL_StartTextInput / SDL_StopTextInput). `Gui#setScreen` calls `textInputManager().stopTextInput()`
   whenever a screen is replaced.
4. **Server GameTests ignore `eula.txt`.** Fabric's `MainMixin` forces `Eula#hasAgreedToEULA()`
   to `true` when `-Dfabric-api.gametest` is set, so the only thing stopping `./gradlew build`
   from launching Minecraft is our own gate (`-Pminevibe.acceptMinecraftEula`, see README).
5. **LevelSettings has no game rules any more.** Game rules travel separately as
   `Optional<GameRules>` (see 2.3).
6. **Day time is per-clock.** `Level#getDayTime()` is gone; use `Level#getOverworldClockTime()` (see 4.1).
7. **Keys are SDL3 scancodes/keycodes**, not GLFW (see 5.3). Mouse buttons are 1-based (left = 1).
8. **Blaze3D's command API moved** to `com.mojang.renderpearl.api.*` (`CommandEncoder`, `GpuDevice`,
   `GpuTexture`, `FilterMode`, `AddressMode`); `RenderSystem`, `SamplerCache`, `NativeImage` and
   `TextInputManager` stay under `com.mojang.blaze3d.*`.
9. Fabric's `BlockEntityRendererRegistry` is `@Deprecated`; use vanilla `BlockEntityRenderers.register`.

---

## 1. Screens

### 1.1 Where screens are set
`[client] net/minecraft/client/gui/Gui.java`
```java
public class Gui {
    public void setScreen(@Nullable Screen screen);                 // :234
    public @Nullable Screen screen();                               // :230 (@Contract(pure = true))
    public void setPauseScreen(boolean suppressPauseMenuIfWeReallyArePausing,
                               boolean canGameReallyBePaused);       // :327
    public boolean isPausing();                                     // :304 screen.isPauseScreen() || overlay.isPausing()
}
```
`setScreen(null)` substitutes a screen: `level == null` -> `new TitleScreen()`; player dead and
`shouldShowDeathScreen()` -> `new DeathScreen(null, levelData.isHardcore(), player)`; otherwise the
restored chat screen. It throws `IllegalStateException` if called with `null` during level teardown.
It logs an error (in IDE) when called off the render thread.

`[client] net/minecraft/client/Minecraft.java`
```java
public final Gui gui;                                               // :308
public void setScreenAndShow(Screen screen);                        // :2301 gui.setScreen + renderFrame(false)
public void pauseGame(boolean suppressPauseMenuIfWeReallyArePausing); // :1695 -> gui.setPauseScreen(...)
public void disconnectFromWorld(Component message);                 // :2180 ends with gui.setScreen(new TitleScreen())
public void disconnect(Screen screen, boolean keepResourcePacks);   // :2215 (+ overload with boolean stopSound)
public void disconnectWithSavingScreen();                           // GenericMessageScreen(Gui.SAVING_LEVEL)
public @Nullable IntegratedServer getSingleplayerServer();          // :2696
public boolean isPaused();                                          // pause = hasSingleplayerServer() && gui.isPausing() && !published (:1283)
```
Who opens what:
- Esc in game: `KeyboardHandler#keyPress` :550 `this.minecraft.pauseGame(debugModifierDown)` ->
  `Gui#setPauseScreen` -> `new PauseScreen(...)`. Mixin target for `MinecraftPauseGameMixin`:
  `Minecraft#pauseGame(Z)V` (or `Gui#setPauseScreen(ZZ)V`).
- Focus loss: `Minecraft` :1455 `if (!window.isFocused() && options.pauseOnLostFocus) pauseGame(false)`.
  `Options.pauseOnLostFocus` is `public boolean` (options.txt key `pauseOnLostFocus`).
- Death: `ClientPacketListener#handlePlayerCombatKill` :1784 ->
  `minecraft.gui.setScreen(new DeathScreen(packet.message(), level.getLevelData().isHardcore(), player))`,
  and `Gui#setScreen(null)` while dead.
- TitleScreen: `Minecraft` :873 (startup), `Gui` :258/:391, `Minecraft#disconnectFromWorld`, `DeathScreen` :97.
- DisconnectedScreen: `ClientCommonPacketListenerImpl` :368-369, `ClientHandshakePacketListenerImpl` :206-208,
  `ConnectScreen`, `QuickPlay`.

### 1.2 Screen classes (all `[client] net/minecraft/client/gui/screens/`)
```java
public class TitleScreen extends Screen {
    public TitleScreen();                                           // :59
    public TitleScreen(boolean fading);
    public TitleScreen(boolean fading, @Nullable LogoRenderer logoRenderer);
}
public class PauseScreen extends Screen {
    public PauseScreen(boolean showPauseMenu);                      // :71 title "menu.game" or "menu.paused"
    public boolean showsPauseMenu();
}
public class DeathScreen extends Screen {
    public DeathScreen(@Nullable Component causeOfDeath, boolean hardcore, LocalPlayer player); // :33
}
public class DisconnectedScreen extends Screen {                    // :23..:35
    public DisconnectedScreen(Screen parent, Component title, Component reason);
    public DisconnectedScreen(Screen parent, Component title, Component reason, Component buttonText);
    public DisconnectedScreen(Screen parent, Component title, DisconnectionDetails details);
    public DisconnectedScreen(Screen parent, Component title, DisconnectionDetails details, Component buttonText);
}
public class GenericMessageScreen extends Screen {
    public GenericMessageScreen(Component title);                   // :11 shouldCloseOnEsc() == false
}
```
**How PauseScreen builds its buttons** (`createPauseMenu()` :98, only when `showPauseMenu`): a
2-column `GridLayout` (`gridLayout.createRowHelper(2)`), cell padding 4. Children in order:
`Button.builder(RETURN_TO_GAME, b -> { minecraft.gui.setScreen(null); minecraft.mouseHandler.grabMouse(); }).width(204)` (span 2, paddingTop 50),
`openScreenButton(ADVANCEMENTS, ...)`, `openScreenButton(STATS, ...)` (width 98 each), a
`LinearLayout` row of `SpriteIconButton`s (report bugs, feedback, `CommonButtons.friends(...)`,
player reporting; span 2), optional server-dialog buttons (`getCustomAdditions()`), then (when
`minecraft.level != null`) `openScreenButton(OPTIONS, ...)` + `openScreenButton(WORLD_OPTIONS, ...)`,
then the disconnect button
(:164, width 204, span 2) whose action calls
`getReportingContext().draftReportHandled(..., () -> minecraft.disconnectFromWorld(ClientLevel.DEFAULT_QUIT_MESSAGE), true)`.
Finally `gridLayout.arrangeElements(); FrameLayout.alignInRectangle(...); gridLayout.visitWidgets(this::addRenderableWidget)`.
Labels are translatable keys (`menu.returnToGame`, `gui.advancements`, `gui.stats`, `menu.options`,
`options.worldOptions.button`; disconnect is `CommonComponents.disconnectButtonLabel(isLocalServer)` =
`menu.returnToMenu` in singleplayer, `menu.disconnect` otherwise). `openScreenButton` is private:
`Button.builder(message, b -> minecraft.gui.setScreen(newScreen.get())).width(98).build()`.
With Fabric, find them after init via `ScreenEvents.AFTER_INIT` + `Screens.getWidgets(screen)` and
match `button.getMessage()` against those components.

### 1.3 Screen base class and input
`[client] net/minecraft/client/gui/screens/Screen.java` (`extends AbstractContainerEventHandler implements Renderable`)
```java
protected Screen(Component title);
protected final Minecraft minecraft; protected final Font font; public int width, height;
protected void init();                                               // called from final init(int, int) :374
public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a); // :121 (replaces render)
public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a);
public boolean keyPressed(KeyEvent event);                          // :128 Esc -> onClose() if shouldCloseOnEsc()
public boolean shouldCloseOnEsc();                                  // :204 default true
public void onClose();                                              // minecraft.gui.setScreen(null)
public boolean isPauseScreen();                                     // :477
public void tick(); public void added(); public void removed();
protected <T extends GuiEventListener & Renderable & NarratableEntry> T addRenderableWidget(T widget);
```
`[client] net/minecraft/client/gui/components/events/GuiEventListener.java`
```java
default void mouseMoved(double x, double y);
default boolean mouseClicked(MouseButtonEvent event, boolean doubleClick);          // :18
default boolean mouseReleased(MouseButtonEvent event);                              // :22
default boolean mouseDragged(MouseButtonEvent event, double dx, double dy);         // :26
default boolean mouseScrolled(double x, double y, double scrollX, double scrollY);  // :30
default boolean keyPressed(KeyEvent event);                                         // :34
default boolean keyReleased(KeyEvent event);                                        // :38
default boolean charTyped(CharacterEvent event);                                    // :42
default boolean preeditUpdated(@Nullable PreeditEvent event);                       // IME composition
```
`[client] net/minecraft/client/input/`
```java
public record KeyEvent(@InputConstants.Value int key, int keycode, int modifiers) implements InputWithModifiers
    // key = SDL scancode (input()), keycode = SDL keycode (shortcutKey()), modifiers = SDL_Keymod bits
public record CharacterEvent(int codepoint) { String codepointAsString(); boolean isAllowedChatCharacter(); }
public record MouseButtonEvent(double x, double y, MouseButtonInfo buttonInfo) implements InputWithModifiers
    // button() is 1-based: 1 left, 2 middle, 3 right
public interface InputWithModifiers {
    int input(); default int shortcutKey(); int modifiers();
    default boolean isEscape();        // input() == 41
    default boolean hasShiftDown(); hasControlDown(); hasAltDown(); hasControlDownWithQuirk();
    default boolean isSelection(); isConfirmation(); isCycleFocus(); isLeft(); isRight(); isUp(); isDown();
    default boolean isSelectAll(); isCopy(); isPaste(); isCut();
}
```

### 1.4 Text input focus
```java
// [client] net/minecraft/client/Minecraft.java
public TextInputManager textInputManager();                                          // :2973
public void onTextInputFocusChange(GuiEventListener element, boolean isFocused);     // :2977
// [client] com/mojang/blaze3d/platform/TextInputManager.java
public void onTextInputFocusChange(Object owner, boolean focused);                  // :73
public void startTextInput(Object owner); public void stopTextInput(Object owner); public void stopTextInput();
public void setTextInputArea(int x0, int y0, int x1, int y1);                        // IME candidate rect
```
PcControlScreen: call `minecraft.onTextInputFocusChange(this, true)` in `init()`/`added()`; SDL text
input then arrives through `charTyped(CharacterEvent)`. `Gui#setScreen` stops text input when the
screen is replaced.

### 1.5 InputConstants
`[client] com/mojang/blaze3d/platform/InputConstants.java` (imports `org.lwjgl.sdl.*`)
- Keys are SDL scancodes: `KEY_ESCAPE = 41`, `KEY_RETURN = 40`, `KEY_TAB = 43`, `KEY_BACKSPACE = 42`,
  `KEY_SPACE = 44`, `KEY_LSHIFT = 225`, `KEY_LCONTROL = 224`, `KEY_LALT = 226`, `KEY_LGUI = 227`,
  `KEY_RSHIFT = 229`, `KEY_RCONTROL = 228`, `KEY_RALT = 230`, `KEY_RGUI = 231`, `KEY_T = 23`,
  `KEY_G = 10`, `KEY_H = 11`, `KEY_1 = 30`, `KEY_F1 = 58`.
- `PRESS = 1`, `RELEASE = 0`, `REPEAT = -1`.
- `MOUSE_BUTTON_LEFT = 1`, `MOUSE_BUTTON_MIDDLE = 2`, `MOUSE_BUTTON_RIGHT = 3`, `MOUSE_BUTTON_4..8 = 4..8`.
- Modifiers (SDL_Keymod): `MOD_SHIFT = 3`, `MOD_CONTROL = 192`, `MOD_ALT = 768`, `MOD_SUPER = 3072`,
  `MOD_CAPS_LOCK = 8192`, `MOD_NUM_LOCK = 4096`.
- `public static boolean isKeyDown(int scancode)` :217 (reads `SDL_GetKeyboardState()`),
  `public static InputConstants.Key getKey(KeyEvent)`, `getKey(String name)`,
  `grabMouse(Window, double, double)` / `releaseMouse(...)` (SDL relative mouse mode).
- Screen keyPressed navigation uses SDL keycodes: Tab = 9, arrows 1073741903..1073741906, PageUp/Down 1073741899/1073741902.

## 2. World lifecycle (client)

### 2.1 WorldOpenFlows
`[client] net/minecraft/client/gui/screens/worldselection/WorldOpenFlows.java`
```java
public WorldOpenFlows(Minecraft minecraft, LevelStorageSource levelSource);         // or Minecraft#createWorldOpenFlows() :2110
public void createFreshLevel(String levelId, LevelSettings levelSettings, WorldOptions options,
        Function<HolderLookup.Provider, WorldDimensions> dimensionsProvider, Screen parentScreen); // :102
public void createLevelFromExistingSettings(LevelStorageAccess access, ReloadableServerResources serverResources,
        LayeredRegistryAccess<RegistryLayer> registryAccess, WorldDataAndGenSettings worldDataAndGenSettings,
        Optional<GameRules> gameRules);                                              // :156
public void openWorld(String levelId, Runnable onCancel);                            // :306
```
- `createFreshLevel` shows `GenericMessageScreen("selectWorld.data_read")` via `setScreenAndShow`,
  builds `new PrimaryLevelData(levelSettings, ...)` + `new WorldGenSettings(options, dimensions)`, then
  `Minecraft#doWorldLoad(access, packRepository, worldStem, Optional.empty(), true)` (:2114, signature
  `(LevelStorageAccess, PackRepository, WorldStem, Optional<GameRules>, boolean newWorld)`).
  On datapack failure it calls `gui.setScreen(parentScreen)`. Default game rules apply.
- Vanilla callers: `TitleScreen` :230 (demo) and `SelectWorldScreen` :119 (debug world) pass
  `WorldPresets::createNormalWorldDimensions`.
- `openWorld` may show `RecoverWorldDataScreen`, `AlertScreen` (incompatible), backup prompts; those
  must be handled by BootScreen (they call `onCancel` or set screens themselves).
- **`levelExists` is NOT on WorldOpenFlows.** It is
  `[common] net/minecraft/world/level/storage/LevelStorageSource.java :363 public boolean levelExists(String levelId)`
  (`Files.isDirectory(getLevelPath(levelId))`). Get the source with `Minecraft#getLevelSource()` (:1109).
  Also `public Path getLevelPath(String)`, `public Path getBaseDir()`.

### 2.2 LevelSettings, difficulty, hardcore
`[common] net/minecraft/world/level/LevelSettings.java`
```java
public record LevelSettings(String levelName, GameType gameType, LevelSettings.DifficultySettings difficultySettings,
                            boolean allowCommands, WorldDataConfiguration dataConfiguration) {   // :8
    public LevelSettings withGameType(GameType); withAllowCommands(boolean); withDifficulty(Difficulty);
    public LevelSettings withDifficultyLock(boolean); withDataConfiguration(WorldDataConfiguration); copy();
    public record DifficultySettings(Difficulty difficulty, boolean hardcore, boolean locked) {      // :58
        public static final DifficultySettings DEFAULT = new DifficultySettings(Difficulty.NORMAL, false, false);
    }
}
```
Hardcore lives in `DifficultySettings.hardcore`. Vanilla `CreateWorldScreen#createLevelSettings` :347
uses `new DifficultySettings(uiState.getDifficulty(), uiState.isHardcore(), false)`.
MineVibe fresh world:
```java
new LevelSettings(name, GameType.SURVIVAL,
    new LevelSettings.DifficultySettings(Difficulty.HARD, /*hardcore*/ true, /*locked*/ false),
    /*allowCommands*/ false, WorldDataConfiguration.DEFAULT)
```
- `net.minecraft.world.Difficulty` enum: `PEACEFUL, EASY, NORMAL, HARD`.
- `net.minecraft.world.level.GameType` enum: `SURVIVAL, CREATIVE, ADVENTURE, SPECTATOR`.
- `net.minecraft.world.level.WorldDataConfiguration` record, `DEFAULT` constant.
- Reading back: `LevelData#isHardcore()` (used as `level.getLevelData().isHardcore()`).

### 2.3 WorldOptions, WorldPresets, GameRules
```java
// [common] net/minecraft/world/level/levelgen/WorldOptions.java
public WorldOptions(long seed, boolean generateStructures, boolean generateBonusChest);  // :28
public static WorldOptions defaultWithRandomSeed();                                       // :32 (structures on, no bonus chest)
public static long randomSeed();                                                          // :88
public WorldOptions withSeed(OptionalLong); withStructures(boolean); withBonusChest(boolean);
// [common] net/minecraft/world/level/levelgen/presets/WorldPresets.java
public static final ResourceKey<WorldPreset> NORMAL;
public static WorldDimensions createNormalWorldDimensions(HolderLookup.Provider registries); // :64 (method ref for createFreshLevel)
// [common] net/minecraft/server/MinecraftServer.java
public static final Supplier<GameRules> DEFAULT_GAME_RULES;  // GameRules in net.minecraft.world.level.gamerules
```
Custom game rules at creation need `createLevelFromExistingSettings(..., Optional.of(gameRules))`
(what `CreateWorldScreen` does) or setting them on the server after load.

## 3. Fake players (server)

```java
// [common] net/minecraft/server/level/ServerPlayer.java
public ServerPlayer(MinecraftServer server, ServerLevel level, GameProfile gameProfile, ClientInformation clientInformation); // :371
public ServerGamePacketListenerImpl connection;                 // :236
public ServerLevel level();                                     // :1778
public void die(DamageSource source);                           // :880
// [common] net/minecraft/server/players/PlayerList.java
public void placeNewPlayer(Connection connection, ServerPlayer player, CommonListenerCookie cookie); // :147
public Optional<CompoundTag> loadPlayerData(NameAndId nameAndId);                                     // :278
// [common] net/minecraft/server/network/CommonListenerCookie.java
public record CommonListenerCookie(GameProfile gameProfile, int latency, ClientInformation clientInformation, boolean transferred) {
    public static CommonListenerCookie createInitial(GameProfile gameProfile, boolean transferred);
}
// [common] net/minecraft/server/level/ClientInformation.java
public record ClientInformation(String language, int viewDistance, ChatVisiblity chatVisibility, boolean chatColors,
        int modelCustomisation, HumanoidArm mainHand, boolean textFilteringEnabled, boolean allowsListing,
        ParticleStatus particleStatus) {
    public static ClientInformation createDefault();  // ("en_us", 2, FULL, true, 0, Player.DEFAULT_MAIN_HAND, false, false, ALL)
}
// [common] net/minecraft/server/network/ServerGamePacketListenerImpl.java
public ServerGamePacketListenerImpl(MinecraftServer server, Connection connection, ServerPlayer player, CommonListenerCookie cookie); // :286
// [common] net/minecraft/network/Connection.java
public Connection(PacketFlow receiving);                        // :84
private Channel channel;                                        // :69 (needs an accessor; Carpet's ConnectionAccessor#setChannel)
public void send(Packet<?>); send(Packet<?>, @Nullable ChannelFutureListener); send(Packet<?>, ChannelFutureListener, boolean flush);
public void setupInboundProtocol(...); setupOutboundProtocol(ProtocolInfo<?>); disconnect(Component); handleDisconnection();
```
`GameProfile` is the authlib 10 record (`new GameProfile(UUID, String)`).
`placeNewPlayer` itself builds `new ServerGamePacketListenerImpl(server, connection, player, cookie)`,
calls `connection.setupInboundProtocol(...)`, sends the login packets, adds the player, and calls
`level.addNewPlayer(player)`. It does **not** load player data: the vanilla login path
(`[common] net/minecraft/server/network/config/PrepareSpawnTask.java` :169 `spawn(...)`) does
`loadPlayerData(nameAndId)` -> `player.load(ValueInput)` -> `player.snapTo(pos, yRot, xRot)` ->
`placeNewPlayer(...)` -> `loadAndSpawnEnderPearls` / `loadAndSpawnParentVehicle`.

Vanilla reference implementation of a fake player
(`[common] net/minecraft/gametest/framework/GameTestHelper.java` :396, `@Deprecated(forRemoval = true)`):
```java
CommonListenerCookie cookie = CommonListenerCookie.createInitial(new GameProfile(UUID.randomUUID(), "test-mock-player"), false);
ServerPlayer player = new ServerPlayer(level.getServer(), level, cookie.gameProfile(), cookie.clientInformation()) { ... };
Connection connection = new Connection(PacketFlow.SERVERBOUND);
new EmbeddedChannel(connection);   // io.netty.channel.embedded.EmbeddedChannel
level.getServer().getPlayerList().placeNewPlayer(connection, player, cookie);
```
Related, verified: `Entity#startRiding(Entity)` (final, = `startRiding(e, false, true)`),
`Entity#startRiding(Entity, boolean force, boolean sendEventAndTriggers)` :2478,
`protected boolean Entity#canAddPassenger(Entity)` :2587;
`ClientboundPlayerInfoUpdatePacket.Entry(UUID profileId, @Nullable GameProfile profile, boolean listed, int latency, GameType gameMode, @Nullable Component displayName, boolean showHat, int listOrder, RemoteChatSession.@Nullable Data chatSession)` :165;
`[client] PlayerInfo#getSkin()` :83 returns `PlayerSkin`;
`[common] PlayerSkin.insecure(ClientAsset.Texture body, @Nullable ClientAsset.Texture cape, @Nullable ClientAsset.Texture elytra, PlayerModelType model)` :16.

## 4. Time, chat, interaction, damage

### 4.1 World clock
```java
// [common] net/minecraft/world/level/Level.java
public long getOverworldClockTime();     // :880 totalTicks of clock WorldClocks.OVERWORLD (the old "day time")
public long getDefaultClockTime();       // clock of this dimension's dimensionType().defaultClock()
public abstract ClockManager clockManager();                       // :1105
// [common] net/minecraft/world/level/LevelAccessor.java
default long getGameTime();              // :42 (monotonic game ticks)
// [common] net/minecraft/world/clock/
public interface ClockManager { ClockInstance getInstance(Holder<WorldClock> definition); }
public interface WorldClocks { ResourceKey<WorldClock> OVERWORLD; ResourceKey<WorldClock> THE_END; }
public class ServerClockManager extends SavedData implements ClockManager {   // MinecraftServer#clockManager() :1205, ServerLevel#clockManager()
    void setTotalTicks(Holder<WorldClock>, long); void addTicks(Holder<WorldClock>, int);
    void setPaused(Holder<WorldClock>, boolean); void setRate(Holder<WorldClock>, float);
    MoveResult moveToTimeMarker(Holder<WorldClock>, ResourceKey<ClockTimeMarker>);
}
```
Client: `ClientLevel#clockManager()` returns `ClientClockManager`; `getOverworldClockTime()` is inherited.
Calendar game-clock formula: `day = overworldClockTime / 24000`, `06:00 = tick 0` (as before).

### 4.2 Chat (client send + completions)
```java
// [fapi:fabric-message-api-v1] net/fabricmc/fabric/api/client/message/v1/ClientSendMessageEvents.java
public static final Event<AllowChat> ALLOW_CHAT;          // boolean allowSendChatMessage(String message)
public static final Event<ModifyChat> MODIFY_CHAT;        // String modifySendChatMessage(String message)
public static final Event<Chat> CHAT;                     // void onSendChatMessage(String message)
public static final Event<ChatCanceled> CHAT_CANCELED;    // void onSendChatMessageCanceled(String message)
// + ALLOW_COMMAND / MODIFY_COMMAND / COMMAND / COMMAND_CANCELED for "/..." input
```
Fired at HEAD of `ClientPacketListener#sendChat(String)` (:2541) by
`net/fabricmc/fabric/mixin/client/message/ClientPacketListenerMixin` (priority 800); returning
`false` from ALLOW_CHAT cancels the send. `ChatScreen#handleChatInput(String, boolean)` :315 has
already added the line to chat history (`addRecentChat`) before sendChat runs.

Tab completion of `@names`:
```java
// [common] net/minecraft/network/protocol/game/ClientboundCustomChatCompletionsPacket.java
public record ClientboundCustomChatCompletionsPacket(ClientboundCustomChatCompletionsPacket.Action action, List<String> entries)
public enum Action { ADD, REMOVE, SET }
// [client] ClientPacketListener#handleCustomChatCompletions :1871 -> suggestionsProvider.modifyCustomCompletions(...)
// [client] net/minecraft/client/multiplayer/ClientSuggestionProvider.java
public void modifyCustomCompletions(ClientboundCustomChatCompletionsPacket.Action action, List<String> entries); // :165
// obtain with Minecraft#getConnection().getSuggestionsProvider() (ClientPacketListener :474)
```
Server can send the packet with `serverPlayer.connection.send(new ClientboundCustomChatCompletionsPacket(Action.SET, names))`;
client-only code can call `modifyCustomCompletions` directly.

### 4.3 UseEntityCallback
```java
// [fapi:fabric-events-interaction-v0] net/fabricmc/fabric/api/event/player/UseEntityCallback.java
Event<UseEntityCallback> EVENT;
InteractionResult interact(Player player, Level level, InteractionHand hand, Entity entity, EntityHitResult hitResult);
```
Fires on both sides: client from `Minecraft#startUseItem` (`mixin/event/interaction/client/MinecraftMixin`),
server from `ServerGamePacketListenerImpl` (`mixin/event/interaction/ServerGamePacketListenerImplMixin`).
Client side: any non-PASS result cancels vanilla; if `result.consumesAction()` (only
`InteractionResult.Success` returns true) the mixin still sends `ServerboundInteractPacket`, so the
server-side callback runs too. To open AgentScreen purely client-side return `InteractionResult.FAIL`
(record `Fail`, `consumesAction()` false: cancels, sends nothing), or return SUCCESS and handle the
server side deliberately.

### 4.4 ServerLivingEntityEvents
```java
// [fapi:fabric-entity-events-v1] net/fabricmc/fabric/api/entity/event/v1/ServerLivingEntityEvents.java
Event<AllowDamage> ALLOW_DAMAGE;  // boolean allowDamage(LivingEntity entity, DamageSource source, float amount)
Event<AfterDamage> AFTER_DAMAGE;  // void afterDamage(LivingEntity, DamageSource, float baseDamageTaken, float damageTaken, boolean blocked)
Event<AllowDeath> ALLOW_DEATH;    // boolean allowDeath(LivingEntity, DamageSource, float damageAmount)
Event<AfterDeath> AFTER_DEATH;    // void afterDeath(LivingEntity entity, DamageSource damageSource)
Event<MobConversion> MOB_CONVERSION;
```
ALLOW_DAMAGE is injected into `LivingEntity#hurtServer` (before the `isSleeping()` check; returning
false cancels). AFTER_DEATH fires in `LivingEntity#die` and, for players, at TAIL of
`ServerPlayer#die` (`mixin/entity/event/ServerPlayerMixin` :76). An `AgentPlayer#die` override that
does not call `super.die(...)` will not fire AFTER_DEATH.

## 5. Rendering (client)

### 5.1 Textures
```java
// [client] net/minecraft/client/renderer/texture/DynamicTexture.java  (extends AbstractTexture implements Dumpable)
public DynamicTexture(Supplier<String> label, NativeImage image);                   // :19 creates GPU texture + uploads
public DynamicTexture(String label, int width, int height, boolean zero);
public DynamicTexture(Supplier<String> label, int width, int height, boolean zero);
public void upload();                // RenderSystem.getDevice().createCommandEncoder().writeToTexture(texture, pixels)
public NativeImage getPixels(); public void setPixels(NativeImage pixels); public void close();
// [client] net/minecraft/client/renderer/texture/AbstractTexture.java
protected GpuSampler sampler;        // :14 DynamicTexture sets RenderSystem.getSamplerCache().getRepeat(FilterMode.NEAREST)
public GpuTexture getTexture(); public GpuTextureView getTextureView(); public GpuSampler getSampler();
// [client] com/mojang/blaze3d/systems/SamplerCache.java
public GpuSampler getClampToEdge(FilterMode minMag);   // :40 -> use FilterMode.LINEAR for monitors (assign in a subclass)
public GpuSampler getSampler(AddressMode u, AddressMode v, FilterMode min, FilterMode mag, boolean useMipmaps);
// [client] com/mojang/blaze3d/platform/NativeImage.java
public NativeImage(int width, int height, boolean zero);
public NativeImage(NativeImage.Format format, int width, int height, boolean zero);
public NativeImage(NativeImage.Format format, int width, int height, boolean useStbFree, long pixels); // :76 wraps an existing pointer
public long getPointer();                                                          // :442
public static NativeImage read(InputStream | byte[] | ByteBuffer) throws IOException; // PNG only (PngInfo.validateHeader)
public enum Format { RGBA, ... }
// [client] net/minecraft/client/renderer/texture/TextureManager.java
public void register(Identifier location, AbstractTexture texture);                // :67 closes the previous texture at that id
public void release(Identifier location);                                          // :107
public AbstractTexture getTexture(Identifier location);
// [client] com/mojang/renderpearl/api/commands/CommandEncoder.java
void writeToTexture(GpuTexture destination, NativeImage source);
void writeToTexture(GpuTexture destination, NativeImage source, int mipLevel, int depthOrLayer, int destX, int destY);
void writeToTexture(GpuTexture destination, ByteBuffer source, int mipLevel, int depthOrLayer,
                    int destX, int destY, int width, int height);                   // :82 dirty-rect upload path
// obtain: RenderSystem.getDevice() (com.mojang.blaze3d.systems.RenderSystem :346, returns GpuDevice).createCommandEncoder()
```
`NativeImage.read(ByteBuffer)` itself does `STBImage.stbi_load_from_memory(bytes, w, h, comp, 4)` then
`new NativeImage(Format.RGBA, w, h, true, MemoryUtil.memAddress(pixels))` (:146), so the JPEG path is
the same call with our own buffer (STB decodes JPEG). `NativeImage#close()` frees with
`STBImage.nstbi_image_free` when `useStbFree` is true, otherwise `MemoryUtil.nmemFree`.

**`org.lwjgl.stb.STBImage` is on the client classpath:** `org.lwjgl:lwjgl-stb:3.4.3` appears in both
`clientCompileClasspath` and `clientRuntimeClasspath` (`./gradlew dependencies`), and vanilla
`NativeImage` imports it. Also present: `lwjgl-sdl`, `lwjgl-opengl`, `lwjgl-vulkan`, `lwjgl-freetype`,
`lwjgl-jemalloc`, `lwjgl-openal`, `lwjgl-shaderc`, `lwjgl-spvc`, `lwjgl-vma` (all 3.4.3).

### 5.2 Block entity renderers
```java
// [client] net/minecraft/client/renderer/blockentity/BlockEntityRenderer.java
public interface BlockEntityRenderer<T extends BlockEntity, S extends BlockEntityRenderState> {
    S createRenderState();
    default void extractRenderState(T blockEntity, S state, float partialTicks, Vec3 cameraPosition,
                                    ModelFeatureRenderer.@Nullable CrumblingOverlay breakProgress); // calls BlockEntityRenderState.extractBase
    void submit(S state, PoseStack poseStack, SubmitNodeCollector submitNodeCollector, CameraRenderState camera); // :21
    default boolean shouldRenderOffScreen();   // false
    default int getViewDistance();             // 64
    default boolean shouldRender(T blockEntity, Vec3 cameraPosition);
}
// [client] net/minecraft/client/renderer/blockentity/BlockEntityRenderers.java (access widened to public by Fabric)
public static <T extends BlockEntity, S extends BlockEntityRenderState> void register(
        BlockEntityType<? extends T> type, BlockEntityRendererProvider<T, S> renderer);   // :22
// [client] BlockEntityRendererProvider<T, S> { BlockEntityRenderer<T, S> create(Context context); }
//   record Context(BlockEntityRenderDispatcher, BlockModelResolver, ItemModelResolver, EntityRenderDispatcher,
//                  EntityModelSet, Font, SpriteGetter, PlayerSkinRenderCache)
// [client] net/minecraft/client/renderer/blockentity/state/BlockEntityRenderState.java (implements FabricRenderState)
public BlockPos blockPos; public BlockEntityType<?> blockEntityType; public int lightCoords;
public ModelFeatureRenderer.@Nullable CrumblingOverlay breakProgress;
public static void extractBase(BlockEntity, BlockEntityRenderState, @Nullable CrumblingOverlay);
```
Dispatch: `BlockEntityRenderDispatcher#tryExtractRenderState(be, partialTicks, breakProgress, isGloballyRendered)`
skips when `isGloballyRendered != renderer.shouldRenderOffScreen()` (:81) or `!shouldRender(...)`.
`CameraRenderState` is `net.minecraft.client.renderer.state.level.CameraRenderState` (`pos`, `xRot`, `yRot`, ...).

### 5.3 SubmitNodeCollector
```java
// [client] net/minecraft/client/renderer/SubmitNodeCollector.java
public interface SubmitNodeCollector extends OrderedSubmitNodeCollector {
    OrderedSubmitNodeCollector order(int order);
    interface CustomGeometryRenderer { void render(PoseStack.Pose pose, VertexConsumer buffer); }
}
// [client] net/minecraft/client/renderer/OrderedSubmitNodeCollector.java
void submitNameTag(PoseStack poseStack, @Nullable Vec3 nameTagAttachment, int offset, Component name,
                   boolean seeThrough, int lightCoords, CameraRenderState camera);                 // :37
void submitText(PoseStack poseStack, float x, float y, FormattedCharSequence string, boolean dropShadow,
                Font.DisplayMode displayMode, int lightCoords, int color, int backgroundColor, int outlineColor); // :41
void submitTextBackground(PoseStack, float x0, float y0, float x1, float y1, int color, Font.DisplayMode, int lightCoords);
void submitCustomGeometry(PoseStack poseStack, RenderType renderType,
                          SubmitNodeCollector.CustomGeometryRenderer customGeometryRenderer);       // :193
// also submitModel/submitModelPart/submitItem/submitBlockModel/submitShadow/submitShapeOutline/...
// Fabric adds (fabric-rendering-v1 FabricOrderedSubmitNodeCollector):
//   <T extends SubmitNode> void submitCustom(SubmitRenderPhase<T> phase, T node)
```
The MapRenderer quad pattern (`[client] net/minecraft/client/renderer/MapRenderer.java` :40):
```java
submitNodeCollector.submitCustomGeometry(poseStack, RenderTypes.text(texture), (pose, buffer) -> {
    buffer.addVertex(pose, 0.0F, 128.0F, -0.01F).setColor(-1).setUv(0.0F, 1.0F).setLight(lightCoords);
    // ... 3 more vertices
});
```

### 5.4 RenderTypes and light
```java
// [client] net/minecraft/client/renderer/rendertype/RenderTypes.java
public static RenderType text(Identifier texture);                         // :718 (MapRenderer uses this)
public static RenderType textSeeThrough(Identifier); textPolygonOffset(Identifier); textGrayscale(Identifier);
public static RenderType entitySolid(Identifier texture);                  // :567
public static RenderType entityCutout(Identifier texture);                 // :587 (+ entityCutout(Identifier, boolean affectsOutline))
public static RenderType entityCutoutCull(Identifier); entityTranslucent(Identifier); entityTranslucentEmissive(Identifier);
// [common] net/minecraft/util/LightCoordsUtil.java
public static final int FULL_BRIGHT = 15728880;                            // :9 (0xF000F0)
public static int pack(int block, int sky); getLightCoords(BlockAndLightGetter, BlockPos); ...
// [client] net/minecraft/client/renderer/texture/OverlayTexture.java
public static final int NO_OVERLAY;
```
`LightTexture` no longer exists (NOT FOUND); `LightCoordsUtil` is the replacement and lives in common.

### 5.5 Fabric level rendering events
`[fapi:fabric-rendering-v1] net/fabricmc/fabric/api/client/rendering/v1/level/`
```java
public final class LevelRenderEvents {
    Event<StartMain> START_MAIN;                       // (LevelTerrainRenderContext)
    Event<AfterOpaqueTerrain> AFTER_OPAQUE_TERRAIN;     // (LevelTerrainRenderContext)
    Event<CollectSubmits> COLLECT_SUBMITS;              // void collectSubmits(LevelRenderContext) - add submits here
    Event<AfterSolidFeatures> AFTER_SOLID_FEATURES;     // (LevelRenderContext)
    Event<AfterTranslucentFeatures> AFTER_TRANSLUCENT_FEATURES;
    Event<BeforeBlockOutline> BEFORE_BLOCK_OUTLINE;     // boolean (LevelRenderContext, BlockOutlineRenderState)
    Event<BeforeGizmos> BEFORE_GIZMOS; Event<BeforeTranslucentTerrain> BEFORE_TRANSLUCENT_TERRAIN;
    Event<AfterTranslucentTerrain> AFTER_TRANSLUCENT_TERRAIN; Event<EndMain> END_MAIN;
    @Deprecated AFTER_BLOCK_OUTLINE_EXTRACTION, END_EXTRACTION  // aliases of LevelExtractionEvents
}
public class LevelExtractionEvents {
    Event<AfterBlockOutlineExtraction> AFTER_BLOCK_OUTLINE_EXTRACTION; // (LevelExtractionContext, @Nullable HitResult)
    Event<EndExtraction> END_EXTRACTION;               // void endExtraction(LevelExtractionContext) - after all render states are extracted
}
public interface AbstractLevelRenderContext { GameRenderer gameRenderer(); LevelRenderer levelRenderer(); LevelRenderState levelState(); }
public interface LevelExtractionContext extends AbstractLevelRenderContext { ClientLevel level(); Camera camera(); DeltaTracker deltaTracker(); }
public interface LevelTerrainRenderContext extends AbstractLevelRenderContext { @Nullable ChunkSectionsToRender sectionsToRender(); }
public interface LevelRenderContext extends LevelTerrainRenderContext { SubmitNodeCollector submitNodeCollector(); PoseStack poseStack(); }
```
Bubble pipeline: in `LevelExtractionEvents.END_EXTRACTION` read `ClientLevel`/`Camera` and store plain
data on `context.levelState()` via `FabricRenderState#setData(RenderStateDataKey<T>, T)`
(`RenderStateDataKey.create(() -> "minevibe:bubbles")`); in `LevelRenderEvents.COLLECT_SUBMITS`
read it back with `getData(key)` and call `submitNameTag`/`submitText`. Fabric's docs say not to
attach non-thread-safe objects such as `ClientLevel`.
Own frustum test: `[client] Camera#getCullFrustum()` :193 returns `Frustum`;
`Frustum#isVisible(AABB)` :84. `LevelRenderState` (`net.minecraft.client.renderer.state.level`) has
`cameraRenderState`, `entityRenderStates`, `blockEntityRenderStates`, `gameTime`, ...

### 5.6 Fabric screen events
`[fapi:fabric-screen-api-v1] net/fabricmc/fabric/api/client/screen/v1/`
```java
public final class ScreenEvents {
    public static final Event<BeforeInit> BEFORE_INIT;  // (Minecraft client, Screen screen, int scaledWidth, int scaledHeight)
    public static final Event<AfterInit> AFTER_INIT;    // same args; fired at TAIL of Screen#init(II)V and Screen#resize
    public static Event<Remove> remove(Screen); beforeExtract(Screen); afterBackground(Screen);
    public static Event<AfterForeground> afterForeground(Screen); afterExtract(Screen); beforeTick(Screen); afterTick(Screen);
}
public final class Screens {
    public static List<AbstractWidget> getWidgets(Screen screen);   // mutable; add/remove buttons after init
    public static Font getFont(Screen screen); public static Minecraft getMinecraft(Screen screen);
}
// also ScreenKeyboardEvents, ScreenMouseEvents (per-screen allow/before/after input events)
```

## 6. GameTests

### 6.1 Server GameTests
- Annotation: `[fapi:fabric-gametest-api-v1] net.fabricmc.fabric.api.gametest.v1.GameTest`
  (`environment` "minecraft:default", `dimension` "minecraft:overworld", `structure`
  "fabric-gametest-api-v1:empty" (8x8 empty), `maxTicks` 20, `setupTicks` 0, `required` true,
  `rotation`, `manualOnly`, `maxAttempts` 1, `requiredSuccesses` 1, `skyAccess` false, `padding` 1).
  Methods must be `public`, non-static, `void`, one `GameTestHelper` parameter.
- Entrypoint key: `"fabric-gametest"` (any class; methods are found reflectively, superclasses included).
  Optional `CustomTestMethodInvoker` on the entrypoint class.
- Test id: `<providing mod id>:<snake_case(SimpleClassName + "_" + methodName)>`,
  e.g. `minevibe-gametest:mine_vibe_server_game_tests_mod_is_loaded`.
- Vanilla helper: `[common] net.minecraft.gametest.framework.GameTestHelper` (`getLevel()`,
  `spawn(EntityType<E>, BlockPos|Vec3|x,y,z)`, `setBlock`, `assertTrue(boolean, String|Component)`,
  `succeed()`, `succeedWhen(Runnable)`, `succeedIf(Runnable)`, `runAfterDelay(long, Runnable)`,
  `fail(String|Component)`, `startSequence()`, `makeMockPlayer(GameType)`, `makeMockServerPlayerInLevel()`).
- Runner: system property `fabric-api.gametest` (Loom run config `gameTest`, task `runGameTest`,
  run dir `build/run/gameTest`); also `fabric-api.gametest.report-file`, `fabric-api.gametest.filter`,
  `fabric-api.gametest.verify`. Exits non-zero on failure. Ignores `eula.txt` (see correction 4).
- Example in this repo: `src/gametest/java/dev/minevibe/gametest/MineVibeServerGameTests.java`.

### 6.2 Client GameTests
- Interface: `[fapi:fabric-client-gametest-api-v1] net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest`
  with `void runTest(ClientGameTestContext context)`; entrypoint key `"fabric-client-gametest"`.
- `ClientGameTestContext`: `waitTick()`, `waitTicks(int)`, `waitFor(Predicate<Minecraft>[, int timeout])`,
  `waitForScreen(@Nullable Class<? extends Screen>)`, `setScreen(Supplier<@Nullable Screen>)`,
  `clickScreenButton(String translationKey)`, `tryClickScreenButton(String)`, `takeScreenshot(...)`,
  `assertScreenshotEquals(...)`, `assertScreenshotContains(...)`, `getInput()` (`TestInput`),
  `worldBuilder()` (`TestWorldBuilder`: `setUseConsistentSettings`, `adjustSettings(Consumer<WorldCreationUiState>)`,
  `create()` -> `TestSingleplayerContext`, `createServer(Properties)`), `restoreDefaultGameOptions()`,
  `runOnClient(FailableConsumer<Minecraft, E>)`, `computeOnClient(FailableFunction<Minecraft, T, E>)`.
  `TestSingleplayerContext`: `getWorldSave()`, `getConnection()`, `getServer()`
  (`TestServerContext#runOnServer/computeOnServer`), `close()`.
- Runner contract (`FabricClientGameTestRunner` :103-120): after each test, no server may be running,
  `client.level` must be null and `client.gui.screen()` must be a `TitleScreen`. MineVibe's
  TitleScreen -> BootScreen redirect must be off when `-Dfabric.client.gametest` is set.
- Run: system property `fabric.client.gametest` (+ `fabric.client.gametest.testModResourcesPath`),
  Loom run config `clientGameTest`, task `runClientGameTest`, run dir `build/run/clientGameTest`
  (cleared by `deleteGameTestRunDir`). Loom writes `eula.txt` there only when `eula = true`
  (task `acceptGameTestEula`).
- CI variant: Loom 1.18 `net.fabricmc.loom.task.prod.ClientProductionRunTask` (properties
  `useXVFB`, `mods`, `jvmArgs`, `programArgs`, `runDir`, `javaLauncher`, `tracyCapture`); register a
  task such as `runProductionClientGameTest` yourself. Not configured yet.
- Example in this repo: `src/gametest/java/dev/minevibe/gametest/client/MineVibeClientGameTests.java`.

## 7. 26.3 facts learned in S1, S7 and the M1 review

Verified by running code (GameTests, the S7 harness, `npm run play`), not only by reading sources. Line numbers
are from the same decompiled jars as above.

### 7.1 Fake players (agents)
- **A vehicle must be saveable.** `Entity#startRiding` refuses a vehicle whose type cannot serialize
  (`!entityToRide.type.canSerialize()` on the server), so a seat entity type must not use
  `EntityType.Builder.noSave()`. "Never saved" is `Entity#shouldBeSaved() == false` instead.
- **A fresh player is invulnerable for 60 ticks.** `ServerPlayer#isInvulnerableTo` :1319 is true while
  `!connection.hasClientLoaded()` (`ServerGamePacketListenerImpl#hasClientLoaded` :2261: `clientLoadedTimeoutTimer`,
  60 ticks, or a `ServerboundPlayerLoadedPacket`). Not even `/kill`'s `genericKill` damage gets through. A fake player
  calls `connection.handleAcceptPlayerLoad(new ServerboundPlayerLoadedPacket())` after `placeNewPlayer`; an E2E
  "kill the player" must wait for (or check) `hasClientLoaded()`.
- **Players are client-authoritative.** `Player#isClientAuthoritative()` is true, so the server skips fall damage and
  the `onGround` update for them. Server-simulated bodies override it to `false` (as `GameTestHelper`'s mock players do).
- **Fake connections never tick.** `ServerGamePacketListenerImpl#tick()` (idle kick, the vanilla `doTick` call) runs
  only for connections in `ServerConnectionListener`; a fake player calls `ServerPlayer#doTick()` itself.
- **Chunk sending stalls without acks.** `PlayerChunkSender` sends one 9-chunk batch, then waits for a chunk-batch ack
  that never comes. Skipping `PlayerChunkSender#sendNextChunks` for fake players builds no chunk packets at all; player
  tickets and chunk loading are unaffected.
- **Dimension changes wait for the client.** `ServerPlayer#teleport(TeleportTransition)` :1123 sets
  `isChangingDimension = true`; only `handleAcceptTeleportPacket` :544 clears it (`hasChangedDimension()`). While it is
  set the player is invulnerable (`isInvulnerableTo`) and `processPortalCooldown()` is skipped (no portal works again).
  A fake player clears it after `super.teleport(...)` (Carpet's `EntityPlayerMPFake#teleport`).
- **The End exit portal does not teleport the first time.** `EndPortalBlock#entityInside` calls
  `ServerPlayer#showEndCredits()` :1114 while `!seenCredits`: the player is removed from the level
  (`removePlayerImmediately`), `wonGame` is set, and only the client's `PERFORM_RESPAWN` brings it back through
  `PlayerList#respawn` :387, which constructs a **new plain `ServerPlayer`** (`new ServerPlayer(...)` :392). A fake
  player overrides `showEndCredits()` to set `seenCredits` and stay; the portal then teleports it the normal way
  (`getPortalDestination` -> `findRespawnPositionAndUseSpawnBlock`).
- **Phantoms count every player.** `PhantomSpawner#tick` iterates `level.players()` and spawns when
  `TIME_SINCE_REST` ≥ 72000 (3 days); `ServerPlayer#doTick` awards `TIME_SINCE_REST` every tick out of bed (:672).
  Reset it with `resetStat(Stats.CUSTOM.get(Stats.TIME_SINCE_REST))` for bodies that never sleep.
- **Advancement announcements** are broadcast from the lambda `award` passes to `display().ifPresent(...)`:
  `PlayerAdvancements#lambda$award$0` -> `PlayerList#broadcastSystemMessage(Component, boolean)`. A mixin must target
  `lambda$award$0`, not `award` (0 targets found otherwise).
- **usercache.json** is filled in `PlayerList#placeNewPlayer` :152 (`server.services().nameToIdCache().add(NameAndId)`,
  interface `UserNameToIdResolver`). `CachedUserNameToIdResolver#get(UUID)` is a pure lookup; `get(String)` may create
  an offline entry.
- `LivingEntity#swing(hand)` is now `swing(hand, SwingAnimation, sendToSwingingEntity)`; entity type constants live in
  `EntityTypes`; `PushReaction.BLOCK` is `IMMOVEABLE`; `ValueInput#read(MapCodec)` is deprecated but still used by
  vanilla for `ServerPlayer.SavedPosition`.
- A grave must not use `!level.getFluidState(pos).isEmpty()` as "free": waterlogged stairs, slabs and fences hold a
  fluid too. Use `BlockState#canBeReplaced()` (air, plants, fire and fluids are replaceable) or `LiquidBlock`.

### 7.2 Client, screens and threads
- **`Gui#setScreen` mixins must rewrite the argument at method entry** (`@ModifyVariable(at = @At("HEAD"),
  argsOnly = true)`), plus `@At("STORE")` for the screens `setScreen(null)` makes up. At the `PUTFIELD` the original
  screen is already on the stack: the field keeps it while `init()` runs on the replacement (S7 finding 1).
- **Pausing** is decided only in `Gui#isPausing()` :304 (`screen.isPauseScreen() || overlay.isPausing()`), read by
  `Minecraft#runTick` :1283. `Screen#isPauseScreen()` defaults to true; vanilla `OptionsScreen` and its sub-screens are
  pause screens. Wrap the `isPauseScreen()` call in `Gui#isPausing` to change it for subclasses too.
- **`Minecraft#disconnect(...)` :2219 calls `dropAllTasks()`**: everything queued with `Minecraft#execute` before a
  disconnect is silently discarded. Work that must survive leaving a world needs its own queue.
- **World loads block the client thread.** `Minecraft#doWorldLoad` :2114 loops (`renderFrame` + `runAllTasks`) until
  the integrated server is ready; no client tick runs meanwhile. `WorldOpenFlows#createFreshLevel` on a datapack
  failure calls `gui.setScreen(parentScreen)` without starting a server, and `createWorldAccess` failure calls
  `gui.setScreen(null)`.
- **`MinecraftServer#execute` runs the task inline once the server is stopped**: `BlockableEventLoop#execute` :98
  runs `doRunTask` directly when `scheduleExecutables()` is false, and `MinecraftServer#scheduleExecutables` :1460 is
  `super.scheduleExecutables() && !isStopped()`. `doRunTask` also catches and logs task exceptions, so a task cannot
  signal "not run" by throwing.
- **Shutdown hook:** the client `Main` registers "Client Shutdown Thread" (`Main` :244), which calls
  `IntegratedServer#halt(true)`: SIGTERM or SIGINT to the JVM saves the world (players, regions, `level.dat`). Log4j
  is already shut down by then, so the save is not in `latest.log`; check file times.
- `java.net.http.WebSocket#sendText` with malformed UTF-16: JDK 25 completes the send with
  `IOException("Malformed text message")` caused by a `CharacterCodingException` (the API documents
  `IllegalArgumentException`). It encodes up to `jdk.httpclient.websocket.intermediateBufferSize` (16 KiB) before
  writing, so a shorter frame leaves nothing on the wire. A client may not send close code 1009 (S7 finding 5).

### 7.3 Worlds and GameTests
- `levelExists` lives on `LevelStorageSource` (:363), not `WorldOpenFlows` (see 2.1).
- `LevelSettings.DifficultySettings(Difficulty difficulty, boolean hardcore, boolean locked)` (see 2.2); MineVibe
  worlds use `(HARD, true, true)`.
- **GameTest structures** (`data/<ns>/gametest/structure/<name>.snbt`) write block states as `id{prop:value}`, not
  `id[prop=value]`.
- `GameTestHelper#onEachTick` uses `setRunAtTickTime` (one action per tick, overwrites `runAfterDelay`); per-tick
  probes use `startSequence().thenExecuteFor(...)`. The GameTest server ticks unthrottled.
- The GameTest world is `WorldPresets.FLAT_ALL_DIMENSIONS` (`GameTestServer` :122): flat Nether (bedrock + 3 basalt)
  and End (bedrock + 3 end stone) exist, surface at `getMinY() + 4`. Default game rules apply, including natural
  monster spawning around every player (fake players too); MineVibe's GameTest mod turns `spawn_monsters` off.
- GameRules in 26.3: `level.getGameRules().get(GameRules.X)` and `set(GameRules.X, value, server)`; rule ids are
  snake_case (`spawn_monsters`, `spawn_mobs`, `advance_time`).

### 7.4 PC monitors and input (S4, track T2)
Verified by reading the sources and by `spikes/s4-monitor` (a real client with Sodium 0.9.2 and Entity Culling 1.11.2).
- **Monitor textures.** `RenderTypes.text(id)` binds the texture's own sampler (`RenderSetup` :104: no override, so
  `AbstractTexture#getSampler()`), so an `AbstractTexture` subclass that sets `sampler =
  RenderSystem.getSamplerCache().getClampToEdge(FilterMode.LINEAR)` is sampled clamped and linear. The `TEXT` pipeline
  blends translucent and culls back faces: monitor quads must be counter-clockwise for the viewer.
- **Uploads.** `CommandEncoder#writeToTexture(GpuTexture, ByteBuffer, mip, layer, x, y, w, h)`: the GL backend sets
  `UNPACK_ROW_LENGTH = w` (`GlCommandEncoder` :307), so the source must be tightly packed `w x h`; a band of full-width
  rows can be uploaded straight out of a full frame without repacking. The texture needs `USAGE_COPY_DST` (1) and
  `USAGE_TEXTURE_BINDING` (4); create it with `GpuDevice#createTexture(label, usage, GpuFormat.RGBA8_UNORM, w, h, 1, 1)`.
- **Block entity culling.** `LevelExtractor#extractVisibleBlockEntities` takes every block entity of the visible
  sections (no per-block-entity frustum test) plus `ClientLevel#getGloballyRenderedBlockEntities()` for renderers
  with `shouldRenderOffScreen()`. A monitor whose block entity lives in the monitor block (the picture reaches 12 px into
  the side column) rendered correctly under Sodium + Entity Culling.
- **GUI.** `GuiGraphicsExtractor#blit(GpuTextureView, GpuSampler, x0, y0, x1, y1, u0, u1, v0, v1)` draws any texture
  with its own sampler. `Screen#extractBackground` is called before `extractRenderState` (override it for no blur).
- **Frames.** `Minecraft#runTick` runs `GameRenderer#extract` (level, then GUI) before `GameRenderer#render`, so
  `LevelRenderEvents.END_MAIN` comes after both extractions of the same frame. `Minecraft#getFrameTimeNs()` is set
  once per frame, after `render` (it is the previous frame's *duration*, `Util.getNanos() - renderStartTimer`), so it is
  stable within one frame's extraction: a cheap "once per frame" token. Two frames of exactly the same duration share a
  token, which only skips one upload (the dirty rows wait for the next frame).
- **SDL input.** `SDLEventHandler#pollEvents` turns `SDL_EVENT_KEY_DOWN/UP` (768/769) into
  `KeyEvent(scancode, keycode, mod)` with action `-1` for repeats, and copies `SDL_EVENT_TEXT_INPUT` (771) text at poll
  time (`textString()`) into `KeyboardHandler#textInput`, one `charTyped` per code point. `CharacterEvent` carries no
  modifiers: read `SDLKeyboard.SDL_GetModState()`. `SDLEvents.SDL_PushEvent` injects synthetic events (window id from
  `SDLVideo.SDL_GetWindowID(window.handle())`); the text pointer only has to live until the next poll. Logged real
  key events: Esc `41/27`, Tab `43/9`, Return `40/13`, LShift `225/0x400000E1` (mod `0x1`), LCtrl `224/0x400000E0`
  (mod `0x40`).
- **Keys a screen never sees.** `Minecraft#handleGlobalKeyPress` handles fullscreen (F11) and screenshot (F2) before
  `Screen#keyPressed`; the friends key only fires when `!screen.isInputCaptured()`.
- **Cursor.** `SDLMouse.SDL_HideCursor()` / `SDL_ShowCursor()`; `GuiGraphicsExtractor#requestCursor(CursorType)` only
  picks shapes.
- **Smaller API facts.** `PoseStack#rotateDegrees(Axis, float)` (there is no `mulPose(Quaternionf)`, only
  `mulPose(Matrix4fc|Transformation)`); `ServerPlayer#drop(ItemStack, boolean, Prediction)`; `Vec3i` has no
  `getCenter()` (use `Vec3.atCenterOf`); `Item.Properties#component(type, value)`; a custom data component is
  `DataComponentType.<T>builder().persistent(codec).networkSynchronized(streamCodec).build()` registered in
  `BuiltInRegistries.DATA_COMPONENT_TYPE`; `BlockEntity#preRemoveSideEffects(pos, state)` runs on the server only when
  the block really changes (not for a state change of the same block, not with flag 256).
- **Performance mods in `runClient`.** Jars in `<runDir>/mods` load next to the dev classpath (26.3 is unobfuscated,
  nothing is remapped); Entity Culling logs a harmless "Reference map ... could not be read".

## 8. Not found / open
- `Minecraft#setScreen` - NOT FOUND (use `Gui#setScreen`).
- `getRenderBoundingBox` - NOT FOUND in vanilla or Fabric API (see correction 2).
- `WorldOpenFlows#levelExists` - NOT FOUND (it is `LevelStorageSource#levelExists`).
- `Level#getDayTime` / `LightTexture` - NOT FOUND (replaced by clocks / `LightCoordsUtil`).
- Not verified here (needs a running client, S4/S7): whether `RenderTypes.text` samples with the
  texture's own `GpuSampler` (linear vs nearest), Entity Culling behaviour for globally rendered BEs,
  and whether `ALLOW_CHAT` interception plus `modifyCustomCompletions` give `@name` Tab completion in
  plain chat.
- S4 answered the sampler question (7.4: the texture's own sampler). Entity Culling with globally rendered block
  entities is still untested (the monitor does not need `shouldRenderOffScreen`).
