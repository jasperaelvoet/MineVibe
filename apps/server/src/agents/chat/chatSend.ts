import type { ChatSendResult, MessageOf } from '@minevibe/protocol';
import { BridgeError } from '../../bridge/BridgeServer.js';
import type { ChatContext, ChatRouter, RouteOk } from './ChatRouter.js';

/**
 * The `chat.send` request handler: routes the line and either returns the `ok` payload (`{echo}`) or throws
 * a {@link BridgeError} whose code is the `CHAT_*` wire code and whose message is the inline hint, so the mod
 * keeps the text in the chat box. `deliver` receives the routing result (deliveries, card answer, command).
 */
export function createChatSendHandler(
  router: ChatRouter,
  context: () => ChatContext,
  deliver: (route: RouteOk, message: MessageOf<'chat.send'>) => void,
): (message: MessageOf<'chat.send'>) => ChatSendResult {
  return (message) => {
    const result = router.route({ to: message.to, text: message.text }, context());
    if (!result.ok) throw new BridgeError(result.error.wireCode, result.error.hint);
    deliver(result, message);
    return { echo: result.echo };
  };
}
