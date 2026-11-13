# YAHTZEE

A multiplayer PvP Yahtzee web app. Real 3D dice modeled in Reblend, full
13-round rules, 1–4 players — humans and bots — pass-and-play on one device.

## Play it

Open `yahtzee.html` in any modern browser. No install, no server, no account.

## What's in the game

- Full rules: all 13 categories, upper bonus (35 at 63), Yahtzee bonus (+100),
  joker rules including the forced upper box
- Live score previews with the best box highlighted
- 1–4 players, each Human or Bot; bots in Easy, Medium, and Hard, with
  Slow / Normal / Fast speed
- Hold dice, drag to rearrange them, one-step undo, confirm before scoring a 0
- Keyboard dice reorder (arrow keys), Escape-to-close overlays, focus trapping
- Dice-total readout with the five faces spelled out, in the player's colour
- Fully self-contained: the 3D dice and fonts live inside the page, no
  external requests; 3D loads lazily and falls back to dice chips when
  WebGL can't run
- Game saves in the browser — close it and Resume picks up the exact turn
- Game log, end-of-game category breakdown, per-player colours, upper-bonus
  progress, sound volume control and haptics
- The dice are the real Reblend model: black with red edges and white pips,
  built for the Yahtzee Classic look

## Status

Pass-and-play plus bots. Online rooms are the next big piece.
