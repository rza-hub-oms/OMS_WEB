// Centralized WebSocket transport for OMS. UI code should use send() rather
// than reaching into the WebSocket directly; this makes reconnect/diagnostics
// possible without changing every feature module.
export const ws = new WebSocket(`ws://${location.host}/ws`);

export function send(payload) {
  const message = JSON.stringify(payload);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
    return true;
  }
  console.warn("OMS WebSocket is not open; command was not sent", payload);
  return false;
}

export function setMessageHandler(handler) {
  ws.onmessage = handler;
}
