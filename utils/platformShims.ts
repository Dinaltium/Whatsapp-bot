/**
 * Guards for running on Android: Termux, with Debian under proot-distro.
 *
 * Android 11+ refuses the netlink call behind os.networkInterfaces(), so under
 * proot it throws "uv_interface_addresses returned Unknown system error 13"
 * instead of returning a list. Nothing in this bot needs the interface list,
 * but a dependency that asks for it (gcp-metadata's GCE check, via
 * google-auth-library) would take the whole process down. Returning an empty
 * list is what those callers already handle as "no interfaces found".
 *
 * A no-op everywhere the real call works, including Render and Docker.
 */
import os from "os";

export function installPlatformShims(): void {
  const original = os.networkInterfaces;
  try {
    original();
    return;
  } catch {
    /* fall through: this platform needs the guard */
  }
  (os as any).networkInterfaces = () => {
    try {
      return original();
    } catch {
      return {};
    }
  };
  console.log("[platform] os.networkInterfaces() unavailable (Android/proot); using an empty list.");
}
