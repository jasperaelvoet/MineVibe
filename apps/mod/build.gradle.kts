import java.util.Properties

plugins {
	// 26.x is unobfuscated: no `mappings` dependency, no remapping, plain `implementation` deps.
	id("net.fabricmc.fabric-loom")
}

val minecraftVersion = providers.gradleProperty("minecraft_version").get()
val loaderVersion = providers.gradleProperty("loader_version").get()
val fabricApiVersion = providers.gradleProperty("fabric_api_version").get()

/**
 * GameTests start Minecraft, which means agreeing to the Minecraft EULA (https://aka.ms/MinecraftEULA).
 * That agreement is never assumed. It comes only from `-Pminevibe.acceptMinecraftEula=true`, or from a
 * gitignored `minevibe.local.properties` next to this file containing `minevibe.acceptMinecraftEula=true`
 * (a per-checkout opt-in, so cloning the repo never accepts it for you).
 * When it is not true, `runGameTest` and `runClientGameTest` are skipped, so `./gradlew build`
 * (which runs `check`) still passes without it.
 */
val localProperties = Properties().apply {
	val f = layout.projectDirectory.file("minevibe.local.properties").asFile
	if (f.isFile) f.inputStream().use { load(it) }
}
val acceptMinecraftEula: Boolean = providers.gradleProperty("minevibe.acceptMinecraftEula")
	.orElse(localProperties.getProperty("minevibe.acceptMinecraftEula") ?: "false")
	.map { it.trim().equals("true", ignoreCase = true) }
	.get()

repositories {
	// Loom adds Mojang, Fabric and Maven Central itself. Only add repositories for mod dependencies.
}

/**
 * Launch settings for `./gradlew runClient` (PLAN §9.4, README "Running the client against Node"). Each one is a
 * Gradle property or, failing that, an environment variable; they become `-D` system properties of the game JVM:
 *
 * | Gradle property       | Environment variable   | Game JVM                 | Default                                   |
 * |-----------------------|------------------------|--------------------------|-------------------------------------------|
 * | `minevibe.bridgeFile` | `MINEVIBE_BRIDGE_FILE` | `-Dminevibe.bridgeFile`  | `<repo>/.minevibe-dev/run/bridge.json`    |
 * | `minevibe.e2e`        | `MINEVIBE_E2E`         | `-Dminevibe.e2e`         | unset (debug.* handlers off)              |
 * | `minevibe.dev`        | `MINEVIBE_DEV`         | `-Dminevibe.dev`         | `true` (new worlds allow commands)        |
 * | `minevibe.parentPid`  | `MINEVIBE_PARENT_PID`  | `-Dminevibe.parentPid`   | unset (no parent watchdog)                |
 * | `minevibe.runTag`     | `MINEVIBE_RUN_TAG`     | `-Dminevibe.runTag`      | unset (a marker for finding the process)  |
 * | `minevibe.runDir`     | `MINEVIBE_RUN_DIR`     | game directory           | `run` (relative to apps/mod)              |
 *
 * They are read when Gradle configures the build (so a change invalidates the configuration cache, as it should).
 */
fun launchSetting(property: String, env: String): String? =
	providers.gradleProperty(property).orElse(providers.environmentVariable(env)).orNull?.trim()?.takeIf { it.isNotEmpty() }

// `npm run dev`'s bridge file. `npm run play` lives in .minevibe-dev/play and passes its own file to the game it starts.
val devBridgeFile: String = layout.projectDirectory.file("../../.minevibe-dev/run/bridge.json").asFile.normalize().absolutePath

loom {
	splitEnvironmentSourceSets()

	mods {
		register("minevibe") {
			sourceSet(sourceSets.main.get())
			sourceSet(sourceSets.getByName("client"))
		}
	}

	runs {
		named("client") {
			property("minevibe.bridgeFile", launchSetting("minevibe.bridgeFile", "MINEVIBE_BRIDGE_FILE") ?: devBridgeFile)
			property("minevibe.dev", launchSetting("minevibe.dev", "MINEVIBE_DEV") ?: "true")
			launchSetting("minevibe.e2e", "MINEVIBE_E2E")?.let { property("minevibe.e2e", it) }
			launchSetting("minevibe.parentPid", "MINEVIBE_PARENT_PID")?.let { property("minevibe.parentPid", it) }
			launchSetting("minevibe.runTag", "MINEVIBE_RUN_TAG")?.let { property("minevibe.runTag", it) }
			launchSetting("minevibe.runDir", "MINEVIBE_RUN_DIR")?.let { runDir(it) }
		}
	}
}

fabricApi {
	configureTests {
		// Creates the `gametest` source set (src/gametest/...), a separate mod that depends on main + client.
		createSourceSet = true
		modId = "minevibe-gametest"
		// Server GameTests: run config `gameTest`, task `runGameTest` (Loom wires it into `check`).
		enableGameTests = true
		// Client GameTests: run config `clientGameTest`, task `runClientGameTest`.
		enableClientGameTests = true
		eula = acceptMinecraftEula
	}
}

dependencies {
	minecraft("com.mojang:minecraft:$minecraftVersion")
	implementation("net.fabricmc:fabric-loader:$loaderVersion")
	implementation("net.fabricmc.fabric-api:fabric-api:$fabricApiVersion")

	// JUnit 5 with Fabric Loader's Knot classloader, so unit tests can touch Minecraft classes.
	testImplementation("net.fabricmc:fabric-loader-junit:$loaderVersion")
	// A local WebSocket server for BridgeClient tests (fragmented 4 MB binary receive). Tests only, never shipped.
	testImplementation("org.java-websocket:Java-WebSocket:1.6.0")
}

val gameTestTasks = listOf("runGameTest", "runClientGameTest")
gameTestTasks.forEach { name ->
	tasks.named(name) {
		val accepted = acceptMinecraftEula
		onlyIf("the Minecraft EULA is accepted (-Pminevibe.acceptMinecraftEula=true)") { accepted }
	}
}

tasks.withType<ProcessResources>().configureEach {
	val modVersion = project.version.toString()
	inputs.property("version", modVersion)

	filesMatching("fabric.mod.json") {
		expand("version" to modVersion)
	}
}

java {
	// Loom attaches the sources jar to `build` when it exists.
	withSourcesJar()

	sourceCompatibility = JavaVersion.VERSION_25
	targetCompatibility = JavaVersion.VERSION_25
}

tasks.withType<JavaCompile>().configureEach {
	options.release = 25
	options.encoding = "UTF-8"
}

tasks.test {
	useJUnitPlatform()

	// Knot/log4j write logs/ relative to the working directory; keep that out of the source tree.
	val testRunDir = layout.buildDirectory.dir("junit-run")
	workingDir(testRunDir)
	doFirst {
		testRunDir.get().asFile.mkdirs()
	}

	// The protocol fixtures shared with the TypeScript tests (packages/protocol/fixtures).
	val fixtures = layout.projectDirectory.dir("../../packages/protocol/fixtures")
	inputs.dir(fixtures).withPropertyName("protocolFixtures").withPathSensitivity(PathSensitivity.RELATIVE)
	systemProperty("minevibe.protocolFixtures", fixtures.asFile.normalize().absolutePath)
}

tasks.jar {
	val projectName = project.name
	inputs.property("projectName", projectName)

	from(rootProject.layout.projectDirectory.file("../../LICENSE")) {
		rename { "${it}_$projectName" }
	}
}
