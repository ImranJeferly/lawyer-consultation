// Temporary stubs for missing WebSocket methods
import webSocketManager from './websocketManager.service';

// Add missing methods to the websocket manager instance
(webSocketManager as any).sendMessage = async function(conversationId: string, message: any): Promise<void> {
  // Stub implementation - replace with actual WebSocket logic
  console.log(`Sending message to conversation ${conversationId}:`, message);
};

(webSocketManager as any).isConnected = function(userId: string): boolean {
  // Use the existing method name
  return this.isUserConnected(userId);
};