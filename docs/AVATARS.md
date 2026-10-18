# Avatars — make the creature your own

The creature can wear any look. An avatar is a small folder — a `manifest.json` plus a few
pictures, or one SVG — packed into a `.claudepet` file. **Drag the file onto the creature** to
install it; **right-click → Avatar** to switch. Everything else keeps working whatever it looks
like: the states, breathing, storms, subagents walking around, the chat, clicks.

Examples ship in [`avatars/`](../avatars): `ghost` and `alien` (pictures), `mint` (SVG, a
commented template) and `cowboy` (SVG, with a hat that moves with the mood).

## Two ways to make one

| | **Pictures** (`"kind": "images"`) | **SVG** (`"kind": "svg"`) |
|---|---|---|
| For | anyone: draw in any tool, or generate with an image AI | people at ease with SVG |
| Files | one picture per state: PNG, GIF, WebP, JPEG or SVG | one `creature.svg` (+ an optional `skin.css`) |
| Minimum | `IDLE` only | the contract below |
| Motion | the pet adds breathing, shaking, walking; GIF/WebP may animate themselves | same |
| Own motion | an optional `skin.css` + the `animations` section below | same, plus any scoped CSS rule |

## The common box

Draw in a **160 × 160** square, transparent background, **feet at about (80, 146)**, head below
y ≈ 30. Keep that and you declare nothing; otherwise, say where things are:

```json
"anchors": { "feet": [80, 146], "why": [66, 26] },
"hitbox": { "cx": 80, "cy": 92, "rx": 48, "ry": 52 }
```

`feet` is what subagents scale around when they walk; `why` is where the "why" bubble's tail
points; `hitbox` (pictures only) is the ellipse that takes clicks — the rest of the window lets
them through.

## States

`IDLE`, `THINKING`, `READING`, `CODING`, `TOOL_CALL`, `HIGH_LOAD` (storm), `WAITING` (on you),
`DONE`, `ERROR` — plus `ACTIVE`, a picture-only catch-all. A missing state falls back:

```
THINKING, READING, CODING, TOOL_CALL, HIGH_LOAD, ERROR, WAITING  →  ACTIVE  →  IDLE
DONE                                                           →  IDLE
```

So `IDLE` alone works, `IDLE` + `ACTIVE` already reads well, and each extra state is a bonus.
"No signal" (the daemon is not running) shows your `IDLE` picture, greyed.

## `manifest.json`

```json
{
  "format": 1,
  "id": "ghost",
  "name": "Ghost",
  "author": "you",
  "version": "1.0.0",
  "kind": "images",
  "states": { "IDLE": "idle.png", "ACTIVE": "active.png", "THINKING": "thinking.gif", "ERROR": "error.png" }
}
```

Optional: `"names": {"fr": "Fantôme", "en": "Ghost"}` names the avatar per language in the
menu and the settings panel (`name` is the fallback).

For `"kind": "svg"`: `"svg": "creature.svg"` and optionally `"css": "skin.css"` instead of `states`.
`id`: lowercase letters, digits and dashes, unique (`classic` is taken). Installing an avatar
whose id already exists replaces it and keeps the previous one as `<id>.bak`.

## The SVG contract

Start from [`avatars/mint/creature.svg`](../avatars/mint/creature.svg). The widget needs:

- one `<g class="critter">` in the 160 × 160 box;
- inside it `<g class="shaker">` (shakes in a storm) › `<g class="body">` (breathes), and **exactly
  one** element with class `shell` — the body outline, used for clicks;
- per-state layers: `class="opt on-THINKING"` is shown only in `THINKING`, and so on for every
  state, plus `on-NOSIGNAL`;
- optional shared paint classes: `skin`, `skin-line`, `ink`, `ink-line`, `glint`, `cheek`, `bulb`,
  coloured by CSS variables (`--skin-base`, `--skin-hot`, `--skin-bad`, `--c-think`, …) that your
  `skin.css` may set on `.critter`.

`skin.css` applies to your avatar only: a selector starting with `.critter` is the creature
itself, anything else is inside it, and `@keyframes` names are made private. Plain rules and
`@keyframes` only.

