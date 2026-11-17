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
- Fully self-contained: the 3D dice, table scene, and fonts live inside the
  page, no external requests; 3D loads lazily and falls back to dice chips
  when WebGL can't run
- Game saves in the browser — close it and Resume picks up the exact turn
- Game log, end-of-game category breakdown, per-player colours, upper-bonus
  progress, sound volume control and haptics
- Guided first turn that teaches by doing; How to Play stays as a reference
- Accessibility presets: Big Text, Reduced Motion, High Contrast, one tap each
- Full keyboard play: R rolls, arrows move across dice and score boxes,
  Enter scores, ? lists every shortcut
- Tap the dice cup to roll; drag dice with a spring settle; long-press a
  score box to preview totals and the bonus before committing
- Toasts with Undo, glanceable standings (ahead/behind by N), a bento
  end-of-game with a hero winner tile
- On phones, Sound, Volume and Vibrate live in one Settings sheet
- Scorecard that stays out of the way: scored rows collapse into a compact
  summary, and the drawer opens on a standings overview (totals, bonus
  status, rounds left, leader) with the full grid one tap away
- Dark mode that follows the system, with an in-app switch; text scales to
  200% with Big Text; every player has a shape as well as a colour
  (circle, square, triangle, diamond) so the game reads without colour
- Game history keeps the last 10 finished games on the device, with a
  visible Saved indicator; a practice table for free rolls that saves
  nothing
- Tap a scored row to see its breakdown with the real dice math; at game
  end, a score-over-rounds chart shows how the lead changed, and each
  bento tile opens into its player's full breakdown
- The first time a Yahtzee bonus is available, a coach mark points at the
  row and explains the bonus and the joker rule; the game log has a
  Comfortable/Compact density switch and bots narrate their holds as they
  make them
- The dice are the high-quality Reblend v5 model: flush inlaid red bands
  with a different swirl on each edge, flat white pips, taller dome, true
  colors, clean bands with no speck marks, and a subtle textured sheen
  on the black body. The table is a real Reblend scene: green felt,
  wood rim, and a dice cup you can tap to roll
- The camera frames the full dice row and cup on phone screens, and the
  felt renders at its true dark casino green

## Status

Pass-and-play plus bots. Online rooms are the next big piece.
