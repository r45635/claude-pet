# Avatars — make the creature your own

The creature can wear any look. An avatar is a small folder — a `manifest.json` plus a few
pictures, or one SVG — packed into a `.claudepet` file. **Drag the file onto the creature** to
install it; **right-click → Avatar** to switch. Everything else keeps working whatever it looks
like: the states, breathing, storms, subagents walking around, the chat, clicks.

Two examples ship in [`avatars/`](../avatars): `ghost` (pictures) and `mint` (SVG, a commented
template).

## Two ways to make one

| | **Pictures** (`"kind": "images"`) | **SVG** (`"kind": "svg"`) |
|---|---|---|
| For | anyone: draw in any tool, or generate with an image AI | people at ease with SVG |
| Files | one picture per state: PNG, GIF, WebP, JPEG or SVG | one `creature.svg` (+ an optional `skin.css`) |
| Minimum | `IDLE` only | the contract below |
| Motion | the pet adds breathing, shaking, walking; GIF/WebP may animate themselves | same, plus your own CSS animations |

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