## Motion: the `animations` section

Both kinds (pictures too) may ship a `skin.css` with `@keyframes`, and bind them to states in
the manifest — no widget code involved:

```json
"css": "skin.css",
"animations": {
  "states": {
    "THINKING": { "keyframes": "bob", "dur": 2600, "ease": "ease-in-out", "amp": 1.2 },
    "CODING":   { "keyframes": "wiggle", "dur": "auto" },
    "IDLE":     { "keyframes": null },
    "DONE":     { "enter": { "keyframes": "tip", "dur": 900, "count": 2 } },
    "ERROR":    { "fallback": "HIGH_LOAD" }
  }
}
```

- **`keyframes`** — a name from your `skin.css`, or a built-in: `breathe`, `shake`, `nod`,
  `tap`, `hammer`, `float`, `cheer`, `hop`, `flinch`, `step-l`, `step-r`. It replaces the
  default loop for that state; `null` means *no loop* (the pose itself). The widget's defaults
  stay wherever you say nothing.
- **`target`** — what moves: `body` (the default; breathes today), `shaker` (shakes in storms),
  `eyes`, or `root` (the whole creature — enters default to it).
- **`dur`** — whole milliseconds (80–10000), or `"auto"`: the widget's load-driven speed.
- **`ease`** — `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, or four cubic-bezier
  numbers.
- **`amp`** — 0–3, scales the built-in keyframes' amplitude (they read
  `var(--amp) * var(--amp-k)`); you never see raw load.
- **`enter`** — a one-shot played on arriving in the state (plus `count`, 1–10), before the
  loop takes over. Good for anticipation: a squash before the storm, a hop on DONE.
- **`fallback`** — reuse another state's entry.

Keep motion on `transform` and `opacity` — they stay on the compositor. Avoid animating
paint (`fill`, `stroke`, filters) in a loop, and leave `IDLE` without one: every animation is
**paused automatically** whenever the creature is asleep, paused or disconnected, and an IDLE
loop would only be frozen mid-pose. Unknown names, states or out-of-range values are refused
at import; anything that still slips through is dropped at load and the default motion plays
instead — an avatar without an `animations` section behaves exactly as before.

## Limits and safety

An avatar is someone else's file, and the creature's window can talk to Claude. So:

- at most 40 files, 2 MB each, 10 MB in all; file types are checked by their **content**, not
  their name; files sit at the top of the archive, nothing else is extracted;
- SVG goes through an **allow-list**: shapes, text, gradients, masks, `<use>`/`<image>` pointing to
  `#id` or a `data:` picture. Scripts, `on…` attributes, `<foreignObject>`, `<style>`, links,
  SMIL animation and `style=` attributes are removed;
- CSS: no `@import`, `@font-face`, `@media`, escapes, or `url()` to anything but `#id`;
- the window's Content-Security-Policy blocks any request outside the pet itself.

An avatar can therefore change how the creature looks — never what it does.

## Tooling

```bash
npm run avatar -- validate avatars/my-avatar     # same rules as the import
npm run avatar -- pack avatars/my-avatar         # → my-avatar.claudepet
npm run test:avatar-sanitizer                    # poisoned SVGs through the sanitizer (headless Chrome)
```

Preview without installing, in the browser harness (any state, with subagents, unplugged):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --allow-file-access-from-files \
  "file://$PWD/apps/widget/web/index.html#demo=avatar&avatar=my-avatar&state=THINKING&kids=2"
```

## Tips

- **Keep `IDLE` still.** An animated idle picture keeps the CPU busy while the creature sleeps
  (`validate` warns). Animate the active states instead.
- Transparent background, generous margins: the creature breathes and shakes a few pixels.
- Make `WAITING` and `ERROR` distinct — they are the ones that need you.
- Generating with an image AI: *"A cute mascot character, full body, centered, feet at the
  bottom, transparent background, flat vector style, consistent design across a set of poses:
  sleeping (eyes closed), awake and attentive, thinking (eyes up, thought bubble), alarmed (red,
  exclamation mark). Same character, same size and position in every image."*
