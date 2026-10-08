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

loom {
	splitEnvironmentSourceSets()

	mods {
		register("minevibe") {
			sourceSet(sourceSets.main.get())
			sourceSet(sourceSets.getByName("client"))
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
}

tasks.jar {
	val projectName = project.name
	inputs.property("projectName", projectName)

	from(rootProject.layout.projectDirectory.file("../../LICENSE")) {
		rename { "${it}_$projectName" }
	}
}
