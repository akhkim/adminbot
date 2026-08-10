# AdminBot docs

The upstream OpenClaw documentation site is not mirrored here; these are the pages that describe
AdminBot itself. Start with the repo [README](../README.md) for the architecture and layout, and
[AGENTS.md](../AGENTS.md) for the working rules.

## Orientation

| Page                                         | What it covers                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)           | The directory map, the hexagonal reading, the request lifecycle, and the "I want to…" table |
| [adr/](adr/)                                 | Architecture decision records — why the tree is shaped the way it is                        |
| [refactor-baseline.md](refactor-baseline.md) | The authoritative known-red numbers every gate lane is compared against                     |

## Tools

| Page                                                                   | What it covers                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [tools/adminbot.md](tools/adminbot.md)                                 | The service endpoint contract, the 33 action types, and the privacy gate |
| [tools/adminbot-deadlines.md](tools/adminbot-deadlines.md)             | The venue/CFP dataset, the countdown board, and the reminder ladder      |
| [tools/adminbot-openreview.md](tools/adminbot-openreview.md)           | Reviewing-cycle reminders and emergency-reviewer suggestion              |
| [tools/adminbot-reference-check.md](tools/adminbot-reference-check.md) | Citation verification for papers                                         |

## Deploying

| Page                                                                     | What it covers                         |
| ------------------------------------------------------------------------ | -------------------------------------- |
| [deploy/aurora-adminbot.md](deploy/aurora-adminbot.md)                   | Running the service on the Aurora host |
| [deploy/aurora-runtime-bootstrap.md](deploy/aurora-runtime-bootstrap.md) | Preparing a fresh Aurora account       |
| [deploy/aurora-node-install.md](deploy/aurora-node-install.md)           | Installing Node without root           |
| [deploy/aurora-qwen35-vllm.md](deploy/aurora-qwen35-vllm.md)             | Serving Qwen3.5 through vLLM           |

The deploy runbook itself — what to run, in what order, and what each step touches — is
[AURORA-PUSH.md](../AURORA-PUSH.md).
