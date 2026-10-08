/*
 * Adapted from fabric-carpet (https://github.com/gnembon/fabric-carpet),
 * carpet.patches.FakeClientConnection. Copyright (c) gnembon and contributors. MIT License.
 * Modified for MineVibe (Minecraft 26.3): trimmed, and every outbound send is a no-op.
 */
package dev.minevibe.agent;

import io.netty.channel.ChannelFutureListener;
import io.netty.channel.embedded.EmbeddedChannel;
import net.minecraft.network.Connection;
import net.minecraft.network.PacketListener;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;
import org.jspecify.annotations.Nullable;

/**
 * The "network connection" of an {@link AgentPlayer}. It is backed by an {@link EmbeddedChannel} so
 * {@link #isConnected()} is true (vanilla code checks it, e.g. ender pearls), but nothing is ever
 * written: every packet the server sends to an agent is dropped here.
 */
public final class AgentConnection extends Connection {
	public AgentConnection() {
		super(PacketFlow.SERVERBOUND);
		// Registers this connection as the channel's handler; channelActive() stores the channel.
		new EmbeddedChannel(this);
	}

	@Override
	public void send(final Packet<?> packet, final @Nullable ChannelFutureListener listener, final boolean flush) {
		// Agents have no client. Dropping packets here also avoids filling the embedded outbound queue.
	}

	@Override
	public void flushChannel() {
	}

	@Override
	public void setReadOnly() {
	}

	@Override
	public void setListenerForServerboundHandshake(final PacketListener packetListener) {
	}
}
