pluginManagement {
	repositories {
		maven("https://maven.fabricmc.net/") {
			name = "Fabric"
		}
		mavenCentral()
		gradlePluginPortal()
	}

	plugins {
		// Version lives in gradle.properties so it sits next to the other Fabric versions.
		id("net.fabricmc.fabric-loom") version providers.gradleProperty("loom_version").get()
	}
}

plugins {
	// Lets Gradle download JDKs. The Gradle daemon itself must run on JDK 25
	// (gradle/gradle-daemon-jvm.properties) because Loom 1.18 is Java 25 bytecode.
	id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

// Must match the mod id in src/main/resources/fabric.mod.json.
rootProject.name = "minevibe"
