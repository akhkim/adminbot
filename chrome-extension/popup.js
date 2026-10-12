const input = document.querySelector("#url");
const status = document.querySelector("#status");
const stored = await chrome.storage.local.get("portalUrl").catch(() => ({}));
input.value = stored.portalUrl || "";
document.querySelector("#workspace").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = new URL(input.value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTPS portal URL without credentials, query parameters, or a fragment. Localhost HTTP is also supported.");
    }
    await chrome.storage.local.set({ portalUrl: url.href });
    await chrome.tabs.create({ url: url.href });
    window.close();
  } catch (error) {
    status.textContent = error.message || "Could not open the workspace.";
  }
});
