# pocket

Phone helpers for [Claude Code](https://claude.com/claude-code) running in Termux on Android, where the screen is cramped, selecting text is a chore, and you're often in another app while Claude works.

| | What it does |
|---|---|
| **Pings** | A notification with a buzz when a turn of 30 s or more finishes, showing the first line of the answer, and a double buzz when Claude waits on a permission prompt. They clear themselves once you're back at the prompt, and tapping one opens Termux. |
| `/yy [n]` | Yanks the last fenced code block from Claude's replies to the Android clipboard (`/yy 2` takes the one before it). Named for the vim habit. |
| `/consent [note]` | Finds the tool call that was most recently blocked (by the auto-mode classifier or at a permission prompt) and **drafts** a consent message naming it in your prompt box. Nothing is sent until you check it and press Enter yourself. |
| `/dash [args]` | Runs `~/.local/bin/tdash` with the given arguments. It's the author's own launcher for a tailnet dashboard and isn't included here, so point it at your own script or ignore it. |

## Requirements

- Claude Code running in [Termux](https://termux.dev)
- The **Termux:API** Android app plus `pkg install termux-api` (for `termux-notification` and `termux-clipboard-set`)

## Install

At the prompt of a terminal session:

```
/plugin install pocket --marketplace arkanine1000/claude-pocket
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install pocket --marketplace arkanine1000/claude-pocket
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `arkanine1000/claude-pocket`, then Add plugin.

## Tuning

`MIN_TURN_MS` at the top of `hooks/register.ts` sets how long a turn must run before it pings (default 30 s).

## License

MIT
