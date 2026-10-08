# Basic quality checks

AiBinator follows the static checks of [DevL0rd/Konveyor](https://github.com/DevL0rd/Konveyor/tree/18d0e1fec067bffe9c484689fa5e2a4111fdd884), translated to TypeScript, in [quality.yml](../.github/workflows/quality.yml).

`npm run quality` runs, in order:

| Check | Script | Rule |
| :-- | :-- | :-- |
| File length | `check:length` | At most 400 lines per tracked or untracked, not ignored `.ts` and `.js` file |
| ESLint | `lint` | Cyclomatic complexity ≤ 10, max depth 4, max statements 35 everywhere; in `src`, cognitive complexity ≤ 15, functions ≤ 60 lines and ≤ 6 parameters; in `scripts`, functions ≤ 90 non-blank lines |
| Spelling | `check:spelling` | typos, excluding `dist/` and SVG files |
| Duplication | `check:duplicates` | jscpd over `src`, `scripts` and `eslint.config.js`: 0 clones of 60 tokens and 6 lines or more |
| Formatting | `check:format` | Prettier, 140 columns, four-space indent |
| Unused and dead code | `check:unused` | Knip |
| Types | `check` | TypeScript (`tsc --noEmit`) |

Run the same checks locally:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:spelling
npm run quality
```

Tests run with `npm run coverage`, the offline suite under c8, which fails below 88% of lines, statements and functions or 80% of branches. See [Validation](validation.md) for what the suite covers and its current state.

Development tools are pinned to exact versions: typos 1.50.3, jscpd 5.4.0, ESLint JS configuration 10.0.1, SonarJS 4.2.2, Prettier 3.9.9, Knip 6.39.0 and c8 12.0.0. The spelling wrapper alone gets a scoped rebuild (`npm run setup:spelling`) after the general install disables install scripts; it downloads the fixed typos 1.50.3 binary, which is outside npm's lockfile integrity checks. There are no duplication baselines, raised limits or inline lint suppressions.

CI runs on pushes to `main`, pull requests and manual runs, with read-only repository permission and cancellation of superseded runs, on Node 24 with pinned checkout and setup-node revisions.
