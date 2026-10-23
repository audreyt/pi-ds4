# pi-kami guide: design contract

The guide at `index.html` is a letter set on pi.dev's graph paper. This file names the tokens and layout rules the page uses, so later edits stay consistent.

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#ebe7e4` (pi.dev moonstone) | `#161d27` (pi.dev navy canvas) | page ground |
| `--panel` | `#f4f2f0` | `#1b232e` | contents rail |
| `--ink` | `#252f3d` (evening blue) | `#ebe7e4` | body text, headings |
| `--ink-2` / `--ink-3` | copy / muted | copy / muted | secondary text, labels |
| `--rule` / `--rule-2` | hairlines | hairlines | dividers, note edges |
| `--accent` | `#4b607c` (tidal blue) | `#6a9fcc` | reading thread, focus ring, glossed-term underline, active rail number |
| `--seal` | `#8f3222` (rust) | `#e8704f` | copy confirmations only |
| `--term` | `#142433` | `#0d1116` | terminal blocks |
| `--grid-minor` / `--grid-major` | 4 px / 20 px lines | same, fainter | body background grid |

## Type

- Reading: Source Serif 4. zh-TW: Iansui; display lines in Kaiti.
- Code and rail links: IBM Plex Mono.
- Labels (chrome, chapter numbers, rail and note headings): Departure Mono, uppercase, 0.12-0.16 em tracking. It is self-hosted under `fonts/`, licensed under SIL OFL 1.1.

## Layout

- One reading column, `--column: 46rem`, centred. Mobile and tablet keep exactly this column.
- At 80rem (1280 px) and wider, two more pieces appear once the reader is past the hero:
  - a contents rail fixed to the left of the column: a panel listing the chapters, with the current chapter and section lit (`aria-current`) and the chapter's sections expanded;
  - margin notes to the right of the column: each glossed term gets its glossary definition beside it, top-aligned with the term and stacked so notes never overlap.
- Glossed terms are ordinary links to `#gl-…` entries in the glossary, so narrow screens and no-JS readers still reach the definition. The first use of each term in each section is glossed, in each language.
- State is shown by ink and wash, not by coloured borders. The one exception is a hovered note, whose hairline takes the accent.

## Motion

- The hero sea and the settle-in headline are the only ambient motion. The rail fades in past the hero. All of it respects `prefers-reduced-motion`.
