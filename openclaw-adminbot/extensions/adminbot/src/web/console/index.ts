/**
 * The AdminBot admin console: one self-contained HTML document served by the loopback service at
 * /adminbot.
 *
 * It is assembled rather than bundled because it has no build step of its own - the service returns
 * a single string. The three parts are split so each can be read on its own: the stylesheet, the
 * body markup (auth gate, shell, one section per panel), and the browser script.
 */
import { adminBotConsoleScript } from "./client-script.js";
import { adminBotConsoleMarkup } from "./markup.js";
import { adminBotConsoleStyles } from "./styles.js";

export function renderAdminBotWebUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AdminBot Console</title>
  <style>
${adminBotConsoleStyles}  </style>
</head>
${adminBotConsoleMarkup()}  <script>
${adminBotConsoleScript()}  </script>
</body>
</html>`;
}
