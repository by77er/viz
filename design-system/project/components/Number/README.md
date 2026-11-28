Numbers, units, durations and ages. Two elements: `vz-num` for a cell or a value standing alone, `vz-qty` for a number with its unit inside a sentence.

**`vz-qty`** sets its content in the mono, at `qty-scale` of the sentence's size and never below `data` size (13px beside `ui`, 14px in `body`, 18.6px in a heading or the page state line), on the sentence's own line (its line-height is 1, because the mono's taller metrics otherwise open the line by 2px), never breaks, and tightens its space by `space-1`, so "12 s ago" and "222 ms" read as one word with no gap: 3.8px before the unit, against 7.8px for `vz-num` inline. It holds one quantity: digits, an optional sign or separator, and its unit. Write an ordinary space between value and unit; the element makes it a thin, non-breaking one. (Five candidates were rendered and measured: `vz-num` inline leaves a 7.8px gap and makes the line 1 to 2px taller; the sans with tabular figures stretches the full stop, comma and colon in "2.41", "1,284" and "13:07"; mono digits with a sans unit mix two faces in one quantity and grow the line; mono with a typed U+202F works but depends on every author typing that character; mono with a tightened ordinary space is the one used. See `reviews/system-v4/alternatives/inline-number.png`.) Use `<time class="vz-qty" datetime="…">` for clock times and ages, in a sentence, a heading and the page state line alike, so one event's time looks the same everywhere it is written.

**Units.**

- A space between value and unit ("222 ms", "5 min", "1,284 req/s"); none before "%" ("2.41%") or before a bare per-period unit ("7/h", "5/h").
- Durations: `ns`, `µs`, `ms`, `s`, `min`, `h`, `d`. Minutes are "min", never "m" (a metre). At most two parts, largest first: "2 h 9 min", "4 min 10 s". Durations typed into a field are accepted in any form and echoed in this one.
- Bytes: `B`, `KiB`, `MiB`, `GiB`, `TiB`, binary steps, and ticks at binary-round values (256, 512, 768 MiB).
- Rates: the unit, a slash, the period: "req/s", "MiB/s".
- Counts above 9,999 in a sentence are written with a word: "5.76 billion samples". "5.76 B" is never a count. On an axis, "k" and "M" are allowed if every tick uses the same one.
- Always abbreviate a unit that follows a number. Spell a unit out only where there is no number ("for a few minutes").
- One scale and one precision per column, axis and readout: never "357 m" beside "1.42"; never four digits in the readout and three in the legend.

**Where the unit goes.** Once. In a column of one unit: in the column head ("Last, ms"), cells are bare numbers, right-aligned. In a chart: once at the top of the value axis, and in the legend's column head; ticks are bare. In a sentence: after each number.

**Mixed units.** A column whose cells have different units (a "Now" column holding "912 ms", "4 min 10 s", "1.3%") cannot align on the decimal. It is left-aligned mono, each cell carrying its own unit. Right alignment is for columns of one unit only.

**Age of data** ("updated … ago", "evaluated … ago"):

| Age | Written | Changes |
|---|---|---|
| under 5 s | "just now" | |
| 5 to 59 s | "12 s ago" | every second |
| 1 to 59 min | "14 min ago" | every minute |
| 1 to 24 h | "3 h ago" | every hour |
| over a day | the absolute time: "17 Nov, 09:30" (with the year if it is not this year) | never |

Never "0 s ago". For a fixed past range the age is the age of the fetch, so the head also states the range. Clock times are 24-hour, "13:07"; dates are "18 Nov" or "18 Nov 2026"; never a locale-dependent form.
