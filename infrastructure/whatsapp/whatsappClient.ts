let activeSock: any = null;

export function getActiveSocket(): any {
  return activeSock;
}

export function setActiveSocket(sock: any): void {
  activeSock = sock;
}

export async function cleanupBotInstance(): Promise<void> {
  if (activeSock) {
    console.log("Cleaning up previous WhatsApp socket instance and detaching listeners...");
    try {
      activeSock.ev.removeAllListeners("connection.update");
      activeSock.ev.removeAllListeners("creds.update");
      activeSock.ev.removeAllListeners("contacts.upsert");
      activeSock.ev.removeAllListeners("group-participants.update");
      activeSock.ev.removeAllListeners("messages.upsert");
      activeSock.ev.removeAllListeners("lid-mapping.update" as any);
      
      activeSock.ws?.close();
    } catch (e) {
      console.warn("Error cleaning up active socket:", e);
    }
    activeSock = null;
  }
}
